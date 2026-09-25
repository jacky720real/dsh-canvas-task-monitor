#!/usr/bin/env node
/**
 * lib/canvas.js 的离线自检 fixture（零依赖，纯 Node）。
 *
 * 运行方式（工作目录必须是插件根目录）：
 *   cd <repo-root>
 *   node test/canvas-check.mjs
 *
 * 覆盖的行为：
 *  - Link header 分页（courses 2 页；assignments 2 页）；只认 rel="next"，
 *    忽略 rel="last" / rel="current"，且后续页不叠加查询参数；
 *  - 单课程 403 隔离 + warning，且该课程的公告不再发请求（与 Python 一致）；
 *  - 公告按课程逐一冗余重取（每个课程一次）；
 *  - lookback 丢弃旧作业 / 旧公告；due_at: null 与 "not-a-date" 一律保留；
 *  - 429 + Retry-After: 0 -> 真的重试且等待为 0（不能被当成假值）；
 *  - 500 -> 按 backoffBase ** attempt 退避后重试成功；
 *  - 一直 503 -> 重试耗尽后抛 `Canvas 请求重试 3 次后仍失败：<path>`，被逐课程隔离捕获；
 *  - JSON 是对象（非数组）时按单条追加；
 *  - external_id 逐字相等；due_at 与传入的原始字符串逐字节相等；
 *  - /api/v1/courses 自身失败会向上抛（不隔离）；
 *  - canvasConfigured / testCanvas（401 / 403 / 网络错误 / 成功）都不抛异常。
 *
 * 约定：注入的 sleep 只记录"重试退避"的等待（毫秒）；令牌桶也会复用它，
 * 所以本 fixture 把 rateLimitRps 设得极高，令牌桶等待恒为 10ms 的下限，
 * 断言时只采纳 0 或 >= 100ms 的等待，于是退避序列可以被精确比对。
 */

import {
  SOURCE_ASSIGNMENT,
  SOURCE_ANNOUNCEMENT,
  canvasConfigured,
  fetchCanvas,
  testCanvas,
} from '../lib/canvas.js';

const BASE = 'http://stub.local';
const NOW_MS = Date.UTC(2025, 0, 15, 0, 0, 0); // 2025-01-15T00:00:00Z
const LOOKBACK_DAYS = 30; // cutoff = 2024-12-16T00:00:00Z

/* ------------------------------------------------------------------ *
 * 断言计数
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failureLines = [];

// 防"静默早退"：如果某个 await 永远不 settle（例如超时计时器被 unref、事件循环空了），
// Node 会以退出码 0 静默退出、一行都不打印——那看起来像"通过"，实际什么都没验。
// beforeExit 只在事件循环自然排空时触发，正好用来把这个陷阱变成显式的失败。
let announced = false;
process.on('beforeExit', () => {
  if (announced) return;
  console.log('失败明细：');
  console.log('  ✗ fixture 在打印结果前就退出了（某个 await 没有 settle，事件循环被排空）');
  console.log(`passed: ${passed}  failed: ${failed + 1}`);
  process.exitCode = 1;
});

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failed += 1;
  failureLines.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function deepEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
}

function includesText(name, haystack, needle) {
  check(name, String(haystack).includes(needle), `"${haystack}" 里没有 "${needle}"`);
}

/* ------------------------------------------------------------------ *
 * 脚本化 fetch stub
 * ------------------------------------------------------------------ */

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

function route(url, ...responses) {
  return { url, responses, repeatLast: false };
}

/** 最后一个响应无限重复（用于"永远失败"的脚本）。 */
function stickyRoute(url, ...responses) {
  return { url, responses, repeatLast: true };
}

function createStubServer(routes, log) {
  return async function fetchImpl(url, init) {
    const href = String(url);
    log.push({
      url: href,
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      hasSignal: Boolean(init && init.signal),
    });
    const matched = routes.find((r) => r.url === href);
    if (!matched) throw new Error(`stub: 未预期的请求 ${href}`);
    if (matched.responses.length === 0) throw new Error(`stub: ${href} 的脚本响应已用尽`);
    if (matched.responses.length > 1 || !matched.repeatLast) return matched.responses.shift();
    return matched.responses[0];
  };
}

/* ------------------------------------------------------------------ *
 * 固定数据
 * ------------------------------------------------------------------ */

const COURSE_101 = { id: 101, name: '数据结构', course_code: 'DS101' };
const COURSE_202 = { id: 202, course_code: 'CS202' }; // 没有 name -> 落到 course_code
const COURSE_303 = { id: 303, name: '网络' }; // assignments 403
const COURSE_404 = { id: 404, code: 'CODE404' }; // 只有 code
const COURSE_NO_ID = { name: '没有 ID 的课程' };

// 作业：A1 太旧丢弃；A2 null、A3 坏串保留；A4 未来；A5 naive 旧串（按 UTC 解释）丢弃；
// A6 带 -08:00 偏移，UTC 后落在窗口内 -> 保留且字符串原样。
const A1_OLD = { id: 1, name: '作业一', due_at: '2024-12-01T00:00:00Z' };
const A2_NULL = { id: 2, name: '作业二', description: null, due_at: null, points_possible: null, submission_types: null };
const A3_BAD = { id: 3, name: '作业三', due_at: 'not-a-date', points_possible: 0, submission_types: ['online_text_entry'] };
const A4_FUTURE = {
  id: 4,
  name: '作业四',
  description: '第四章练习',
  due_at: '2099-01-01T00:00:00Z',
  points_possible: 100,
  submission_types: ['online_upload'],
};
const A5_NAIVE_OLD = { id: 5, name: '作业五', due_at: '2024-12-10T00:00:00' };
const A6_OFFSET = { id: 6, name: '作业六', due_at: '2024-12-15T20:00:00-08:00' };

const AN1_OLD = { id: 9, title: '公告一', message: '旧的', posted_at: '2024-11-01T00:00:00Z' };
const AN2_NULL = { id: 10, title: '公告二', message: null, posted_at: null };
const AN3_OFFSET = { id: 11, title: '公告三', posted_at: '2025-01-10T08:00:00+08:00' };

const ASSIGN_77_SINGLE = { id: 77, name: '单个作业', description: '', due_at: null, points_possible: null, submission_types: null };
const ANNOUNCE_88_SINGLE = { id: 88, title: '单个公告', message: null, posted_at: '2025-01-05T00:00:00Z' };
const ASSIGN_55_CODE404 = { id: 55, name: '作业X', due_at: null };

const URLS = {
  coursesP1: `${BASE}/api/v1/courses?enrollment_state=active&per_page=100`,
  coursesP2: `${BASE}/api/v1/courses?page=2`,
  probe: `${BASE}/api/v1/courses?enrollment_state=active&per_page=1`,
  assignments101: `${BASE}/api/v1/courses/101/assignments?per_page=100`,
  assignments101P2: `${BASE}/api/v1/courses/101/assignments?per_page=100&page=2`,
  assignments101Last: `${BASE}/api/v1/courses/101/assignments?per_page=100&page=9`,
  announcements101: `${BASE}/api/v1/announcements?context_codes[]=course_101&per_page=100`,
  assignments202: `${BASE}/api/v1/courses/202/assignments?per_page=100`,
  announcements202: `${BASE}/api/v1/announcements?context_codes[]=course_202&per_page=100`,
  assignments303: `${BASE}/api/v1/courses/303/assignments?per_page=100`,
  announcements303: `${BASE}/api/v1/announcements?context_codes[]=course_303&per_page=100`,
  assignments404: `${BASE}/api/v1/courses/404/assignments?per_page=100`,
  announcements404: `${BASE}/api/v1/announcements?context_codes[]=course_404&per_page=100`,
};

function buildRoutes() {
  return [
    // 课程分页：第 1 页给出 next（同时带一个 rel="last" 段，考验逗号切分）。
    route(
      URLS.coursesP1,
      jsonResponse(200, [COURSE_101, COURSE_202], {
        Link: `<${URLS.coursesP2}>; rel="next", <${URLS.coursesP2}>; rel="last"`,
      }),
    ),
    // 第 2 页只有 rel="current"，不得继续翻页。
    route(URLS.coursesP2, jsonResponse(200, [COURSE_303, COURSE_404, COURSE_NO_ID], {
      Link: `<${URLS.coursesP2}>; rel="current"`,
    })),

    // 101 作业：先 429（Retry-After: 0）再成功；next 段故意排在 rel="last" 之后。
    stickyRoute(
      URLS.assignments101,
      jsonResponse(429, { errors: ['rate limited'] }, { 'Retry-After': '0' }),
      jsonResponse(200, [A1_OLD, A2_NULL, A3_BAD], {
        Link: `<${URLS.assignments101Last}>; rel="last", <${URLS.assignments101P2}>; rel="next"`,
      }),
    ),
    route(URLS.assignments101P2, jsonResponse(200, [A4_FUTURE, A5_NAIVE_OLD, A6_OFFSET])),

    // 101 公告：先 500（无 Retry-After）再成功。
    stickyRoute(
      URLS.announcements101,
      jsonResponse(500, { errors: ['boom'] }),
      jsonResponse(200, [AN1_OLD, AN2_NULL, AN3_OFFSET]),
    ),

    // 202：两类请求返回的 JSON 都是对象而不是数组 -> 各自按单条追加。
    route(URLS.assignments202, jsonResponse(200, ASSIGN_77_SINGLE)),
    route(URLS.announcements202, jsonResponse(200, ANNOUNCE_88_SINGLE)),

    // 303：作业 403 -> 该课程被隔离（且不再请求它的公告）。
    route(URLS.assignments303, jsonResponse(403, { errors: ['forbidden'] })),
    route(URLS.announcements303, jsonResponse(200, [])),

    // 404：作业成功，公告一直 503 -> 三次尝试后抛错；作业条目必须已经留下。
    route(URLS.assignments404, jsonResponse(200, [ASSIGN_55_CODE404])),
    stickyRoute(
      URLS.announcements404,
      jsonResponse(503, { errors: ['unavailable'] }),
      jsonResponse(503, { errors: ['unavailable'] }),
      jsonResponse(503, { errors: ['unavailable'] }),
    ),
  ];
}

function makeHarness() {
  const log = [];
  const waits = [];
  const stub = createStubServer(buildRoutes(), log);
  const options = {
    fetchImpl: stub,
    now: () => NOW_MS,
    logger: null,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  const config = {
    baseUrl: BASE,
    token: 'test-token',
    lookbackDays: LOOKBACK_DAYS,
    timeoutSeconds: 20,
    rateLimitRps: 1000000,
    retry: { maxAttempts: 3, backoffBase: 1.5 },
  };
  return { log, waits, options, config };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  await sleepMs(0);

  const { log, waits, options, config } = makeHarness();
  const result = await fetchCanvas(config, options);
  const { items, warnings, courses } = result;
  const byId = (externalId) => items.find((item) => item.external_id === externalId);

  /* --- 请求序列 ------------------------------------------------- */
  const expectedUrls = [
    URLS.coursesP1,
    URLS.coursesP2,
    URLS.assignments101, // 429
    URLS.assignments101, // 重试成功
    URLS.assignments101P2,
    URLS.announcements101, // 500
    URLS.announcements101, // 重试成功
    URLS.assignments202,
    URLS.announcements202,
    URLS.assignments303,
    URLS.assignments404,
    URLS.announcements404, // 503
    URLS.announcements404, // 503
    URLS.announcements404, // 503 -> 抛错
  ];
  deepEq('请求序列逐条相等（含分页/重试/逐课程公告）', log.map((e) => e.url), expectedUrls);

  check(
    '分页第 2 页不再叠加查询参数（next URL 自带查询串）',
    log[1].url === URLS.coursesP2 && !log[1].url.includes('enrollment_state'),
    log[1].url,
  );
  check(
    '只跟随 rel="next"（未被排在前面的 rel="last" 带偏）',
    log[4].url === URLS.assignments101P2,
    log[4].url,
  );
  check('rel="current" 不被跟随（courses 只翻了 2 页）', log.length === 14, `实际 ${log.length} 次请求`);
  check(
    '每个请求都带 Bearer token 与 Accept: application/json',
    log.every((e) => e.headers.Authorization === 'Bearer test-token' && e.headers.Accept === 'application/json'),
    JSON.stringify(log[0].headers),
  );
  check('每个请求都是 GET', log.every((e) => e.method === 'GET'));

  const announcementsFor = (courseId) => log.filter((e) => e.url.includes(`context_codes[]=course_${courseId}`)).length;
  eq('公告按课程逐一冗余重取：101 命中 2 次（含 500 重试）', announcementsFor(101), 2);
  eq('公告按课程逐一冗余重取：202 命中 1 次', announcementsFor(202), 1);
  eq('公告按课程逐一冗余重取：404 命中 3 次（503 全败）', announcementsFor(404), 3);
  eq('303 的公告一次都不请求（作业失败后该课程整体跳过）', announcementsFor(303), 0);

  /* --- 重试退避 ------------------------------------------------- */
  const retryWaits = waits.filter((ms) => ms === 0 || ms >= 100);
  deepEq(
    '退避序列：Retry-After: 0 -> 0ms；500 -> 1.5^1；503 -> 1.5^1 与 1.5^2',
    retryWaits,
    [0, 1500, 1500, 2250],
  );
  eq('Retry-After: 0 被当成真值（确实 sleep 了一次 0ms）', waits.filter((ms) => ms === 0).length, 1);
  check('最后一次尝试之后不再 sleep', retryWaits.length === 4);

  /* --- items ---------------------------------------------------- */
  deepEq('external_id 序列逐字相等', items.map((i) => i.external_id), [
    'course:101:assignment:2',
    'course:101:assignment:3',
    'course:101:assignment:4',
    'course:101:assignment:6',
    'course:101:announcement:10',
    'course:101:announcement:11',
    'course:202:assignment:77',
    'course:202:announcement:88',
    'course:404:assignment:55',
  ]);
  eq('items 总数', items.length, 9);
  deepEq(
    'source 只有两种取值',
    [...new Set(items.map((i) => i.source))].sort(),
    [SOURCE_ANNOUNCEMENT, SOURCE_ASSIGNMENT],
  );
  check(
    '旧的作业/公告（A1 / A5 / AN1）确实被 lookback 丢弃',
    !byId('course:101:assignment:1') && !byId('course:101:assignment:5') && !byId('course:101:announcement:9'),
  );

  const a2 = byId('course:101:assignment:2');
  const a3 = byId('course:101:assignment:3');
  const a4 = byId('course:101:assignment:4');
  const a6 = byId('course:101:assignment:6');
  const an2 = byId('course:101:announcement:10');
  const an3 = byId('course:101:announcement:11');

  eq('due_at: null 原样保留为 null', a2.payload.due_at, null);
  check('due_at 缺失归一为 null', byId('course:202:assignment:77').payload.due_at === null);
  eq('due_at: "not-a-date" 原样保留（解析失败不丢弃）', a3.payload.due_at, 'not-a-date');
  check('due_at 与原始字符串逐字节相等（Z 结尾）', a4.payload.due_at === '2099-01-01T00:00:00Z', a4.payload.due_at);
  check(
    'due_at 与原始字符串逐字节相等（-08:00 偏移）',
    a6.payload.due_at === '2024-12-15T20:00:00-08:00',
    a6.payload.due_at,
  );
  check('posted_at 与原始字符串逐字节相等（+08:00 偏移）', an3.payload.posted_at === '2025-01-10T08:00:00+08:00', an3.payload.posted_at);
  eq('posted_at: null 原样保留为 null', an2.payload.posted_at, null);

  eq('points_possible 原样透传（100）', a4.payload.points_possible, 100);
  eq('points_possible 原样透传（0 不能被当成空值）', a3.payload.points_possible, 0);
  eq('points_possible: null 保持 null', a2.payload.points_possible, null);
  deepEq('submission_types 原样数组', a4.payload.submission_types, ['online_upload']);
  deepEq('submission_types: null -> []', a2.payload.submission_types, []);
  eq('description: null -> ""', a2.payload.description, '');
  eq('description 缺失 -> ""', a3.payload.description, '');
  eq('description 有值 -> 原样', a4.payload.description, '第四章练习');
  eq('message: null -> ""', an2.payload.message, '');
  eq('course_id 是字符串', a4.course_id, '101');
  eq('course_name 取 course.name', a4.payload.course_name, '数据结构');
  eq('course_name 回退到 course_code', byId('course:202:assignment:77').payload.course_name, 'CS202');
  eq('course_name 回退到 code', byId('course:404:assignment:55').payload.course_name, 'CODE404');
  eq('作业 payload 只含约定的 6 个键', Object.keys(a4.payload).join(','), 'name,description,due_at,points_possible,submission_types,course_name');
  eq('公告 payload 只含约定的 4 个键', Object.keys(an3.payload).join(','), 'title,message,posted_at,course_name');
  eq('单对象响应的公告 id 正常', byId('course:202:announcement:88').external_id, 'course:202:announcement:88');

  /* --- courses / warnings --------------------------------------- */
  eq('courses 是分页拉到的原始课程对象', courses.length, 5);
  eq('courses 保留原始字段', courses[0].course_code, 'DS101');

  eq('warnings 条数', warnings.length, 6);
  check(
    '403 被隔离且写进 warnings（含状态码）',
    warnings.some((w) => w.includes('课程 303') && w.includes('403')),
    JSON.stringify(warnings),
  );
  check(
    '重试耗尽的错误文本符合约定',
    warnings.some((w) => w.includes('Canvas 请求重试 3 次后仍失败：/api/v1/announcements')),
    JSON.stringify(warnings),
  );
  check('404 的作业条目在公告失败前已保留', Boolean(byId('course:404:assignment:55')));
  eq('lookback 丢弃写入 warnings 的条数', warnings.filter((w) => w.includes('早于回溯窗口')).length, 3);
  check('缺少 id 的课程被跳过并告警', warnings.some((w) => w.includes('缺少 id') && w.includes('没有 ID 的课程')));

  /* --- canvasConfigured ----------------------------------------- */
  eq('canvasConfigured：齐全 -> true', canvasConfigured({ baseUrl: BASE, token: 't' }), true);
  eq('canvasConfigured：空 token -> false', canvasConfigured({ baseUrl: BASE, token: '' }), false);
  eq('canvasConfigured：缺 baseUrl -> false', canvasConfigured({ token: 't' }), false);
  eq('canvasConfigured：token 非字符串 -> false', canvasConfigured({ baseUrl: BASE, token: 123 }), false);
  eq('canvasConfigured：null -> false', canvasConfigured(null), false);
  eq('canvasConfigured：undefined -> false', canvasConfigured(undefined), false);

  /* --- /courses 自身失败要向上抛 --------------------------------- */
  {
    const log2 = [];
    const stub = createStubServer([route(URLS.coursesP1, jsonResponse(403, { errors: ['forbidden'] }))], log2);
    let thrown = null;
    try {
      await fetchCanvas(config, { ...options, fetchImpl: stub });
    } catch (err) {
      thrown = err;
    }
    check('课程列表 403 时 fetchCanvas 向上抛出', Boolean(thrown), '没有抛出');
    if (thrown) includesText('课程列表失败的报错含状态码与响应片段', thrown.message, '403');
  }

  /* --- testCanvas ----------------------------------------------- */
  const probeUrl = URLS.probe;
  {
    const log3 = [];
    const stub = createStubServer([route(probeUrl, jsonResponse(200, [{ id: 1, name: '数据结构' }]))], log3);
    const res = await testCanvas({ baseUrl: BASE, token: 'test-token' }, { fetchImpl: stub, logger: null });
    eq('testCanvas 探测 URL', log3[0] ? log3[0].url : '(未发请求)', probeUrl);
    eq('testCanvas 成功 -> ok', res.ok, true);
    eq('testCanvas 成功 -> 中文提示', res.message, '连接成功，检测到 1 门进行中的课程');
    check('testCanvas 成功 -> 带 detail', typeof res.detail === 'string');
  }
  {
    const stub = createStubServer([route(probeUrl, jsonResponse(401, { errors: ['Invalid access token'] }))], []);
    const res = await testCanvas({ baseUrl: BASE, token: 'bad' }, { fetchImpl: stub, logger: null });
    eq('testCanvas 401 -> ok=false', res.ok, false);
    check('testCanvas 401 -> 提示 token 失效', /令牌/.test(res.message) && /过期|无效/.test(res.message), res.message);
  }
  {
    const stub = createStubServer([route(probeUrl, jsonResponse(403, { errors: ['forbidden'] }))], []);
    const res = await testCanvas({ baseUrl: BASE, token: 't' }, { fetchImpl: stub, logger: null });
    eq('testCanvas 403 -> ok=false', res.ok, false);
    check('testCanvas 403 -> 提示无权限', /权限/.test(res.message), res.message);
  }
  {
    const stub = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await testCanvas({ baseUrl: BASE, token: 't' }, { fetchImpl: stub, logger: null });
    eq('testCanvas 网络错误 -> ok=false', res.ok, false);
    includesText('testCanvas 网络错误 -> 带上原始错误文本', res.message, 'fetch failed');
  }
  {
    const res = await testCanvas({ baseUrl: BASE, token: '' }, { logger: null });
    eq('testCanvas 未配置 -> ok=false', res.ok, false);
    check('testCanvas 未配置 -> 不抛异常且有中文提示', /未配置/.test(res.message), res.message);
  }
  {
    // 所有分支都不许抛异常：包括 fetchImpl 同步抛、baseUrl 非法。
    const thrower = () => {
      throw new Error('同步炸了');
    };
    let threw = false;
    let res = null;
    try {
      res = await testCanvas({ baseUrl: BASE, token: 't', rateLimitRps: 0 }, { fetchImpl: thrower, logger: null });
    } catch {
      threw = true;
    }
    eq('testCanvas 绝不抛出（即使配置非法）', threw, false);
    eq('testCanvas 非法配置也返回 ok=false', res && res.ok, false);
  }

  /* --- 配置键别名（宿主 lib/config.js 的 canvas 段形状） ---------- */
  {
    // lib/config.js 产出的是 { timeoutMs, maxAttempts, requestsPerSecond }。
    // 契约键优先，但这些别名必须能被兜底识别，否则宿主直接透传会静默用默认值。
    const log4 = [];
    const waits4 = [];
    const stub = createStubServer([stickyRoute(URLS.coursesP1, jsonResponse(500, { e: 1 }))], log4);
    let thrown = null;
    try {
      await fetchCanvas(
        { baseUrl: BASE, token: 't', timeoutMs: 5000, maxAttempts: 2, requestsPerSecond: 1000000 },
        { fetchImpl: stub, now: () => NOW_MS, logger: null, sleep: (ms) => { waits4.push(ms); return Promise.resolve(); } },
      );
    } catch (err) {
      thrown = err;
    }
    check('别名形状：顶层 maxAttempts=2 被识别（报错文本写的是 2 次）', Boolean(thrown) && thrown.message.includes('Canvas 请求重试 2 次后仍失败'), thrown && thrown.message);
    deepEq('别名形状：maxAttempts=2 -> 只在第 1 次之后退避一次（默认 3 次会多一次 2250）', waits4, [1500]);

    // requestsPerSecond 别名：故意给非法值 0（与 Python TokenBucket 一致，速率 <= 0 会抛）。
    // 别名被读取 -> 探测返回 ok=false；别名被忽略（回落默认 3 rps）-> 请求成功、ok=true。
    const okStub = createStubServer([stickyRoute(URLS.probe, jsonResponse(200, []))], []);
    const aliasRate = await testCanvas(
      { baseUrl: BASE, token: 't', requestsPerSecond: 0 },
      { fetchImpl: okStub, logger: null },
    );
    eq('别名形状：requestsPerSecond 被识别（0 触发令牌桶校验）', aliasRate.ok, false);
    const defaultRate = await testCanvas(
      { baseUrl: BASE, token: 't' },
      { fetchImpl: createStubServer([stickyRoute(URLS.probe, jsonResponse(200, []))], []), logger: null },
    );
    eq('对照：不写别名时同样的探测请求成功', defaultRate.ok, true);

    // timeoutMs 必须按毫秒解释：给它 30ms。这里的 fetch 桩既不 resolve 也**不理 signal**，
    // 所以超时只能靠 makeTimeout 的 race 兜底；若把 30 当成秒，本断言会挂到超时而不是 30ms。
    const startedAt = Date.now();
    const neverFetch = () => new Promise(() => {});
    const timedOut = await testCanvas(
      { baseUrl: BASE, token: 't', timeoutMs: 30 },
      { fetchImpl: neverFetch, logger: null },
    );
    const elapsedMs = Date.now() - startedAt;
    eq('别名形状：timeoutMs 超时后 testCanvas 仍不抛异常', timedOut.ok, false);
    includesText('别名形状：超时报文来自本模块的计时器', timedOut.message, 'Canvas 请求超时（30ms）');
    check('别名形状：timeoutMs 按毫秒使用（30ms 而非 30s）', elapsedMs < 2000, `实际 ${elapsedMs}ms`);
  }

  /* --- 结果 ------------------------------------------------------ */
  if (failureLines.length) {
    console.log('失败明细：');
    for (const line of failureLines) console.log(line);
  }
  announced = true;
  console.log(`passed: ${passed}  failed: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  announced = true;
  console.log('fixture 自身崩了：', err && err.stack ? err.stack : err);
  console.log(`passed: ${passed}  failed: ${failed + 1}`);
  process.exitCode = 1;
});
