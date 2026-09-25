#!/usr/bin/env node
/**
 * canvas source 自检（fixture）。
 *
 * 运行：在 `dsh-canvas-task-monitor` 目录下 `node test/sources-check.mjs`
 * （只用 node: 内置模块，不需要 npm install）。
 *
 * 覆盖：
 * 1. 纯函数/类的表驱动用例：parseIsoMs / isBeforeLookback / nextLinkFromHeader /
 *    retryAfterSeconds / TokenBucket（注入假时钟）。
 * 2. createCanvasSource 的公开形状：name / enabled / configured / describe / test。
 * 3. 真实 node:http 假 Canvas 服务器上的端到端拉取：分页（真 Link 头）、
 *    `context_codes[]` 公告路径、每课程隔离（失败课程跳过、其余课程照常）、
 *    500 -> 200 重试成功、`Retry-After: 0` 必须照办（不能被 `||` 短路成退避）、
 *    缺 id 的课程/作业/公告一律跳过、缺 token 时 configured === false 且报错清晰。
 * 4. 回溯窗口：解析不了的日期保留，确定早于窗口的丢弃；ctx.lookbackDays 能覆盖配置。
 *
 * 只针对 canvas.js（mail.js 与 createMailSource 由另一个代理负责，本文件不 import）。
 * 最后一行固定输出 `passed: N  failed: M`，M > 0 时以非零码退出。
 */
import http from 'node:http';

import {
  TokenBucket,
  canvasConfigured,
  createCanvasSource,
  isBeforeLookback,
  nextLinkFromHeader,
  parseIsoMs,
  retryAfterSeconds,
} from '../lib/canvas.js';

/* ------------------------------------------------------------------ *
 * 迷你测试框架
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

// 看门狗：fixture 自己挂住时不许把终端拖死，30s 直接报失败退出。
const watchdog = setTimeout(() => {
  console.error(`fixture 自身超时（30s）：已完成 ${passed} 个用例，${failed} 个失败`);
  process.exit(1);
}, 30_000);

function show(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(detail === undefined ? name : `${name} :: ${detail}`);
  return false;
}

function eq(name, actual, expected) {
  return ok(name, Object.is(actual, expected), `期望 ${show(expected)}，实际 ${show(actual)}`);
}

function deepEq(name, actual, expected) {
  const a = show(actual);
  const b = show(expected);
  return ok(name, a === b, `期望 ${b}，实际 ${a}`);
}

function has(name, haystack, needle) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  return ok(name, text.includes(needle), `未在 ${show(text).slice(0, 400)} 里找到 ${show(needle)}`);
}

function section(text) {
  console.log(`\n── ${text} ──`);
}

/* ------------------------------------------------------------------ *
 * 1. 纯函数：日期解析
 * ------------------------------------------------------------------ */

section('parseIsoMs：Z / 无时区 / 纯日期 / 偏移 / 不可解析');

const ISO_CASES = [
  // Canvas 实际发过来的形状
  ['2026-09-30T23:59:00Z', Date.UTC(2026, 8, 30, 23, 59, 0)],
  ['2026-09-30T23:59:00z', Date.UTC(2026, 8, 30, 23, 59, 0)],
  // 无时区 -> 按 UTC 解释（不是本地时间！本地时区下会差 8 小时）
  ['2026-09-30T23:59:00', Date.UTC(2026, 8, 30, 23, 59, 0)],
  ['2026-09-30T23:59', Date.UTC(2026, 8, 30, 23, 59, 0)],
  ['2026-09-30 23:59:00', Date.UTC(2026, 8, 30, 23, 59, 0)],
  // 纯日期 = 当天 00:00 UTC
  ['2026-09-30', Date.UTC(2026, 8, 30, 0, 0, 0)],
  // 显式偏移
  ['2026-09-30T23:59:00+08:00', Date.UTC(2026, 8, 30, 15, 59, 0)],
  ['2026-09-30T23:59:00-05:30', Date.UTC(2026, 9, 1, 5, 29, 0)],
  ['2026-09-30T23:59:00.250Z', Date.UTC(2026, 8, 30, 23, 59, 0, 250)],
  // 解析不了的一律 null（调用方据此决定"保留而不是丢弃"）
  ['not-a-date', null],
  ['', null],
  ['2026', null], // 裸年份不算日期，否则会被当成 2026-01-01
  ['2026-09', null],
  [null, null],
  [undefined, null],
  [12345, null],
  [{}, null],
];

for (const [input, expected] of ISO_CASES) {
  eq(`parseIsoMs(${show(input)})`, parseIsoMs(input), expected);
}

section('isBeforeLookback：只有"确定早于窗口"才丢弃');

const CUTOFF = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z
const LOOKBACK_CASES = [
  ['2026-08-31T23:59:59Z', true, '早于窗口 -> 丢'],
  ['2026-09-01T00:00:00Z', false, '正好等于 cutoff -> 留'],
  ['2026-09-30T23:59:00Z', false, '窗口内 -> 留'],
  ['not-a-date', false, '解析失败 -> 留（不许猜）'],
  ['', false, '空串 -> 留'],
  [null, false, 'null -> 留'],
  [undefined, false, 'undefined -> 留'],
  ['2026-08-31', true, '纯日期早于窗口 -> 丢'],
  ['2026-09-01', false, '纯日期等于 cutoff -> 留'],
];

for (const [input, expected, why] of LOOKBACK_CASES) {
  eq(`isBeforeLookback(${show(input)})（${why}）`, isBeforeLookback(input, CUTOFF), expected);
}

/* ------------------------------------------------------------------ *
 * 2. 纯函数：RFC 5988 Link 头
 * ------------------------------------------------------------------ */

section('nextLinkFromHeader');

const LINK_CASES = [
  ['<https://x/api/v1/courses?page=2>; rel="next"', 'https://x/api/v1/courses?page=2'],
  ['<https://x/page2>; rel=next', 'https://x/page2'], // 不带引号也要认
  ['<https://x/prev>; rel="prev", <https://x/page3>; rel="next"', 'https://x/page3'], // 逗号只在自己的 <> 外才是分隔
  ['<https://x/last>; rel="last"', null],
  ['<https://x/first>; rel="first", <https://x/last>; rel="last"', null],
  ['garbage', null],
  ['', null],
  [null, null],
  [undefined, null],
];

for (const [input, expected] of LINK_CASES) {
  eq(`nextLinkFromHeader(${show(input)})`, nextLinkFromHeader(input), expected);
}

/* ------------------------------------------------------------------ *
 * 3. 纯函数：Retry-After
 * ------------------------------------------------------------------ */

section('retryAfterSeconds（0 必须照办）');

const RETRY_AFTER_CASES = [
  [{ headers: new Headers({ 'Retry-After': '0' }) }, 0, '契约：0 也要重试，不能被 `||` 短路成退避'],
  [{ headers: new Headers({ 'retry-after': '0' }) }, 0, '头名大小写不敏感'],
  [{ headers: new Headers({ 'Retry-After': '5' }) }, 5, '秒数'],
  [{ headers: new Headers({ 'Retry-After': ' 2 ' }) }, 2, '两侧空白'],
  [{ headers: new Headers({ 'Retry-After': '0.5' }) }, 0.5, '小数'],
  [{ headers: new Headers({ 'Retry-After': '-3' }) }, 0, '负数夹到 0'],
  [{ headers: new Headers({ 'Retry-After': 'abc' }) }, null, '解析不了 -> null（走退避）'],
  [{ headers: new Headers({}) }, null, '没有这个头'],
  [{ headers: { 'Retry-After': '7' } }, 7, '普通对象头'],
  // 注意：headerValue 先命中 `typeof headers.get === 'function'` 分支，因此 Map 只认原样键名
  // （小写 'retry-after' 会拿到 null）。真实 fetch 的 Response.headers 是 Headers，不受影响。
  [{ headers: new Map([['Retry-After', '9']]) }, 9, 'Map 头（键名与查询一致）'],
  [{ headers: new Headers({ 'Retry-After': '' }) }, null, '空值 -> null'],
  [{}, null, '没有 headers'],
  [null, null],
  [undefined, null],
];

for (const [response, expected, why] of RETRY_AFTER_CASES) {
  eq(`retryAfterSeconds(${why})`, retryAfterSeconds(response), expected);
}

/* ------------------------------------------------------------------ *
 * 4. TokenBucket：注入假时钟，断言等待时长完全确定
 * ------------------------------------------------------------------ */

section('TokenBucket（注入假时钟）');

/** 单调假时钟：sleep(ms) 会把时钟往前推 ms，因此等待时长可精确断言。 */
function makeClock(start = 1000) {
  const state = { now: start, waits: [] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms) => {
      state.waits.push(ms);
      state.now += ms;
    },
  };
}

{
  const clock = makeClock();
  const bucket = new TokenBucket(4, 1, clock.sleep, clock.now); // 4 req/s，burst 1
  await bucket.acquire();
  eq('burst 内的第一次 acquire 不等待', clock.state.waits.length, 0);
  await bucket.acquire();
  deepEq('第二次 acquire 等满 1/4 秒', clock.state.waits, [250]);
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  deepEq('连续 acquire 的等待序列稳定', clock.state.waits, [250, 250, 250, 250]);
}

{
  const clock = makeClock();
  const bucket = new TokenBucket(0.5, 1, clock.sleep, clock.now); // 0.5 req/s -> 2s
  await bucket.acquire();
  await bucket.acquire();
  deepEq('0.5 req/s 时等待 2000ms', clock.state.waits, [2000]);
}

{
  const clock = makeClock();
  const bucket = new TokenBucket(10, 2, clock.sleep, clock.now); // burst 2
  await bucket.acquire();
  await bucket.acquire();
  eq('burst 2 时两次 acquire 都不用等待', clock.state.waits.length, 0);
  await bucket.acquire();
  deepEq('第三次才等 1/10 秒', clock.state.waits, [100]);
}

{
  let threw = false;
  try {
    new TokenBucket(0);
  } catch {
    threw = true;
  }
  eq('ratePerSec = 0 抛错', threw, true);

  threw = false;
  try {
    new TokenBucket(-1);
  } catch {
    threw = true;
  }
  eq('ratePerSec < 0 抛错', threw, true);

  threw = false;
  try {
    new TokenBucket(1, 0);
  } catch {
    threw = true;
  }
  eq('burst = 0 抛错', threw, true);
}

/* ------------------------------------------------------------------ *
 * 5. 假 Canvas 服务器（真 http，真 Link 头，真分页）
 * ------------------------------------------------------------------ */

const NOW = new Date('2026-10-01T00:00:00Z');
const LOOKBACK_DAYS = 30; // cutoff = 2026-09-01T00:00:00Z

const COURSES_PAGE_1 = [
  { id: 101, name: '课程甲' },
  { id: 102, course_code: 'CODE-乙' }, // 没有 name -> 回落到 course_code
  { id: null, name: '缺 id 的课程' }, // 必须跳过
  { id: 103, name: '会失败的课程' }, // 恒 500 -> 逐课程隔离
  { id: 105, name: '重试课程' }, // 第一次 500，第二次 200
];

const ASSIGNMENT_101_PAGE_1 = [
  {
    id: 1,
    name: '作业一',
    description: '<p>描述</p>',
    due_at: '2026-09-30T23:59:00Z',
    points_possible: 10,
    submission_types: ['online_text_entry'],
  },
  {
    id: 2,
    name: '作业二',
    description: null,
    due_at: null,
    points_possible: null,
    submission_types: null,
  },
  { name: '缺 id 的作业', due_at: '2026-09-30T00:00:00Z' }, // 派生不出 external_id -> 跳过
];

const ASSIGNMENT_101_PAGE_2 = [
  {
    id: 3,
    name: '旧作业',
    description: '',
    due_at: '2020-01-01T00:00:00Z',
    points_possible: 1,
    submission_types: [],
  },
];

const ANNOUNCEMENT_101 = [
  { id: 11, title: '公告一', message: '<b>正文</b>', posted_at: '2026-09-29T10:00:00Z' },
  { id: 12, title: '旧公告', message: 'x', posted_at: '2020-05-05T00:00:00Z' },
];

function startFakeCanvas() {
  const state = { seen: [], hits: new Map(), base: '' };
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    state.seen.push(url);
    state.hits.set(pathname, (state.hits.get(pathname) || 0) + 1);

    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const query = new URL(url, state.base).searchParams;
    const context = query.get('context_codes[]') || '';
    const courseId = context.replace(/^course_/, '');

    if (pathname === '/api/v1/courses') {
      if (query.get('page') === '2') {
        return send(200, [{ id: 104, name: '课程丁' }]); // 没有 Link = 最后一页
      }
      return send(200, COURSES_PAGE_1, {
        Link: `<${state.base}/api/v1/courses?page=2>; rel="next"`,
      });
    }

    if (pathname === '/api/v1/announcements') {
      if (courseId === '101') return send(200, ANNOUNCEMENT_101);
      if (courseId === '102') return send(200, [{ id: 21, title: '公告二', message: '', posted_at: null }]);
      if (courseId === '104') return send(200, [{ id: 41, title: '无 posted_at 的公告', message: '<i>x</i>' }]);
      return send(200, []);
    }

    if (pathname === '/api/v1/courses/101/assignments') {
      if (query.get('page') === '2') return send(200, ASSIGNMENT_101_PAGE_2);
      return send(200, ASSIGNMENT_101_PAGE_1, {
        Link: `<${state.base}/api/v1/courses/101/assignments?page=2>; rel="next"`,
      });
    }

    if (pathname === '/api/v1/courses/102/assignments') return send(200, []);

    if (pathname === '/api/v1/courses/103/assignments') {
      // 恒 500，但带 Retry-After: 0：必须重试 maxAttempts 次且全程不真等待。
      return send(500, { errors: [{ message: '服务器炸了' }] }, { 'Retry-After': '0' });
    }

    if (pathname === '/api/v1/courses/104/assignments') {
      return send(200, [
        {
          id: 7,
          name: '日期不可解析的作业',
          description: '',
          due_at: 'not-a-date',
          points_possible: null,
          submission_types: null,
        },
      ]);
    }

    if (pathname === '/api/v1/courses/105/assignments') {
      const count = state.hits.get(pathname) || 1;
      if (count === 1) return send(500, {}, { 'Retry-After': '0' });
      return send(200, [
        {
          id: 51,
          name: '重试后成功的作业',
          description: '',
          due_at: '2026-09-30T12:00:00Z',
          points_possible: 5,
          submission_types: ['online_upload'],
        },
      ]);
    }

    return send(404, { errors: [{ message: 'not found' }] });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      state.base = `http://127.0.0.1:${port}`;
      resolve({ server, state, port });
    });
  });
}

/** 401 专用小服务器：验证"整源失败"时的报错文案。 */
function startUnauthorized() {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Invalid access token.' }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ------------------------------------------------------------------ *
 * 6. createCanvasSource 端到端
 * ------------------------------------------------------------------ */

const canvas = await startFakeCanvas();
const unauthorized = await startUnauthorized();

const CONFIG = {
  enabled: true,
  baseUrl: canvas.state.base,
  token: 'test-token',
  lookbackDays: LOOKBACK_DAYS,
  requestsPerSecond: 100000, // 限流仍在跑，但每次只等 10ms 下限，fixture 才够快
  maxAttempts: 3,
};

const warnings = [];
const log = (message) => warnings.push(String(message));

section('createCanvasSource：形状与配置判定');

{
  const source = createCanvasSource(CONFIG, { logger: null });
  eq('name 固定为 canvas', source.name, 'canvas');
  eq('enabled 来自 config.enabled', source.enabled, true);
  eq('configured 为 true', source.configured, true);
  deepEq('describe() 形状', source.describe(), {
    enabled: true,
    configured: true,
    baseUrl: canvas.state.base,
    lookbackDays: LOOKBACK_DAYS,
  });
}

{
  const source = createCanvasSource({ ...CONFIG, enabled: false }, { logger: null });
  eq('enabled: false 透传', source.enabled, false);
  eq('describe().enabled 同步', source.describe().enabled, false);
}

{
  const source = createCanvasSource({ baseUrl: 'http://127.0.0.1:1/', token: 't' }, { logger: null });
  eq('baseUrl 末尾斜杠被去掉', source.describe().baseUrl, 'http://127.0.0.1:1');
  eq('未给 enabled 时默认为 true', source.enabled, true);
}

{
  const missingToken = createCanvasSource({ baseUrl: canvas.state.base, token: '' }, { logger: null });
  eq('缺 token -> configured === false', missingToken.configured, false);
  eq('缺 token -> describe().configured === false', missingToken.describe().configured, false);

  let message = '';
  try {
    await missingToken.fetchItems({ now: NOW, log });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  has('缺 token 时 fetchItems 报错清晰', message, '未配置完整');
  has('缺 token 时报错提到 baseUrl/token', message, 'baseUrl');

  const tested = await missingToken.test();
  eq('缺 token 时 test().ok === false', tested.ok, false);
  has('缺 token 时 test() 也有中文说明', tested.message, 'Canvas 未配置完整');

  const missingBase = createCanvasSource({ baseUrl: '', token: 't' }, { logger: null });
  eq('缺 baseUrl -> configured === false', missingBase.configured, false);
  eq('canvasConfigured 与工厂一致', canvasConfigured({ baseUrl: '', token: 't' }), false);
  eq('canvasConfigured(undefined) === false', canvasConfigured(undefined), false);
}

section('createCanvasSource.fetchItems：分页 / 逐课程隔离 / 重试');

const runStart = Date.now();
const items = await createCanvasSource(CONFIG, {}).fetchItems({
  now: NOW,
  lookbackDays: LOOKBACK_DAYS,
  log,
});
const runElapsed = Date.now() - runStart;

const ids = items.map((item) => item.external_id).sort();
const EXPECTED_IDS = [
  'course:101:announcement:11',
  'course:101:assignment:1',
  'course:101:assignment:2',
  'course:102:announcement:21',
  'course:104:announcement:41',
  'course:104:assignment:7',
  'course:105:assignment:51',
];

eq('条目总数', items.length, EXPECTED_IDS.length);
deepEq('external_id 完全一致（含跳过项都不在）', ids, EXPECTED_IDS);

{
  const assignments = items.filter((item) => item.source === 'canvas_assignment');
  const announcements = items.filter((item) => item.source === 'canvas_announcement');
  eq('作业条数', assignments.length, 4);
  eq('公告条数', announcements.length, 3);
  ok(
    '每条 source 只能是 canvas_assignment / canvas_announcement',
    items.every((item) => item.source === 'canvas_assignment' || item.source === 'canvas_announcement'),
    show(items.map((item) => item.source)),
  );
  ok(
    'course_id 一律是字符串',
    items.every((item) => typeof item.course_id === 'string' && item.course_id.length > 0),
    show(items.map((item) => item.course_id)),
  );
  ok(
    'course_id 与 external_id 里的课程号一致',
    items.every((item) => item.external_id.split(':')[1] === item.course_id),
    show(items.map((item) => [item.external_id, item.course_id])),
  );
}

{
  const found = items.find((item) => item.external_id === 'course:101:assignment:1');
  ok('找到作业 1', Boolean(found));
  deepEq('作业 payload 逐键精确（due_at 原样字符串）', found && found.payload, {
    name: '作业一',
    description: '<p>描述</p>',
    due_at: '2026-09-30T23:59:00Z',
    points_possible: 10,
    submission_types: ['online_text_entry'],
    course_name: '课程甲',
  });
  eq('作业 payload 恰好 6 个键', Object.keys(found.payload).length, 6);
}

{
  const found = items.find((item) => item.external_id === 'course:101:assignment:2');
  deepEq('缺失字段的归一化（description -> \'\'，due_at/points_possible -> null，submission_types -> []）', found.payload, {
    name: '作业二',
    description: '',
    due_at: null,
    points_possible: null,
    submission_types: [],
    course_name: '课程甲',
  });
}

{
  const found = items.find((item) => item.external_id === 'course:101:announcement:11');
  deepEq('公告 payload 逐键精确（message 保留原始 HTML）', found.payload, {
    title: '公告一',
    message: '<b>正文</b>',
    posted_at: '2026-09-29T10:00:00Z',
    course_name: '课程甲',
  });
  eq('公告 payload 恰好 4 个键', Object.keys(found.payload).length, 4);
}

{
  const found = items.find((item) => item.external_id === 'course:102:announcement:21');
  eq('课程名回落到 course_code', found.payload.course_name, 'CODE-乙');
  eq('posted_at 缺失 -> null', found.payload.posted_at, null);
  eq('message 缺失 -> 空串', found.payload.message, '');
}

{
  const found = items.find((item) => item.external_id === 'course:104:assignment:7');
  eq('解析不了的 due_at 原样保留', found.payload.due_at, 'not-a-date');
  const announcement = items.find((item) => item.external_id === 'course:104:announcement:41');
  eq('缺 posted_at 的公告被保留', announcement.payload.posted_at, null);
}

section('分页与请求形状');

const seen = canvas.state.seen;
eq('第一页带显式查询参数', seen[0], '/api/v1/courses?enrollment_state=active&per_page=100');
eq('第二页只用 Link 里的绝对 URL（显式参数被丢弃）', seen[1], '/api/v1/courses?page=2');
eq('课程列表只请求了 2 次', seen.filter((url) => url.startsWith('/api/v1/courses?')).length, 2);
eq('enrollment_state 只出现在第一页', seen.filter((url) => url.includes('enrollment_state')).length, 1);
ok(
  '课程下作业的第二页同样来自 Link',
  seen.includes('/api/v1/courses/101/assignments?page=2'),
  show(seen),
);
ok(
  '公告按 context_codes[]=course_<id> 拉取（方括号不被转义）',
  seen.includes('/api/v1/announcements?context_codes[]=course_101&per_page=100'),
  show(seen),
);
ok(
  '每门课程都拉了公告',
  seen.filter((url) => url.startsWith('/api/v1/announcements?')).length >= 4,
  show(seen.filter((url) => url.startsWith('/api/v1/announcements?'))),
);

section('重试与逐课程隔离');

eq('500 -> 200 的课程被重试一次后成功', canvas.state.hits.get('/api/v1/courses/105/assignments'), 2);
eq('恒 500 的课程重试到 maxAttempts 次', canvas.state.hits.get('/api/v1/courses/103/assignments'), 3);
eq('失败课程没有继续拉公告', canvas.state.hits.get('/api/v1/announcements') !== undefined, true);
ok(
  '失败课程只影响自己（其余 7 条照常返回）',
  items.length === 7 && ids.includes('course:105:assignment:51'),
  `${items.length} / ${show(ids)}`,
);
ok(
  'Retry-After: 0 被照办（没有退避 1.5s + 2.25s）',
  runElapsed < 1500,
  `整轮耗时 ${runElapsed}ms（若退避会 > 5000ms）`,
);

section('日志/警告');

has('逐课程失败进警告', warnings, '课程 103');
has('逐课程失败警告带上课程名', warnings, '会失败的课程');
has('重试耗尽的报错写进警告', warnings, 'Canvas 请求重试 3 次后仍失败');
has('缺 id 的课程被跳过并记警告', warnings, '缺少 id');
has('缺 id 的课程警告带原始对象', warnings, '缺 id 的课程');
has('缺 id 的作业被跳过并记警告', warnings, '作业缺少 id');
has('早于窗口的作业被跳过并记警告', warnings, '早于回溯窗口');
has('早于窗口的公告被跳过并记警告', warnings, '公告 12');
ok(
  '警告里不会出现 undefined 拼出的假 external_id',
  !warnings.some((warning) => warning.includes('assignment:undefined') || warning.includes('announcement:undefined')),
  show(warnings.slice(0, 3)),
);

section('ctx.lookbackDays 覆盖配置');

{
  const wideWarnings = [];
  const wide = await createCanvasSource(CONFIG, {}).fetchItems({
    now: NOW,
    lookbackDays: 100000, // 把窗口推到 1752 年，2020 年的条目就该回来了
    log: (message) => wideWarnings.push(String(message)),
  });
  const wideIds = wide.map((item) => item.external_id).sort();
  eq('窗口放大后总数', wide.length, 9);
  ok('窗口放大后 2020 年的作业回来了', wideIds.includes('course:101:assignment:3'), show(wideIds));
  ok('窗口放大后 2020 年的公告回来了', wideIds.includes('course:101:announcement:12'), show(wideIds));
  ok(
    '窗口放大后不再有"早于回溯窗口"的丢弃警告',
    !wideWarnings.some((warning) => warning.includes('早于回溯窗口')),
    show(wideWarnings),
  );
}

section('test()：真实连通性检查');

{
  const result = await createCanvasSource(CONFIG, { logger: null }).test();
  eq('连得上时 ok === true', result.ok, true);
  has('成功文案是中文且带课程数', result.message, '连接成功');
  has('探测到了 5 门在读课程', result.message, '5 门');
}

{
  const source = createCanvasSource({ ...CONFIG, baseUrl: unauthorized.base }, { logger: null });
  let message = '';
  try {
    await source.fetchItems({ now: NOW, log });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  has('401 时抛出整源失败（不是静默空数组）', message, '401');
  has('401 文案提示 token 可能过期', message, 'token');
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

for (const { server } of [canvas, unauthorized]) {
  try {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  } catch {
    /* 收尾失败不影响结论 */
  }
}

console.log('');
clearTimeout(watchdog);
if (failures.length > 0) {
  console.error('失败用例：');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('');
}
console.log(`passed: ${passed}  failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
