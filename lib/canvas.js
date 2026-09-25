/**
 * Canvas LMS 连接器（从 Python 版 connectors/canvas.py 逐行移植的 JS 版）。
 *
 * 【要点】
 * - Bearer token 鉴权，用 Node 内置 fetch（零依赖）。
 * - 必须解析 Link header 的 rel="next" 完成分页（只拉第一页会漏数据）。
 * - 429 / 5xx / 网络异常按指数退避重试，最多 maxAttempts 次；429 优先用 Retry-After（0 也照办）。
 * - 单个课程失败（403 / 404 / 超时）只记 warning 并 continue，绝不让整轮 fetch 挂掉。
 * - 每次出站请求前都要 await bucket.acquire()，桶由本连接器独享（burst = 1）。
 * - 配置键别名：契约键（timeoutSeconds / rateLimitRps / retry.maxAttempts）优先，
 *   同时接受 timeoutMs（毫秒）/ requestsPerSecond / 顶层 maxAttempts 作为兜底，
 *   好让宿主配置层（lib/config.js 的 canvas 段）能原样透传。
 *
 * 【字段名约束】
 * canvas_assignment 的 payload 键必须与 core/hashing.py 的白名单一致
 * （name / description / due_at / points_possible / submission_types），
 * announcement 对应（title / message / posted_at）。
 * course_name 是额外附带的上下文，不参与哈希。
 * 另外三个也**不参与哈希**（只给规则/完成同步用，改它们不会引起整表重打分）：
 * omit_from_final_grade（不计入总成绩 → 降权）、grading_type、submission（提交状态）。
 *
 * 【载荷不变式（load-bearing，改动前先读）】
 * 1) due_at / posted_at / points_possible 一律原样透传：不解析、不重排、不补时区、
 *    不把 null 变成 ""；缺失（undefined）归一为 null，字符串按服务端给的原字节保留。
 * 2) 时间只用于"是否早于回溯窗口"的判断，且**不确定就保留**：
 *    due_at / posted_at 为 null、空串或无法解析（如 "not-a-date"）时一律不丢弃，
 *    以免"老师先发作业、后补截止时间"的条目被永久漏掉（本地没有基线快照可对比）。
 * 3) 逐课程隔离：每个课程的（作业 + 公告）两次请求包在同一个 try/catch 里，任一失败只记
 *    warning 并继续下一个课程；公告不会被单独重试。但 /api/v1/courses 本身的失败会向上抛出。
 * 4) 分页拿到 next 链接后不再叠加 query（next URL 自带完整查询串）。
 * 5) 限流等待走注入的 sleep，但令牌桶的时钟用 performance.now 单调时钟，
 *    绝不使用 options.now（那是给回溯窗口用的可注入时钟，冻结它会把限流器卡死）。
 */

export const SOURCE_ASSIGNMENT = 'canvas_assignment';
export const SOURCE_ANNOUNCEMENT = 'canvas_announcement';

const COURSES_PATH = '/api/v1/courses';
const ANNOUNCEMENTS_PATH = '/api/v1/announcements';
const PAGE_SIZE = 100;
/** 形如 <https://x/api/v1/courses?page=2>; rel="next"（与 Python 正则逐字一致） */
const NEXT_LINK_PATTERN = /<([^>]+)>\s*;\s*rel="?next"?/;
const DAY_MS = 86400000;
const BODY_EXCERPT_LIMIT = 200;
/** 令牌桶在"等待期间"的自旋上限，超过就交给真实计时器，防止注入的 sleep 立即返回时死循环 */
const MAX_SPIN_ITERATIONS = 100000;

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monotonicNow() {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function toNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function errorText(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

/** 大小写不敏感地读一个响应头，兼容 fetch Headers、Map 和普通对象三种 stub 形态。 */
function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = String(name).toLowerCase();
  /* Headers / Map 都有 .get：先按原名查，再退回小写（真 Headers 本身不区分大小写，但 Map 区分）。 */
  if (typeof headers.get === 'function') {
    const exact = headers.get(name);
    if (exact !== undefined && exact !== null) return exact;
    const lower = headers.get(wanted);
    return lower === undefined ? null : lower;
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) return headers[key];
    }
  }
  return null;
}

/** 把 Link header 按"尖括号外的逗号"切分，再逐段套 Python 的 rel="next" 正则。 */
function splitLinkHeader(linkHeader) {
  const segments = [];
  let current = '';
  let depth = 0;
  for (const ch of String(linkHeader)) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/** 从 Link header 中取出 rel="next" 的 URL；没有则返回 null。 */
export function nextLinkFromHeader(linkHeader) {
  if (!linkHeader) return null;
  for (const segment of splitLinkHeader(linkHeader)) {
    const match = NEXT_LINK_PATTERN.exec(segment);
    if (match) return match[1];
  }
  return null;
}

/** 读取 Retry-After（秒）；缺失或非法返回 null。0 是合法值，不能用 || 短路。 */
export function retryAfterSeconds(response) {
  const raw = headerValue(response && response.headers, 'Retry-After');
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return Math.max(n, 0);
}

/** 拼查询串：键按原样保留（context_codes[] 不能编码），值编码。 */
function encodeParams(params) {
  if (!params) return '';
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

function buildUrl(baseUrl, pathOrUrl, params) {
  const raw = String(pathOrUrl);
  let url = /^https?:\/\//i.test(raw) ? raw : `${baseUrl}${raw}`;
  const qs = encodeParams(params);
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  return url;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/**
 * 请求超时：AbortController + 一个真实计时器。三条不变式：
 * 1) 计时器**不 unref**：请求在飞的时候它得撑住事件循环。否则一旦调用方注入了永不 settle 的
 *    fetch（测试桩常见），Node 会因为没有活跃句柄而静默退出（退出码 0、一行都不打印）；
 * 2) 每次请求结束都 clearTimeout，所以它不会拖住进程退出——真正阻塞退出的只有还在飞的请求；
 * 3) 额外返回 race：即使注入的 fetch 完全不理 signal，超时后调用也一定会 reject。
 */
function makeTimeout(ms) {
  if (typeof AbortController !== 'function' || !Number.isFinite(ms) || ms <= 0) {
    return { signal: undefined, race: null, dispose() {} };
  }
  const controller = new AbortController();
  const abortError = new Error(`Canvas 请求超时（${ms}ms）`);
  const timer = setTimeout(() => {
    try {
      controller.abort(abortError);
    } catch {
      controller.abort();
    }
  }, ms);
  const race = new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortError), { once: true });
  });
  return {
    signal: controller.signal,
    race,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** 读一小段响应体做错误摘要；绝不让读体失败盖住原始错误。 */
async function readExcerpt(response) {
  if (!response) return '';
  try {
    if (typeof response.text === 'function') return String(await response.text()).slice(0, BODY_EXCERPT_LIMIT);
    if (typeof response.text === 'string') return response.text.slice(0, BODY_EXCERPT_LIMIT);
    if (typeof response.clone === 'function') return String(await response.clone().text()).slice(0, BODY_EXCERPT_LIMIT);
  } catch {
    return '';
  }
  return '';
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function emit(logger, level, message) {
  if (!logger) return;
  const fn = typeof logger[level] === 'function' ? logger[level] : null;
  if (fn) fn.call(logger, message);
}

/* ------------------------------------------------------------------ *
 * 宽松 ISO 8601 解析 + 回溯窗口
 * ------------------------------------------------------------------ */

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * 宽松解析 ISO 8601 时间串，返回 UTC 毫秒；失败返回 null。
 * - 支持 `Z`、`+08:00`、`+0800`、小数秒、以及只有日期的 `2024-12-16`；
 * - 不带时区（naive）的串按 UTC 处理（与 Python 版 replace(tzinfo=utc) 一致）；
 * - 非字符串 / 空串 / 无法解析 -> null（调用方据此"不丢弃"）。
 */
export function parseIsoMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const match = ISO_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  const base = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (!Number.isFinite(base)) return null;
  let offsetMinutes = 0;
  if (zone && zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const body = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4)));
  }
  return base - offsetMinutes * 60000;
}

/**
 * 时间字段是否**确定**早于回溯窗口。
 * 无值（null / 空串）或解析失败一律返回 false，即"不确定就不丢弃"。
 */
export function isBeforeLookback(value, cutoffMs) {
  const parsed = parseIsoMs(value);
  return parsed !== null && parsed < cutoffMs;
}

/* ------------------------------------------------------------------ *
 * 令牌桶（移植 core/rate_limiter.py）
 * ------------------------------------------------------------------ */

export class TokenBucket {
  /**
   * @param {number} ratePerSec 每秒补充的令牌数
   * @param {number} burst 桶容量（本连接器固定 1）
   * @param {(ms: number) => Promise<void>} sleep 等待实现（注入 sleep 以方便测试）
   * @param {() => number} now 单调时钟（毫秒）；注入假时钟可让限流断言完全确定
   */
  constructor(ratePerSec, burst = 1, sleep = defaultSleep, now = monotonicNow) {
    const rate = Number(ratePerSec);
    if (!(rate > 0)) throw new Error(`rate_limit_rps 必须大于 0，当前为 ${ratePerSec}`);
    if (!(burst >= 1)) throw new Error(`burst 必须大于等于 1，当前为 ${burst}`);
    this.ratePerSec = rate;
    this.burst = Math.trunc(burst);
    this.sleepFn = typeof sleep === 'function' ? sleep : defaultSleep;
    this.nowFn = typeof now === 'function' ? now : monotonicNow;
    this.tokens = this.burst;
    this.updatedAt = this.nowFn();
    // 串行化：等待期间持有"锁"，宁可让并发请求排队，也不允许令牌被重复透支。
    this.chain = Promise.resolve();
  }

  async acquire(tokens = 1) {
    if (tokens > this.burst) {
      throw new Error(`单次申请的令牌数 ${tokens} 超过桶容量 ${this.burst}`);
    }
    const previous = this.chain;
    let release;
    this.chain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let spin = 0;
      for (;;) {
        this.#refill();
        if (this.tokens >= tokens) {
          this.tokens -= tokens;
          return;
        }
        spin += 1;
        await this.sleepFn(this.#waitSeconds(tokens) * 1000);
        if (spin >= MAX_SPIN_ITERATIONS) {
          // 注入的 sleep 立即返回且速率很低时，靠真实计时器保证一定推进。
          await defaultSleep(0);
          spin = 0;
        }
      }
    } finally {
      release();
    }
  }

  #refill() {
    const now = this.nowFn();
    const elapsedSeconds = (now - this.updatedAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSec);
    this.updatedAt = now;
  }

  #waitSeconds(tokens) {
    const missing = tokens - this.tokens;
    return Math.max(missing / this.ratePerSec, 0.01);
  }
}

/* ------------------------------------------------------------------ *
 * 上下文
 * ------------------------------------------------------------------ */

function makeContext(config, options) {
  const cfg = config && typeof config === 'object' ? config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const retryCfg = cfg.retry && typeof cfg.retry === 'object' ? cfg.retry : {};
  const injectedSleep = typeof opts.sleep === 'function' ? opts.sleep : null;

  const baseUrl = String(cfg.baseUrl === undefined || cfg.baseUrl === null ? '' : cfg.baseUrl).replace(/\/+$/, '');
  const token = String(cfg.token === undefined || cfg.token === null ? '' : cfg.token);
  const lookbackDays = toInt(cfg.lookbackDays, 30);
  // 契约键优先，同时容忍宿主配置层的替代表达式（见 fetchCanvas 的 JSDoc「配置键别名」）：
  //   timeoutSeconds -> timeoutMs（毫秒）、rateLimitRps -> requestsPerSecond、retry.maxAttempts -> 顶层 maxAttempts。
  const hasTimeoutSeconds = cfg.timeoutSeconds !== undefined && cfg.timeoutSeconds !== null;
  const hasRateLimitRps = cfg.rateLimitRps !== undefined && cfg.rateLimitRps !== null;
  const timeoutMs = hasTimeoutSeconds ? toNumber(cfg.timeoutSeconds, 20) * 1000 : toNumber(cfg.timeoutMs, 20 * 1000);
  const rateLimitRps = hasRateLimitRps ? toNumber(cfg.rateLimitRps, 3) : toNumber(cfg.requestsPerSecond, 3);
  const maxAttempts = Math.max(toInt(retryCfg.maxAttempts, toInt(cfg.maxAttempts, 3)), 1);
  const backoffBase = toNumber(retryCfg.backoffBase, 1.5);
  const logger = opts.logger === undefined ? console : opts.logger;
  const fetchImpl =
    typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (url, init) => globalThis.fetch(url, init);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const sleep = injectedSleep || defaultSleep;
  // 限流等待复用注入的 sleep（测试里可瞬间返回）；令牌桶自身的时钟是单调时钟，不受 options.now 影响。
  const bucket = new TokenBucket(rateLimitRps, 1, sleep);

  return {
    baseUrl,
    token,
    lookbackDays,
    timeoutMs,
    maxAttempts,
    backoffBase,
    logger,
    fetchImpl,
    now,
    sleep,
    bucket,
  };
}

/* ------------------------------------------------------------------ *
 * 单次 HTTP 请求 + 重试
 * ------------------------------------------------------------------ */

/** 发一次 GET（带超时），不做重试、不做状态判断。 */
async function rawFetch(ctx, url) {
  const timeout = makeTimeout(ctx.timeoutMs);
  try {
    const pending = Promise.resolve().then(() =>
      ctx.fetchImpl(url, {
        method: 'GET',
        headers: authHeaders(ctx.token),
        signal: timeout.signal,
      }),
    );
    if (!timeout.race) return await pending;
    // race 先 reject 时，pending 之后才 reject 也不该变成 unhandledRejection。
    pending.catch(() => {});
    return await Promise.race([pending, timeout.race]);
  } finally {
    timeout.dispose();
  }
}

async function httpStatusError(response, url) {
  const excerpt = collapse(await readExcerpt(response));
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const detail = excerpt ? `，响应片段：${excerpt}` : '';
  const err = new Error(`Canvas 请求失败：HTTP ${response.status}${statusText}${detail}（${url}）`);
  err.status = response.status;
  err.url = url;
  return err;
}

/**
 * 发一次 GET；429 / 5xx / 网络异常按指数退避重试，其它非 2xx 直接抛出。
 * - 429 优先用 Retry-After（解析成数字就用，**包括 0**，不能用 || 短路）；
 * - 网络异常（fetch reject / 超时）用 backoffBase ** attempt；
 * - 最后一次尝试之后不再 sleep，直接抛 `Canvas 请求重试 N 次后仍失败：<path>`。
 */
async function request(ctx, pathOrUrl, params) {
  const url = buildUrl(ctx.baseUrl, pathOrUrl, params);
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt += 1) {
    await ctx.bucket.acquire();
    let retryWait = null;
    let response = null;
    let networkError = null;
    try {
      response = await rawFetch(ctx, url);
    } catch (err) {
      networkError = err;
      retryWait = ctx.backoffBase ** attempt;
      emit(ctx.logger, 'warn', `Canvas 请求异常（第 ${attempt}/${ctx.maxAttempts} 次）：${pathOrUrl} -> ${errorText(err)}`);
    }
    if (networkError === null) {
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = retryAfterSeconds(response);
        retryWait = retryAfter !== null ? retryAfter : ctx.backoffBase ** attempt;
        emit(
          ctx.logger,
          'warn',
          `Canvas 返回 ${response.status}（第 ${attempt}/${ctx.maxAttempts} 次），${retryWait.toFixed(1)}s 后重试：${pathOrUrl}`,
        );
      } else if (!response.ok) {
        throw await httpStatusError(response, url);
      } else {
        return response;
      }
    }
    if (retryWait !== null && attempt < ctx.maxAttempts) {
      await ctx.sleep(retryWait * 1000);
    }
  }
  throw new Error(`Canvas 请求重试 ${ctx.maxAttempts} 次后仍失败：${pathOrUrl}`);
}

/** 按 Link header 的 rel="next" 逐页取完，返回合并后的条目列表。 */
async function getPaginated(ctx, path, params) {
  const results = [];
  let nextUrl = path;
  let currentParams = params || null;
  while (nextUrl) {
    const response = await request(ctx, nextUrl, currentParams);
    const payload = await response.json();
    if (Array.isArray(payload)) results.push(...payload);
    else if (payload && typeof payload === 'object') results.push(payload);
    nextUrl = nextLinkFromHeader(headerValue(response.headers, 'Link'));
    // next 链接自带完整查询串，后续页不能再叠加 params
    currentParams = null;
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 单课程两类条目的构造
 * ------------------------------------------------------------------ */

/** 缺失（undefined）归一为 null；null 仍是 null；其余原样透传（不做任何解析/格式化）。 */
function rawOrNull(obj, key) {
  const value = obj ? obj[key] : undefined;
  return value === undefined ? null : value;
}

/**
 * 只留下"我到底交没交"需要的几个字段。
 *
 * Canvas 的 submission 对象很大（还带附件/评分明细），整包塞进 payload 会撑爆
 * snapshots.payload_json，所以这里收窄；它**不参与哈希**（见 pipeline.HASH_FIELDS），
 * 因此每次拉取都能刷新提交状态，却不会因为交了作业而触发重新打分。
 */
function submissionView(assignment) {
  const submission = assignment ? assignment.submission : null;
  if (submission === null || typeof submission !== 'object') return null;
  return {
    workflow_state: rawOrNull(submission, 'workflow_state'),
    submitted_at: rawOrNull(submission, 'submitted_at'),
    graded_at: rawOrNull(submission, 'graded_at'),
    excused: submission.excused === true,
  };
}

async function fetchAssignments(ctx, courseId, courseName, warnings) {
  const raw = await getPaginated(ctx, `/api/v1/courses/${courseId}/assignments`, {
    per_page: PAGE_SIZE,
    // 需要 submission 才能知道"我已经交了没有"（不交就是没做）——
    // 它只用于自动勾选完成，不在哈希白名单里，所以不会引起整表重打分。
    'include[]': 'submission',
  });
  const cutoff = ctx.now() - ctx.lookbackDays * DAY_MS;
  const items = [];
  for (const assignment of raw) {
    // 只有"确实早于窗口"的才跳过；无 due_at / 解析失败一律保留。
    if (isBeforeLookback(assignment ? assignment.due_at : null, cutoff)) {
      warnings.push(
        `作业 ${assignment ? assignment.id : ''}（${courseName}）的 due_at 早于回溯窗口，已跳过：${assignment ? assignment.due_at : ''}`,
      );
      continue;
    }
    const assignmentId = assignment ? assignment.id : undefined;
    // 契约：派生不出 external_id 的条目必须**跳过**（宁可少一条，也不能造出
    // `course:1:assignment:undefined` 这种假 id —— 它会在库里留下永久重复项）。
    if (assignmentId === undefined || assignmentId === null || assignmentId === '') {
      const skipped = `作业缺少 id，已跳过（课程 ${courseId}（${courseName}））：${JSON.stringify(assignment ?? null)}`;
      warnings.push(skipped);
      emit(ctx.logger, 'warn', skipped);
      continue;
    }
    items.push({
      source: SOURCE_ASSIGNMENT,
      external_id: `course:${courseId}:assignment:${assignmentId}`,
      course_id: String(courseId),
      payload: {
        name: (assignment ? assignment.name : '') || '',
        description: (assignment ? assignment.description : '') || '',
        due_at: rawOrNull(assignment, 'due_at'),
        points_possible: rawOrNull(assignment, 'points_possible'),
        submission_types: (assignment ? assignment.submission_types : null) || [],
        // 以下都**不参与哈希**（见 lib/pipeline.js 的 HASH_FIELDS）：
        // omit_from_final_grade 决定"不计入总成绩的测验"要不要降权，
        // submission 决定能不能自动勾完成。
        omit_from_final_grade: assignment ? assignment.omit_from_final_grade === true : false,
        grading_type: rawOrNull(assignment, 'grading_type'),
        quiz_id: rawOrNull(assignment, 'quiz_id'),
        submission: submissionView(assignment),
        course_name: courseName,
      },
    });
  }
  return items;
}

async function fetchAnnouncements(ctx, courseId, courseName, warnings) {
  const raw = await getPaginated(ctx, ANNOUNCEMENTS_PATH, {
    'context_codes[]': `course_${courseId}`,
    per_page: PAGE_SIZE,
  });
  const cutoff = ctx.now() - ctx.lookbackDays * DAY_MS;
  const items = [];
  for (const announcement of raw) {
    // 与作业同理：posted_at 为空或解析失败时保留，不丢弃
    if (isBeforeLookback(announcement ? announcement.posted_at : null, cutoff)) {
      warnings.push(
        `公告 ${announcement ? announcement.id : ''}（${courseName}）的 posted_at 早于回溯窗口，已跳过：${announcement ? announcement.posted_at : ''}`,
      );
      continue;
    }
    const announcementId = announcement ? announcement.id : undefined;
    if (announcementId === undefined || announcementId === null || announcementId === '') {
      const skipped = `公告缺少 id，已跳过（课程 ${courseId}（${courseName}））：${JSON.stringify(announcement ?? null)}`;
      warnings.push(skipped);
      emit(ctx.logger, 'warn', skipped);
      continue;
    }
    items.push({
      source: SOURCE_ANNOUNCEMENT,
      external_id: `course:${courseId}:announcement:${announcementId}`,
      course_id: String(courseId),
      payload: {
        title: (announcement ? announcement.title : '') || '',
        message: (announcement ? announcement.message : '') || '',
        posted_at: rawOrNull(announcement, 'posted_at'),
        course_name: courseName,
      },
    });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * Canvas 配置是否齐全：baseUrl 与 token 必须都是非空字符串。
 *
 * 只做"能不能发请求"的静态判断，不联网。
 *
 * @param {{ baseUrl?: unknown, token?: unknown }} config
 * @returns {boolean}
 */
export function canvasConfigured(config) {
  if (!config || typeof config !== 'object') return false;
  const { baseUrl, token } = config;
  return (
    typeof baseUrl === 'string' && baseUrl.length > 0 && typeof token === 'string' && token.length > 0
  );
}

/**
 * 拉取所有在读课程近 lookbackDays 内的作业与公告。
 *
 * 移植自 Python 版 CanvasConnector.fetch + _fetch_assignments + _fetch_announcements。
 * 不变式（改动前先读文件头）：
 * - payload.due_at / posted_at / points_possible 原样透传，绝不解析成 Date 或重新格式化；
 * - 解析不了的 due_at / posted_at **保留**，只有确定早于 cutoff 的才丢；
 * - 逐课程隔离：单课程失败只进 warnings，不影响其它课程；/api/v1/courses 失败向上抛出。
 *
 * @param {{ baseUrl: string, token: string, lookbackDays?: number, timeoutSeconds?: number,
 *           rateLimitRps?: number, retry?: { maxAttempts?: number, backoffBase?: number },
 *           timeoutMs?: number, requestsPerSecond?: number, maxAttempts?: number }} config
 *        配置键别名（契约键优先，别名只做兜底，便于宿主配置层直接透传）：
 *        `timeoutSeconds` -> `timeoutMs`（毫秒），`rateLimitRps` -> `requestsPerSecond`，
 *        `retry.maxAttempts` -> 顶层 `maxAttempts`。
 * @param {{ fetchImpl?: Function, now?: () => number, logger?: object|null,
 *           sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ items: Array<{source: string, external_id: string, course_id: string, payload: object}>,
 *                     warnings: string[], courses: object[] }>}
 *          courses 是 /api/v1/courses 分页拉到的原始课程对象（含没有 id、被跳过的那些）。
 */
export async function fetchCanvas(config, options = {}) {
  const ctx = makeContext(config, options);
  const warnings = [];
  const items = [];

  // 这一层失败要向上抛（不隔离）：连课程列表都拿不到就没法继续。
  const courses = await getPaginated(ctx, COURSES_PATH, {
    enrollment_state: 'active',
    per_page: PAGE_SIZE,
  });

  const list = Array.isArray(courses) ? courses : [];
  for (let index = 0; index < list.length; index += 1) {
    const course = list[index];
    const courseId = course ? course.id : undefined;
    if (courseId === undefined || courseId === null) {
      warnings.push(`第 ${index + 1} 个课程缺少 id，已跳过：${JSON.stringify(course)}`);
      continue;
    }
    // Python 用 course_code（Canvas 的真实字段名）；额外兼容 course.code 以免配置侧写成短名。
    const courseName =
      (course.name || course.course_code || course.code) || String(courseId);
    try {
      items.push(...(await fetchAssignments(ctx, courseId, courseName, warnings)));
      items.push(...(await fetchAnnouncements(ctx, courseId, courseName, warnings)));
    } catch (err) {
      // 故意广 catch：单个课程失败（403 / 404 / 超时）不能让整轮 fetch 挂掉
      const message = `课程 ${courseId}（${courseName}）拉取失败，跳过：${errorText(err)}`;
      emit(ctx.logger, 'warn', message);
      warnings.push(message);
      continue;
    }
  }

  emit(ctx.logger, 'info', `Canvas 拉取完成：${items.length} 条（近 ${ctx.lookbackDays} 天）`);
  return { items, warnings, courses: list };
}

/**
 * 连接自检：发一次课程列表探测请求（per_page=1），把结果翻译成中文提示。
 *
 * 不变式：**绝不抛异常**，任何失败都以 { ok: false, message } 返回，
 * 这样 UI 侧不需要再包 try/catch。
 *
 * @param {{ baseUrl: string, token: string, timeoutSeconds?: number, timeoutMs?: number }} config
 *        `timeoutMs`（毫秒）是 `timeoutSeconds` 的兜底别名，两者都缺省时按 20s 处理。
 * @param {{ fetchImpl?: Function, logger?: object|null }} [options]
 * @returns {Promise<{ ok: boolean, message: string, detail?: string }>}
 */
export async function testCanvas(config, options = {}) {
  try {
    if (!canvasConfigured(config)) {
      return { ok: false, message: 'Canvas 未配置完整：baseUrl 与 token 都必须是非空字符串' };
    }
    const ctx = makeContext(config, options);
    const url = buildUrl(ctx.baseUrl, COURSES_PATH, { enrollment_state: 'active', per_page: 1 });

    let response;
    try {
      response = await rawFetch(ctx, url);
    } catch (err) {
      return { ok: false, message: `连接失败：${errorText(err)}`, detail: url };
    }

    if (response.status === 401) {
      return { ok: false, message: 'Canvas 令牌无效或已过期（401），请重新生成 token', detail: url };
    }
    if (response.status === 403) {
      return { ok: false, message: 'Canvas 拒绝访问（403）：当前 token 没有查看课程的权限', detail: url };
    }
    if (!response.ok) {
      const excerpt = collapse(await readExcerpt(response));
      return {
        ok: false,
        message: `Canvas 返回 HTTP ${response.status}，连接测试未通过`,
        detail: excerpt || url,
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      return { ok: false, message: `Canvas 响应不是合法 JSON：${errorText(err)}`, detail: url };
    }
    const count = Array.isArray(payload) ? payload.length : payload && typeof payload === 'object' ? 1 : 0;
    return { ok: true, message: `连接成功，检测到 ${count} 门进行中的课程`, detail: url };
  } catch (err) {
    return { ok: false, message: `连接失败：${errorText(err)}` };
  }
}

/* ------------------------------------------------------------------ *
 * Source 工厂（宿主统一按 source 对象调用）
 * ------------------------------------------------------------------ */

/**
 * 把 deps.logger / ctx.log 收敛成一个 logger 对象。
 *
 * 约定：`deps.logger === undefined` 时才回落到 `ctx.log`；显式传 `null` 表示静默
 * （库不应该在没人要日志的时候往 stdout 打字）。日志本身抛错绝不影响拉取。
 */
function sourceLogger(deps, ctx) {
  if (deps.logger !== undefined) return deps.logger;
  const log = ctx && typeof ctx.log === 'function' ? ctx.log : null;
  if (!log) return null;
  const write = (message) => {
    try {
      log(String(message));
    } catch {
      /* 日志通道坏了不该拖垮拉取 */
    }
  };
  return { info: write, warn: write, error: write, debug: () => {} };
}

/**
 * ctx.now（契约是 Date）→ 底层 connector 需要的「返回毫秒的函数」。
 * 同时兼容毫秒数与函数两种注入形态；没有可用的就返回 null（沿用底层默认时钟）。
 */
function sourceNow(context, deps) {
  const value = context ? context.now : undefined;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const ms = value.getTime();
    return () => ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return () => value;
  if (typeof value === 'function') return () => Number(value());
  if (typeof deps.now === 'function') return () => Number(deps.now());
  return null;
}

/** 401 / 403 补一句人话提示，其它错误原样上抛。 */
function enrichCanvasError(error) {
  const text = errorText(error);
  const status = error && typeof error === 'object' ? error.status : undefined;
  if (status === 401) return new Error(`Canvas 返回 401（token 可能已过期）：${text}`);
  if (status === 403) return new Error(`Canvas 返回 403（token 权限不足）：${text}`);
  return error instanceof Error ? error : new Error(text);
}

/**
 * 造一个 Canvas source 对象（新契约）。
 *
 * @param {object} config plugin config 的 canvas 段（`{enabled, baseUrl, token, lookbackDays,
 *        timeoutMs, maxAttempts, requestsPerSecond}`；同时容忍 `timeoutSeconds` /
 *        `rateLimitRps` / `retry.maxAttempts` 等底层别名）
 * @param {{fetch?: Function, sleep?: Function, now?: () => number, logger?: object|null}} [deps]
 *        注入点仅用于测试与宿主适配；默认走全局 fetch + 真实计时器，且默认静默。
 * @returns {{name: string, enabled: boolean, configured: boolean, describe: Function,
 *           fetchItems: Function, test: Function}}
 */
export function createCanvasSource(config = {}, deps = {}) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const injected = deps && typeof deps === 'object' ? deps : {};
  const baseUrl = String(cfg.baseUrl === undefined || cfg.baseUrl === null ? '' : cfg.baseUrl).replace(/\/+$/, '');
  const lookbackDays = toInt(cfg.lookbackDays, 30);
  const configured = canvasConfigured(cfg);
  const isEnabled = () => (cfg.enabled === undefined ? true : Boolean(cfg.enabled));

  /** ctx 覆盖 + 注入点 → 底层 fetchCanvas/testCanvas 的 (config, options)。 */
  const plan = (ctx) => {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    const overrideDays = Number(context.lookbackDays);
    const effective =
      context.lookbackDays === undefined || !Number.isFinite(overrideDays)
        ? cfg
        : { ...cfg, lookbackDays: overrideDays };
    const options = { logger: sourceLogger(injected, context) };
    if (typeof injected.fetch === 'function') options.fetchImpl = injected.fetch;
    if (typeof injected.sleep === 'function') options.sleep = injected.sleep;
    const now = sourceNow(context, injected);
    if (now) options.now = now;
    return { effective, options };
  };

  return {
    name: 'canvas',
    get enabled() {
      return isEnabled();
    },
    get configured() {
      return configured;
    },
    describe() {
      return { enabled: isEnabled(), configured, baseUrl, lookbackDays };
    },
    async fetchItems(ctx = {}) {
      if (!configured) throw new Error('Canvas 未配置完整：baseUrl 与 token 都必须是非空字符串');
      const { effective, options } = plan(ctx);
      let result;
      try {
        // fetchCanvas 内部已保证「单课程失败只进 warnings」，这里只需要兜住整源失败。
        result = await fetchCanvas(effective, options);
      } catch (error) {
        throw enrichCanvasError(error);
      }
      // 单课程失败只进 warnings（不该静默丢掉），宿主通过 ctx.log 能看到。
      if (options.logger && Array.isArray(result && result.warnings)) {
        for (const warning of result.warnings) emit(options.logger, 'warn', warning);
      }
      return Array.isArray(result && result.items) ? result.items : [];
    },
    async test(ctx = {}) {
      const { options } = plan(ctx);
      const result = await testCanvas(cfg, options);
      const out = { ok: result?.ok === true, message: String(result?.message ?? '') };
      if (result && result.detail !== undefined) out.detail = result.detail;
      return out;
    },
  };
}
