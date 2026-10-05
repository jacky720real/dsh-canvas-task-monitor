/**
 * 拉取管线：拉取 → 变更检测 → 打分（规则 / AI）→ 落库 → 记录快照。
 *
 * 顺序即不变量（沿用旧项目，改动前先读这段）：
 *   1. 逐源隔离：一个源抛错只记进 errors，不影响另一个源；
 *   2. **没有变更就绝不调用 AI**（省钱、省时间）；
 *   3. 先算草稿、写任务，**最后才写快照** —— 快照写早了，崩溃或 AI 失败会让这批素材永远丢失；
 *   4. AI 全部批次失败时：规则草稿照写，但该源不写快照，下一轮自动重试；
 *   5. 单条任务写库失败只记日志，不影响同一批的其它任务；
 *   6. 没有"removed"：素材消失既不删任务也不改状态（旧项目的已知取舍，这里保持一致）。
 */
import { asInt, asString, canonicalHash, clamp, errorText, parseDateMs, utcNowIso } from './util.js';
import { dbPathIn } from './config.js';
import { fetchCanvas, canvasConfigured, testCanvas } from './canvas.js';
import { fetchMail, mailConfigured, testMail } from './mail.js';
import { ruleAssess, computeScore, isRegistrationConfirmation, stripHtml } from './scoring.js';
import { aiConfigured, scoreItems, testAi } from './llm.js';
import { isAvailable as sqliteAvailable, openStore } from './store.js';

/** 每个 source 参与哈希的字段（与旧项目 core/hashing.py:13-17 完全一致）。 */
export const HASH_FIELDS = {
  canvas_assignment: ['name', 'description', 'due_at', 'points_possible', 'submission_types'],
  canvas_announcement: ['title', 'message', 'posted_at'],
  mail: ['subject', 'from', 'receivedDateTime', 'bodyPreview'],
};

/**
 * 判定逻辑的版本号。**改动打分/分类/时间推断的语义时必须 +1**。
 *
 * 存在理由：任务行只在下一次"素材有变更"时才重算，所以纯逻辑升级（比如这次修的
 * "转发头时间被当成截止时间""不计入总成绩的测验降权""公告按内容分类"）在老库上
 * 永远不会生效 —— 用户重启后看到的还是旧判定。版本号一变，下一轮拉取会把当前
 * 窗口内的素材整体当作"需要重算"，跑完之后再记下新版本号（只发生一次）。
 */
export const ASSESS_REVISION = 2;

export const META_ASSESS_REVISION = 'assess_revision';

/** 同形状（数字抹平后）的告警最多原样留几条，其余折成一行计数。 */
export const WARNING_KIND_LIMIT = 2;

/** 未知 source 必须抛错，绝不回退成"整份 payload 全量哈希"。 */
export function hashItem(item) {
  const source = asString(item?.source);
  const fields = HASH_FIELDS[source];
  if (fields === undefined) {
    throw new Error(`未登记哈希字段的 source：${source}（请在 pipeline.HASH_FIELDS 里补上白名单）`);
  }
  return canonicalHash(item?.payload ?? {}, fields);
}

/**
 * 变更检测（只读快照，不产生 removed）。
 * @returns {Array<{item: object, change_type: 'new'|'updated', content_hash: string, previous_hash: string|null, changed_fields: string[]}>}
 */
export function detectChanges(items, hashes) {
  const changes = [];
  for (const item of items) {
    const key = asString(item?.external_id);
    const contentHash = hashItem(item);
    const previous = hashes instanceof Map ? hashes.get(key) : undefined;
    if (previous === undefined || previous === null) {
      changes.push({
        item,
        change_type: 'new',
        content_hash: contentHash,
        previous_hash: null,
        changed_fields: [...HASH_FIELDS[asString(item?.source)]],
      });
      continue;
    }
    if (previous !== contentHash) {
      changes.push({
        item,
        change_type: 'updated',
        content_hash: contentHash,
        previous_hash: previous,
        changed_fields: [...HASH_FIELDS[asString(item?.source)]],
      });
    }
  }
  return changes;
}

/** Canvas 的 due_at 直接来自 LMS 的权威字段：规则草稿已有值时，不接受 AI 覆盖。 */
const AUTHORITATIVE_DUE_AT = new Set(['canvas_assignment']);

/** 日期比收信/发布时间早这么多，就认定是从引用历史里抄出来的（邮件转发头、旧对话）。 */
const STALE_DATE_SLACK_MS = 12 * 3_600_000;

/**
 * 把 AI 结果覆盖到规则草稿上（AI 没给的字段保留规则值）。
 *
 * due_at 与 due_kind 必须一起走：用户踩过的 bug 是"规则把转发头里的发送时间当成截止时间，
 * AI 明确说没有截止时间，但合并时只让 AI 覆盖 due_at、没动规则值" → 邮件永远显示"已逾期"。
 * 现在的规矩：
 *   - 作业（AUTHORITATIVE_DUE_AT，且规则已算出值）→ 源说话，AI 不得覆盖；
 *   - AI 说"没有明确截止时间"（null）→ 只有当规则那个日期**不是**由截止词支撑的时候才清掉它，
 *     有截止词的日期仍然保留（"截止 9 月 30 日"这种证据比模型的一句话硬）；
 *   - AI 给的新日期早于收信/发布时间 12 小时以上 → 丢掉，宁可没有时间也不显示"已逾期"。
 *
 * @param {object} ruleDraft
 * @param {object|null} aiDraft
 * @param {{notBeforeMs?: number}} [options]
 */
export function mergeDraft(ruleDraft, aiDraft, options = {}) {
  if (aiDraft === null || aiDraft === undefined) return { ...ruleDraft, ai_scored: false };
  const merged = { ...ruleDraft };
  const dueLocked = AUTHORITATIVE_DUE_AT.has(asString(ruleDraft.source)) && asString(ruleDraft.due_at).trim().length > 0;
  for (const key of ['category', 'title', 'summary', 'course', 'urgency', 'importance', 'is_rule', 'urgency_reason', 'importance_reason']) {
    // 权威截止时间只由源决定：模型写错一个日期，用户就会漏交作业
    const value = aiDraft[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    merged[key] = value;
  }
  if (Array.isArray(aiDraft.tags) && aiDraft.tags.length > 0) merged.tags = aiDraft.tags;

  /**
   * 内容判定锁：素材里写着"成绩已发布 / 不计入总成绩"这类**事实**，AI 不许推翻
   * （真机实测：`Quiz 3 Grades` 被规则判成"提醒/重要 1"，模型看到标题里的 Quiz
   * 又把它抬回"活动/重要 4"；用户投诉的就是这个）。锁只锁上限，AI 仍可往下调。
   */
  if (asString(ruleDraft.lock_category).trim().length > 0) {
    merged.category = ruleDraft.lock_category;
  }
  const lockImportance = Number.isFinite(ruleDraft.lock_importance) ? Number(ruleDraft.lock_importance) : null;
  if (lockImportance !== null) {
    const aiImportance = asInt(merged.importance, lockImportance, 0, 5);
    if (aiImportance > lockImportance) {
      merged.importance = lockImportance;
      // 数字被压回来了，模型那句"属重要考试"的说明也跟着作废
      merged.importance_reason = ruleDraft.importance_reason;
    }
  }
  if (Array.isArray(ruleDraft.lock_tags)) merged.tags = [...ruleDraft.lock_tags];

  if (!dueLocked) {
    const ruleIsDeadline = asString(ruleDraft.due_kind) === 'deadline';
    const aiDueText = asString(aiDraft.due_at).trim();
    const notBeforeMs = Number.isFinite(options?.notBeforeMs) ? options.notBeforeMs : null;
    const aiDueMs = aiDueText.length > 0 ? parseDateMs(aiDueText) : null;
    if (aiDueText.length === 0) {
      // AI 判定"素材里没有明确截止时间" → 规则那个只是"文本里第一个像日期的"就一并丢掉
      if (!ruleIsDeadline) {
        merged.due_at = null;
        merged.due_kind = '';
      }
    } else if (aiDueMs === null) {
      // 模型给了无法解析的时间：保留规则结果，不冒险改
    } else if (notBeforeMs !== null && aiDueMs < notBeforeMs - STALE_DATE_SLACK_MS) {
      merged.due_at = null;
      merged.due_kind = '';
    } else {
      merged.due_at = new Date(aiDueMs).toISOString();
      merged.due_kind = 'deadline';
    }
  }

  merged.ai_scored = true;
  return merged;
}

/** 邮件/公告的"收信时间"基线：早于它的日期不可能是这条素材的截止时间。 */
function notBeforeMsOf(item) {
  const payload = item?.payload ?? {};
  return parseDateMs(payload.receivedDateTime ?? payload.posted_at);
}

/** 素材的唯一键（与 tasks 的 UNIQUE(source, external_id) 对齐）。 */
function keyOf(item) {
  return `${asString(item?.source)}\u0000${asString(item?.external_id)}`;
}

/**
 * 从快照还原成一个可评分的素材。
 *
 * 注意：快照的 source 只记到"哪个连接器"（`canvas` / `mail`），而 tasks.source 记的是
 * 具体类型（`canvas_assignment` / `canvas_announcement` / `mail`）。老库里的快照没有类型字段，
 * 所以按 external_id 的形状认回来（`course:<id>:announcement:<id>` 就是公告）。
 */
export function snapshotToItem(sourceName, snapshot) {
  const externalId = asString(snapshot?.external_id);
  if (externalId.length === 0) return null;
  const name = asString(sourceName);
  const source = name === 'canvas'
    ? (externalId.includes(':announcement:') ? 'canvas_announcement' : 'canvas_assignment')
    : name;
  const payload = snapshot?.payload !== null && typeof snapshot?.payload === 'object' ? snapshot.payload : {};
  return {
    source,
    external_id: externalId,
    course_id: snapshot?.course_id === null || snapshot?.course_id === undefined ? null : asString(snapshot.course_id),
    payload,
  };
}

/** 从 RawItem 起一条完整的"待写库"任务（含 status/raw_json）。 */
export function finishDraft(draft, weights) {
  return {
    ...draft,
    status: 'pending',
    score: computeScore(draft.urgency, draft.importance, weights),
    raw_json: draft.raw_json ?? '',
  };
}

/**
 * Canvas 作业"我交了没有"。
 *
 * 只有两种情形算客观完成：submission.submitted_at 有值，或 workflow_state 已是
 * submitted/graded/pending_review。**excused（免修）不算"我做了"**，纯 none 提交类型
 * （无需提交的条目）也不算 —— 否则会把不用交的作业自动划掉。
 */
export function submissionVerdict(item) {
  const payload = item?.payload ?? {};
  const types = Array.isArray(payload.submission_types) ? payload.submission_types.map((t) => asString(t)) : [];
  if (types.length > 0 && types.every((t) => t === 'none')) return { done: false, reason: '' };
  const submission = payload.submission;
  if (submission === null || typeof submission !== 'object') return { done: false, reason: '' };
  if (submission.excused === true) return { done: false, reason: '' };
  if (asString(submission.submitted_at).trim().length > 0) return { done: true, reason: 'Canvas 已提交' };
  const state = asString(submission.workflow_state);
  if (state === 'submitted' || state === 'graded' || state === 'pending_review') return { done: true, reason: 'Canvas 已提交' };
  return { done: false, reason: '' };
}

/** 这些词在"报名成功"邮件与"招募/报名"邮件里都会出现，不能用来配对。 */
const TOKEN_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'your', 'yours', 'have', 'has', 'been', 'will', 'would', 'could', 'should',
  'about', 'there', 'their', 'them', 'they', 'which', 'when', 'where', 'what', 'than', 'then', 'also', 'into',
  'please', 'thanks', 'thank', 'dear', 'hello', 'regards', 'email', 'emails', 'message', 'messages', 'below',
  '注册', '报名', '成功', '确认', '通知', '尊敬', '你好', '谢谢', '感谢', '我们', '你们', '您的', '已经',
  '可以', '参加', '活动', '时间', '地点', '链接', '详情', '以下', '如下', '邮件', '回复', '转发',
]);

/**
 * 从自由文本里抽"可配对词"：英文取 ≥4 个字母的词，中文取 2 字滑窗（中文没有空格，
 * 整段当 token 会因为"讲座报名"与"讲座报名成功"不相等而永远配不上）。
 */
export function confirmationTokens(text) {
  const value = asString(text).toLowerCase();
  const tokens = new Set();
  for (const word of value.match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!TOKEN_STOPWORDS.has(word)) tokens.add(word);
  }
  for (const run of value.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!TOKEN_STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

function isStrongToken(token) {
  return token.codePointAt(0) < 128 ? token.length >= 4 : token.length >= 2;
}

/**
 * 找到"报名成功"这封信对应的那条旧报名任务。
 *
 * 判定：至少共享 2 个可配对词，**或者**有一个强词直接出现在旧任务标题里
 * （现实里旧任务是中文标题"Hall 10 ICFD 篮球招募活动"、确认信是英文标题
 * "Registration Confirmed: ICFD Basketball Recruitment"，只有 ICFD 一个词重合）。
 * 多个候选时取共享词最多的一条。
 */
export function pickRegistrationTarget(confirmItem, candidates) {
  const confirmText = `${asString(confirmItem?.payload?.subject)}\n${stripHtml(confirmItem?.payload?.bodyPreview).slice(0, 2000)}`;
  const mine = confirmationTokens(confirmText);
  if (mine.size === 0) return null;
  let best = null;
  for (const task of Array.isArray(candidates) ? candidates : []) {
    if (asString(task?.source) !== 'mail') continue;
    if (asString(task?.external_id) === asString(confirmItem?.external_id)) continue;
    const theirs = confirmationTokens(`${asString(task?.title)}\n${asString(task?.summary)}`);
    const shared = [...mine].filter((token) => theirs.has(token));
    const titleTokens = confirmationTokens(task?.title);
    const strongInTitle = [...mine].filter((token) => titleTokens.has(token) && isStrongToken(token));
    if (strongInTitle.length === 0 && shared.length < 2) continue;
    const score = shared.length * 2 + strongInTitle.length;
    if (best === null || score > best.score) best = { task, shared, score };
  }
  return best === null ? null : { task: best.task, shared: best.shared };
}

function promotionTitle(title) {
  const value = asString(title).trim();
  if (value.length === 0) return '参加：活动';
  if (value.startsWith('参加') || value.startsWith('出席')) return value;
  return `参加：${value}`;
}

/**
 * 每轮拉取都跑的"完成状态同步"——**必须在变更门禁之外**（pipeline.js 里
 * `if (changes.length === 0) continue` 之前也会调用），因为"我交了作业"这件事
 * 恰恰不会改变任何参与哈希的字段。
 *
 * 三条不可违反的规矩：
 *   1. `status_source === 'user'` 的任务**绝不**自动改：用户手动取消勾选是主观决定；
 *   2. 只把 pending 变 done，不反过来（不自动取消勾选）；
 *   3. 绝不抛异常（同步失败只是少勾一次，不该让整轮拉取失败）。
 *
 * @returns {{completed: number, promoted: number, notes: string[]}}
 */
export function syncCompletions(sourceName, items, store, options = {}) {
  const notes = [];
  let completed = 0;
  let promoted = 0;
  const list = Array.isArray(items) ? items : [];
  try {
    if (sourceName === 'canvas') {
      for (const item of list) {
        if (asString(item?.source) !== 'canvas_assignment') continue;
        const verdict = submissionVerdict(item);
        if (!verdict.done) continue;
        const task = store.getTaskByKey(asString(item.source), asString(item.external_id));
        if (task === null || asString(task.status) === 'done') continue;
        if (asString(task.status_source) === 'user') continue;
        store.setStatus(task.id, 'done', { source: 'canvas', note: verdict.reason });
        completed += 1;
        notes.push(`已自动完成（${verdict.reason}）：${asString(task.title)}`);
      }
      return { completed, promoted, notes };
    }

    if (sourceName !== 'mail') return { completed, promoted, notes };
    const mailTasks = store.listTasksBySource('mail');
    for (const item of list) {
      if (asString(item?.source) !== 'mail') continue;
      const text = `${asString(item?.payload?.subject)}\n${stripHtml(item?.payload?.bodyPreview).slice(0, 2000)}`;
      if (!isRegistrationConfirmation(text)) continue;

      // 1) 找出旧的"报名/招募"提醒 → 升级成"参加"
      const hit = pickRegistrationTarget(item, mailTasks);
      if (hit !== null) {
        const task = hit.task;
        const already = promotionTitle(task.title) === asString(task.title);
        if (!already && asString(task.status) !== 'done') {
          const importance = clamp(asInt(task.importance) + 1, 0, 5);
          store.upsertTask({
            ...task,
            category: 'activity',
            title: promotionTitle(task.title),
            importance,
            importance_reason: `${asString(task.importance_reason)}；报名已确认（${hit.shared.slice(0, 3).join('、')}）`,
            due_kind: asString(task.due_kind),
            raw_json: asString(task.raw_json),
          });
          promoted += 1;
          notes.push(`报名已确认，改为参加：${asString(task.title)}`);
        }
      }

      // 2) 这封确认信本身不用再做 → 自动勾掉
      const mine = store.getTaskByKey('mail', asString(item.external_id));
      if (mine === null || asString(mine.status) === 'done') continue;
      if (asString(mine.status_source) === 'user') continue;
      store.setStatus(mine.id, 'done', { source: 'mail', note: '邮件确认报名成功' });
      completed += 1;
      notes.push(`已自动完成（邮件确认报名成功）：${asString(mine.title)}`);
    }
    return { completed, promoted, notes };
  } catch (error) {
    notes.push(`完成状态同步失败：${errorText(error)}`);
    return { completed, promoted, notes };
  }
}

function canvasFetchConfig(canvas) {
  return {
    baseUrl: asString(canvas.baseUrl),
    token: asString(canvas.token),
    lookbackDays: asInt(canvas.lookbackDays, 30, 1, 3650),
    timeoutSeconds: Math.max(asInt(canvas.timeoutMs, 20_000, 1000, 300_000) / 1000, 1),
    rateLimitRps: Number(canvas.requestsPerSecond) > 0 ? Number(canvas.requestsPerSecond) : 3,
    retry: { maxAttempts: asInt(canvas.maxAttempts, 3, 1, 10), backoffBase: 1.5 },
  };
}

/**
 * 跑一轮拉取。
 *
 * @param {{dataDir: string, config: object, logger?: object, store?: object, nowMs?: number,
 *          fetchImpl?: Function, sleep?: Function, sources?: string[]}} params
 * @returns {Promise<object>} stats
 */
export async function pollOnce(params) {
  const dataDir = asString(params?.dataDir);
  const config = params?.config ?? {};
  const logger = params?.logger ?? null;
  const store = params?.store ?? openStore(dbPathIn(dataDir));
  const nowMs = Number.isFinite(params?.nowMs) ? params.nowMs : Date.now();
  const weights = { urgencyWeight: config?.scoring?.urgencyWeight, importanceWeight: config?.scoring?.importanceWeight };
  const wanted = Array.isArray(params?.sources) && params.sources.length > 0 ? params.sources : ['canvas', 'mail'];

  const stats = {
    started_at: new Date(nowMs).toISOString(),
    finished_at: null,
    duration_ms: 0,
    sources: 0,
    changes: 0,
    tasks: 0,
    completed: 0,
    promoted: 0,
    rescored: 0,
    llm_calls: 0,
    ai_used: false,
    errors: [],
    warnings: [],
    per_source: {},
  };

  const plans = {
    canvas: {
      enabled: config?.canvas?.enabled === true,
      configured: canvasConfigured(config?.canvas),
      label: 'Canvas',
      fetch: () => fetchCanvas(canvasFetchConfig(config.canvas), params),
    },
    mail: {
      enabled: config?.mail?.enabled === true,
      configured: mailConfigured(config?.mail),
      label: '邮箱',
      fetch: () => fetchMail(config.mail, params),
    },
  };

  const aiOn = aiConfigured(config?.ai);

  // 判定逻辑升级过（见 ASSESS_REVISION）：下一轮把当前窗口的素材整体重算一次。
  let assessStale = false;
  try {
    assessStale = asString(store.getMeta(META_ASSESS_REVISION)) !== String(ASSESS_REVISION);
  } catch {
    assessStale = false;
  }
  let rescored = false;
  // 只要有一轮把某个源的素材窗口完整评估过，就把判定版本记下来（下一轮不用再整体重算）
  let assessApplied = false;

  // 先把要跑的源挑出来（校验与计数仍按原顺序做，便于和旧行为逐条对齐）
  const activeSources = [];
  for (const name of wanted) {
    const plan = plans[name];
    if (plan === undefined) {
      stats.errors.push(`未知的数据源：${name}`);
      continue;
    }
    if (!plan.enabled) continue;
    if (!plan.configured) {
      stats.errors.push(`${plan.label} 已启用但配置不完整，已跳过`);
      continue;
    }
    stats.sources += 1;
    activeSources.push({
      name,
      plan,
      sourceStat: { items: 0, changes: 0, tasks: 0, llm_calls: 0, ai_scored: 0, skipped: 0, warnings: [] },
    });
  }

  /* 两个源互不相干：网络阶段**并发**跑（各自带自己的限流桶），写库仍按原顺序串行。
     过去是「Canvas 拉完再拉邮箱」，两段延迟直接相加；并发后总时长≈较慢的那一个。 */
  const fetchedList = await Promise.all(
    activeSources.map(async (entry) => {
      try {
        return { ok: true, value: await entry.plan.fetch() };
      } catch (error) {
        return { ok: false, error };
      }
    }),
  );

  for (let index = 0; index < activeSources.length; index += 1) {
    const { name, plan, sourceStat } = activeSources[index];
    const outcome = fetchedList[index];
    if (outcome.ok !== true) {
      // 逐源隔离：一个源挂掉不影响另一个源
      stats.errors.push(`${plan.label} 拉取失败：${errorText(outcome.error)}`);
      stats.per_source[name] = sourceStat;
      continue;
    }
    const fetched = outcome.value;

    const items = Array.isArray(fetched?.items) ? fetched.items : [];
    // 同一轮里重复的 (source, external_id) 只保留第一条（tasks 上是 UNIQUE）
    const seen = new Set();
    const unique = [];
    for (const item of items) {
      const key = asString(item?.external_id);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    sourceStat.items = unique.length;
    if (Array.isArray(fetched?.warnings)) {
      // 真机上一门课就能刷出几十条「早于回溯窗口已跳过」；按"把数字抹平后的形状"
      // 归并，同一形状最多留 2 条，其余折成一行计数，避免面板被刷屏。
      const kept = [];
      const kindCounts = new Map();
      for (const text of fetched.warnings) {
        const kind = asString(text).replace(/\d+/g, '#');
        const seen = (kindCounts.get(kind) ?? 0) + 1;
        kindCounts.set(kind, seen);
        if (seen <= WARNING_KIND_LIMIT) kept.push(text);
      }
      sourceStat.warning_count = fetched.warnings.length;
      sourceStat.warnings = kept.slice(0, 50);
      stats.warnings.push(...kept.slice(0, 20).map((text) => `${plan.label}：${text}`));
      if (kept.length < fetched.warnings.length) {
        stats.warnings.push(`${plan.label}：另有 ${fetched.warnings.length - kept.length} 条同类提示已省略`);
      }
    }

    let changes = [];
    try {
      changes = detectChanges(unique, store.getSnapshotHashes(name));
    } catch (error) {
      stats.errors.push(`${plan.label} 变更检测失败：${errorText(error)}`);
      stats.per_source[name] = sourceStat;
      continue;
    }

    /**
     * 完成状态同步：**不受"没有变更"门禁影响**。
     * "我交了作业/报名被确认"恰恰不会改任何参与哈希的字段，如果放在门禁后面，
     * 用户永远等不到自动划掉（这正是他要的功能）。
     */
    const runSync = () => {
      const sync = syncCompletions(name, unique, store, { nowIso: utcNowIso() });
      stats.completed += sync.completed;
      stats.promoted += sync.promoted;
      sourceStat.completed = sync.completed;
      sourceStat.promoted = sync.promoted;
      for (const note of sync.notes.slice(0, 10)) stats.warnings.push(`${plan.label}：${note}`);
      return sync;
    };

    // 变更检测的真结果（重算捡回来的老素材不算"更新"，面板上分开显示）
    const freshChanges = changes.length;
    if (assessStale) {
      // 判定逻辑刚升级：这一轮抓到的素材**全部**重算一遍（即使哈希没变），外加库里快照存着、
      // 但已经落到回溯窗口之外的老素材。用户实测：`Quiz 3 Grades` 发布在窗口之外，光靠重新拉取
      // 永远看不到它，于是一直挂着旧的"活动/重要"判定；`raw_json` 是空的，所以只能靠快照还原。
      //
      // 注意：**不能写成"这一轮一条变更都没有时才重算"**——Canvas 只要有一条新公告/新作业，
      // `changes` 就是非空的，那条窗口外的老素材会被整个漏掉（真机 E2E 上踩过：`stats.rescored`
      // 只报了邮件那 3 条，`Quiz 3 Grades` 一动不动）。
      const seen = new Set();
      const rescoredChanges = unique.map((item) => {
        seen.add(keyOf(item));
        return {
          item,
          change_type: 'rescored',
          content_hash: hashItem(item),
          previous_hash: null,
          changed_fields: [...HASH_FIELDS[asString(item?.source)]],
        };
      });
      for (const snapshot of store.listSnapshots(name)) {
        const item = snapshotToItem(name, snapshot);
        if (item === null) continue;
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        rescoredChanges.push({
          item,
          change_type: 'rescored',
          content_hash: snapshot.content_hash,
          previous_hash: snapshot.content_hash,
          changed_fields: [...HASH_FIELDS[item.source]],
        });
      }
      changes = rescoredChanges;
      rescored = true;
      stats.rescored += changes.length;
    }
    // 这一轮的素材窗口已经被完整评估过（不管有没有变更）→ 可以记下判定版本了
    assessApplied = true;

    sourceStat.changes = freshChanges;
    stats.changes += freshChanges;
    if (changes.length === 0) {
      // 不变式 2：没变更就不调用 AI（但完成同步照跑，见上）
      runSync();
      stats.per_source[name] = sourceStat;
      continue;
    }

    const ruleDrafts = changes.map((change) => ({
      ...ruleAssess(change.item, { nowMs, weights: config?.scoring }),
      change_type: change.change_type,
      content_hash: change.content_hash,
    }));

    let drafts = ruleDrafts;
    let settled = new Set(changes.map((change) => `${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`));
    if (aiOn) {
      stats.ai_used = true;
      const aiResult = await scoreItems(
        changes.map((change) => ({ ...change.item, change_type: change.change_type })),
        config.ai,
        { weights, nowIso: utcNowIso(), fetchImpl: params?.fetchImpl, sleep: params?.sleep, logger },
      );
      stats.llm_calls += aiResult.calls;
      sourceStat.llm_calls = aiResult.calls;
      settled = aiResult.settled;
      stats.warnings.push(...aiResult.errors.slice(0, 10).map((text) => `${plan.label}：${text}`));
      drafts = changes.map((change, index) => {
        const key = `${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`;
        const merged = mergeDraft(ruleDrafts[index], aiResult.drafts.get(key) ?? null, {
          notBeforeMs: notBeforeMsOf(change.item),
        });
        return { ...merged, change_type: change.change_type, content_hash: change.content_hash };
      });
      sourceStat.ai_scored = drafts.filter((draft) => draft.ai_scored === true).length;
      if (settled.size === 0) {
        stats.errors.push(`${plan.label} 的 AI 评分全部失败，本轮不写快照，任务使用规则分`);
      }
    }

    // 写任务（逐条隔离）
    for (const draft of drafts) {
      try {
        store.upsertTask(finishDraft(draft, weights));
        stats.tasks += 1;
        sourceStat.tasks += 1;
      } catch (error) {
        stats.errors.push(`写入任务失败（${asString(draft.external_id)}）：${errorText(error)}`);
      }
    }

    // 写快照：只写"这一轮已经有明确结论"的素材
    const snapshotEntries = changes
      .filter((change) => settled.has(`${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`))
      .map((change) => ({
        external_id: change.item.external_id,
        course_id: change.item.course_id ?? null,
        content_hash: change.content_hash,
        payload: change.item.payload ?? {},
      }));
    if (snapshotEntries.length > 0) store.upsertSnapshots(name, snapshotEntries);

    store.recordChanges(
      changes.map((change) => ({
        source: name,
        external_id: change.item.external_id,
        change_type: change.change_type,
        diff: { hash: { from: change.previous_hash, to: change.content_hash } },
        processed: settled.has(`${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`),
      })),
      new Date(nowMs).toISOString(),
    );

    sourceStat.skipped = changes.length - snapshotEntries.length;

    // 任务已落库 → 再同步一次完成状态：本轮新写进去的记录也能在同一轮被正确勾掉，
    // 而且"报名成功"这封信与它对应的旧报名任务都能在同一批里配对。
    runSync();

    stats.per_source[name] = sourceStat;
  }

  if (assessStale && assessApplied) {
    try {
      store.setMeta(META_ASSESS_REVISION, String(ASSESS_REVISION));
    } catch (error) {
      stats.errors.push(`写入判定版本失败：${errorText(error)}`);
    }
  }

  const finishedMs = Date.now();
  stats.finished_at = new Date(finishedMs).toISOString();
  stats.duration_ms = finishedMs - nowMs;
  try {
    store.setMeta('last_poll_at', stats.finished_at);
    store.setMeta('last_poll_stats', JSON.stringify(stats));
  } catch (error) {
    stats.errors.push(`写入拉取状态失败：${errorText(error)}`);
  }
  return stats;
}

/** 设置页的"测试连接"。绝不抛异常。 */
export async function testSource(config, source, options = {}) {
  const name = asString(source);
  if (name === 'canvas') {
    if (!sqliteAvailable() && options.requireStore === true) return { ok: false, message: '当前运行时不支持 node:sqlite' };
    return testCanvas(canvasFetchConfig(config?.canvas ?? {}), options);
  }
  if (name === 'mail') return testMail(config?.mail ?? {}, options);
  if (name === 'ai') return testAi(config?.ai ?? {}, options);
  return { ok: false, message: `未知的数据源：${name}` };
}

/** 诊断用：当前数据源状态（不触发任何网络调用）。 */
export function describeSources(config) {
  const canvas = config?.canvas ?? {};
  const mail = config?.mail ?? {};
  return {
    canvas: { enabled: canvas.enabled === true, configured: canvasConfigured(canvas) },
    mail: { enabled: mail.enabled === true, configured: mailConfigured(mail), provider: asString(mail.provider) || 'imap' },
    ai: { enabled: config?.ai?.enabled === true, configured: aiConfigured(config?.ai) },
    sqlite: sqliteAvailable(),
  };
}
