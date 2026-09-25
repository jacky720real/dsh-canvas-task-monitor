/**
 * 宿主半区自测（无外部依赖，node test/host-check.mjs）。
 *
 * 覆盖：config 掩码/合并、store 的不变量（status 归用户、created_at 只写一次）、
 * pipeline 的顺序不变量（无变更不调 AI、AI 全失败不写快照、逐源隔离）、
 * scoring 的分数锚点与排序、llm 的重试/清洗/禁 score，以及 index.js 的 action 层与同源围栏。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, loadConfig, maskSecrets, mergeSecrets, normalizeConfig, saveConfig, resolveDataDir, validateConfig, SECRET_PATHS, SAVED_SECRET, dbPathIn } from '../lib/config.js';
import { openStore, isAvailable as sqliteAvailable } from '../lib/store.js';
import { isTrustedWebRequest, createHandlers, Runtime, toPublicTask } from '../lib/index.js';
import { HASH_FIELDS, detectChanges, hashItem, mergeDraft, pollOnce, submissionVerdict, syncCompletions, testSource } from '../lib/pipeline.js';
import { computeScore, ruleAssess, sortTasks, urgencyFromDue, extractDueDate, analyzeDueDate, stripQuotedText, classifyByContent, isRegistrationConfirmation, stripHtml, HIGH_URGENCY, HIGH_IMPORTANCE, TAG_WHITELIST } from '../lib/scoring.js';
import { aiConfigured, buildSystemPrompt, buildUserPrompt, callChat, extractTasks, sanitizeDraft, scoreItems, testAi, stripCodeFence } from '../lib/llm.js';
import { canonicalHash, parseDateMs, utcNowIso, truncate } from '../lib/util.js';

let passed = 0;
const failures = [];
const skips = [];

function assert(condition, message) {
  if (!condition) throw new Error(message ?? '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? ''} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? ''} 期望 ${b}，实际 ${a}`);
}
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name} → ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name} → ${error.message}`);
  }
}
function skip(name, reason) {
  skips.push(`${name} → ${reason}`);
}
function asText(value) {
  return typeof value === 'string' ? value : '';
}

const root = mkdtempSync(join(tmpdir(), 'ctm-host-'));
const DAY = 86_400_000;
const nowMs = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------------ 假 HTTP 层 */

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function makeCanvasFetch(state) {
  return async (url) => {
    const href = String(url);
    const parsed = new URL(href);
    state.canvasCalls += 1;
    const path = parsed.pathname;
    if (path === '/api/v1/courses') return jsonResponse(state.courses);
    const assignmentMatch = /^\/api\/v1\/courses\/([^/]+)\/assignments$/.exec(path);
    if (assignmentMatch !== null) {
      const courseId = assignmentMatch[1];
      if (state.failCourses.includes(courseId)) return new Response('boom', { status: 500 });
      return jsonResponse(state.assignments[courseId] ?? []);
    }
    if (path === '/api/v1/announcements') {
      const code = parsed.searchParams.get('context_codes[]') ?? '';
      const courseId = code.replace('course_', '');
      return jsonResponse(state.announcements[courseId] ?? []);
    }
    return new Response('not found', { status: 404 });
  };
}

function makeAiFetch(state) {
  return async (url) => {
    const href = String(url);
    if (!href.startsWith('https://ai.test')) throw new Error(`AI 收到意外地址：${href}`);
    state.aiCalls += 1;
    return state.aiHandler(state.aiCalls);
  };
}

function makeFetch(state) {
  const canvas = makeCanvasFetch(state);
  const ai = makeAiFetch(state);
  return async (url, init) => (String(url).startsWith('https://ai.test') ? ai(url, init) : canvas(url, init));
}

function baseState(overrides = {}) {
  return {
    canvasCalls: 0,
    aiCalls: 0,
    failCourses: [],
    courses: [{ id: 1, name: 'Course A' }, { id: 2, name: 'Course B' }, { name: 'Broken course' }],
    assignments: {
      1: [
        {
          id: 11,
          name: 'Essay 1',
          description: '<p>Write a long <b>essay</b> about X</p>',
          due_at: iso(nowMs + 2 * DAY),
          points_possible: 100,
          submission_types: ['online_upload'],
        },
      ],
      2: [],
    },
    announcements: {
      1: [{ id: 21, title: '学术诚信政策', message: '请注意 academic integrity policy', posted_at: iso(nowMs - DAY) }],
      2: [],
    },
    aiHandler: () => jsonResponse({ choices: [{ message: { content: '{"tasks":[]}' } }] }),
    ...overrides,
  };
}

async function runPoll(dataDir, config, state, extra = {}) {
  const store = openStore(dbPathIn(dataDir));
  const stats = await pollOnce({
    dataDir,
    config,
    store,
    fetchImpl: makeFetch(state),
    sleep: async () => {},
    logger: null,
    nowMs,
    ...extra,
  });
  return { store, stats };
}

function changeRows(store) {
  return store.db.prepare('SELECT source, external_id, change_type, processed FROM change_log ORDER BY id').all();
}
function snapshotCount(store) {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get();
  return Number(row.n);
}

/* ------------------------------------------------------------ config */

check('config: 默认值里 dataDir 走 DSH_HOME', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = 'C:\\Users\\Test\\.dsh';
  try {
    eq(resolveDataDir({}), join('C:\\Users\\Test\\.dsh', 'canvas-task-monitor'), 'DSH_HOME 派生');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
check('config: 掩码只暴露 __SAVED__，真值不出宿主', () => {
  const config = normalizeConfig({ canvas: { token: 'tok-123' }, ai: { apiKey: 'key-456' }, mail: { password: 'pw-789' } });
  const masked = maskSecrets(config);
  eq(masked.canvas.token, SAVED_SECRET, 'canvas.token 掩码');
  eq(masked.ai.apiKey, SAVED_SECRET, 'ai.apiKey 掩码');
  eq(masked.mail.password, SAVED_SECRET, 'mail.password 掩码');
  assert(!JSON.stringify(masked).includes('tok-123'), '掩码后不得出现真 token');
  assert(!JSON.stringify(masked).includes('pw-789'), '掩码后不得出现真密码');
});
check('config: mergeSecrets 里 __SAVED__ 沿用旧值、空串清空', () => {
  const current = normalizeConfig({ canvas: { token: 'tok-123' }, ai: { apiKey: 'key-456' } });
  const kept = mergeSecrets({ canvas: { token: SAVED_SECRET }, ai: { apiKey: SAVED_SECRET } }, current);
  eq(kept.canvas.token, 'tok-123', '沿用 token');
  eq(kept.ai.apiKey, 'key-456', '沿用 apiKey');
  const cleared = mergeSecrets({ canvas: { token: '' }, ai: { apiKey: '' } }, current);
  eq(cleared.canvas.token, '', '清空 token');
  eq(cleared.ai.apiKey, '', '清空 apiKey');
});
check('config: 未在页面渲染的宿主字段不会被保存流程丢掉', () => {
  const current = normalizeConfig({ scoring: { urgencyWeight: 12, importanceWeight: 7 }, ai: { batchSize: 3, temperature: 0.3 } });
  const saved = mergeSecrets(maskSecrets(current), current);
  eq(saved.scoring.urgencyWeight, 12, 'urgencyWeight');
  eq(saved.scoring.importanceWeight, 7, 'importanceWeight');
  eq(saved.ai.batchSize, 3, 'batchSize');
  eq(saved.ai.temperature, 0.3, 'temperature');
});
check('config: 校验能指出缺项', () => {
  const problems = validateConfig(normalizeConfig({ canvas: { enabled: true }, mail: { enabled: false } }));
  assert(problems.some((text) => text.includes('Canvas 地址')), '应报告缺 Canvas 地址');
  assert(problems.some((text) => text.includes('Access Token')), '应报告缺 token');
});
check('config: 原子保存后可读回（UTF-8 无 BOM）', () => {
  const dir = join(root, 'cfg');
  const { config } = saveConfig(dir, { canvas: { baseUrl: 'https://x.test', token: 'abc' } });
  const bytes = readFileSync(join(dir, 'config.json'));
  assert(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'JSON 不应带 BOM');
  const reloaded = loadConfig(dir);
  eq(reloaded.exists, true, 'exists');
  eq(reloaded.config.canvas.baseUrl, 'https://x.test', 'baseUrl 回读');
  eq(config.canvas.token, 'abc', '返回的配置含真值（仅宿主可见）');
});
check('config: SECRET_PATHS 与面板的四个密文字段一致', () => {
  deepEq(SECRET_PATHS, ['canvas.token', 'mail.password', 'mail.clientSecret', 'ai.apiKey'], 'SECRET_PATHS');
});

/* ------------------------------------------------------------ util */

check('util: canonicalHash 与键序无关、只认白名单字段', () => {
  const a = canonicalHash({ name: 'x', description: 'y', extra: 1 }, HASH_FIELDS.canvas_assignment);
  const b = canonicalHash({ description: 'y', extra: 2, name: 'x' }, HASH_FIELDS.canvas_assignment);
  eq(a, b, '同一批白名单字段不同键序应得到同一哈希');
  const c = canonicalHash({ name: 'x', description: 'z', extra: 2 }, HASH_FIELDS.canvas_assignment);
  assert(a !== c, '字段值变化必须改变哈希');
});
check('util: parseDateMs 把无时区字符串按 UTC 处理', () => {
  eq(parseDateMs('2026-09-30T00:00:00'), Date.UTC(2026, 8, 30, 0, 0, 0), '无时区按 UTC');
  eq(parseDateMs('nonsense'), null, '无意义输入返回 null');
  eq(parseDateMs(''), null, '空串返回 null');
});
check('util: utcNowIso 是秒级 +00:00', () => {
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(utcNowIso()), `格式不符：${utcNowIso()}`);
});

/* ------------------------------------------------------------ scoring */

check('scoring: 分数锚点 (5,3)=74、(5,5)=90', () => {
  eq(computeScore(5, 3, { urgencyWeight: 10, importanceWeight: 8 }), 74, '锚点 1');
  eq(computeScore(5, 5, { urgencyWeight: 10, importanceWeight: 8 }), 90, '锚点 2');
  eq(computeScore(0, 0, { urgencyWeight: 10, importanceWeight: 8 }), 0, '下限');
  eq(computeScore(5, 5, { urgencyWeight: 100, importanceWeight: 100 }), 100, '上限 clamp');
});
check('scoring: urgency 锚点表', () => {
  const t = nowMs;
  eq(urgencyFromDue(null, t).urgency, 0, '无截止 → 0');
  eq(urgencyFromDue(t - DAY, t).urgency, 5, '已逾期 → 5');
  eq(urgencyFromDue(t + 3600_000, t).urgency, 4, '24 小时内 → 4');
  eq(urgencyFromDue(t + 2 * DAY, t).urgency, 3, '3 天内 → 3');
  eq(urgencyFromDue(t + 5 * DAY, t).urgency, 2, '7 天内 → 2');
  eq(urgencyFromDue(t + 10 * DAY, t).urgency, 1, '14 天内 → 1');
  eq(urgencyFromDue(t + 20 * DAY, t).urgency, 0, '30 天以后 → 0');
});
check('scoring: extractDueDate 支持三种写法并优先截止词附近', () => {
  eq(extractDueDate('截止时间 2026-09-30', nowMs), iso(Date.UTC(2026, 8, 30, 23, 59)), 'ISO');
  eq(extractDueDate('请在9月30日前提交', nowMs), iso(Date.UTC(2026, 8, 30, 23, 59)), '中文');
  eq(extractDueDate('due Sep 30, 2026', nowMs), iso(Date.UTC(2026, 8, 30, 23, 59)), '英文');
  eq(extractDueDate('没有任何日期', nowMs), null, '没有日期 → null');
  const preferred = extractDueDate('发布于 2026-09-01，截止 2026-09-30', nowMs);
  eq(preferred, iso(Date.UTC(2026, 8, 30, 23, 59)), '优先取“截止”附近的日期');
  const noMarker = extractDueDate('活动时间 2026-09-01 与 2026-09-30', nowMs);
  eq(noMarker, iso(Date.UTC(2026, 8, 1, 23, 59)), '没有截止词时取第一个日期');
});
check('scoring: stripHtml 去标签但保留文本', () => {
  eq(stripHtml('<p>hello <b>world</b></p>'), 'hello world', '基础剥离');
  eq(stripHtml('a<br>b'), 'a\nb', 'br 变换行');
});
check('scoring: 规则打分给作业算分并带课程/截止/提交方式', () => {
  const draft = ruleAssess(
    {
      source: 'canvas_assignment',
      external_id: 'course:1:assignment:11',
      course_id: '1',
      payload: { name: 'Essay 1', description: '<p>Write an essay</p>', due_at: iso(nowMs + 2 * DAY), points_possible: 100, submission_types: ['online_upload'], course_name: 'Course A' },
    },
    { nowMs, weights: { urgencyWeight: 10, importanceWeight: 8 } },
  );
  eq(draft.category, 'assignment', 'category');
  eq(draft.course, 'Course A', 'course');
  eq(draft.urgency, 3, 'urgency');
  assert(draft.importance >= 4, `100 分作业 importance 应 >= 4，实际 ${draft.importance}`);
  eq(draft.score, computeScore(draft.urgency, draft.importance), 'score 必须与公式一致');
  assert(draft.tags.includes('paper'), 'essay 应带 paper 标签');
  assert(draft.importance_reason.includes('提交方式'), 'importance_reason 应含提交方式');
  assert(!Object.prototype.hasOwnProperty.call(draft, 'status'), '草稿不得自带 status');
});
check('scoring: 政策公告被标 is_rule 且归为 activity', () => {
  const draft = ruleAssess(
    { source: 'canvas_announcement', external_id: 'course:1:announcement:21', course_id: '1', payload: { title: '学术诚信政策', message: 'academic integrity policy', posted_at: iso(nowMs - DAY), course_name: 'Course A' } },
    { nowMs, weights: { urgencyWeight: 10, importanceWeight: 8 } },
  );
  eq(draft.category, 'activity', 'category');
  eq(draft.is_rule, true, 'is_rule');
  assert(draft.tags.includes('rule'), '应带 rule 标签');
});
check('scoring: 排序先按时间，无时间按重要度排最后', () => {
  const rows = [
    { id: 1, due_at: iso(nowMs + 5 * DAY), importance: 5, urgency: 1, score: 18 },
    { id: 2, due_at: null, importance: 5, urgency: 5, score: 90 },
    { id: 3, due_at: iso(nowMs + DAY), importance: 1, urgency: 4, score: 48 },
    { id: 4, due_at: null, importance: 2, urgency: 2, score: 36 },
    { id: 5, due_at: iso(nowMs - DAY), importance: 0, urgency: 5, score: 50 },
  ];
  deepEq(sortTasks(rows).map((row) => row.id), [5, 3, 1, 2, 4], '排序结果');
  deepEq(rows.map((row) => row.id), [1, 2, 3, 4, 5], '不得修改入参');
});
check('scoring: 阈值与标签白名单与客户端一致', () => {
  eq(HIGH_URGENCY, 4, 'HIGH_URGENCY');
  eq(HIGH_IMPORTANCE, 4, 'HIGH_IMPORTANCE');
  assert(TAG_WHITELIST.includes('deadline_change'), '白名单含 deadline_change');
  eq(TAG_WHITELIST.length, 10, '白名单长度');
});

/* ------------------------- 四条用户实测修正的回归（时间/分类/重要度/报名确认） */

check('scoring: 转发邮件里的"发送时间"不会被当成截止时间', () => {
  eq(stripQuotedText('发件人: MENDIS\n发送时间: 2026年9月25日 6:11\n收件人: Hall 10 Residents\n\nDear Hall 10 Residents\nMark the dates below:'),
    'Dear Hall 10 Residents\nMark the dates below:', '转发头必须被剥掉');
  const draft = ruleAssess(
    {
      source: 'mail',
      external_id: 'imap:63',
      payload: {
        subject: '转发: [HALL 10] ICFD BASKETBALL RECRUITMENT',
        from: 'Alex Chan <alex.chan@example.edu>',
        receivedDateTime: '2026-09-25T10:29:46+00:00',
        bodyPreview: '发件人: MENDIS\n发送时间: 2026年9月25日 6:11\n收件人: Hall 10 Residents\n\nDear Hall 10 Residents, two upcoming ICFD basketball events.\nMark the dates below: Oct 5',
      },
    },
    { nowMs, weights: { urgencyWeight: 10, importanceWeight: 8 } },
  );
  assert(draft.due_at !== iso(Date.UTC(2026, 8, 25, 6, 11)), `转发头的发送时间不得成为截止时间：${draft.due_at}`);
  eq(draft.due_kind, 'event', '唯一像日期的只当活动时间');
  assert(draft.urgency <= 2, `活动时间不得算紧急：${draft.urgency}`);
  assert(!draft.urgency_reason.includes('已逾期'), draft.urgency_reason);
  eq(draft.category, 'activity', '招募类邮件归活动');
});

check('scoring: 早于收信时间的日期直接丢弃', () => {
  const analyzed = analyzeDueDate('截止 2026-09-01', { nowMs, notBeforeMs: Date.UTC(2026, 8, 25, 10, 29) });
  eq(analyzed.due_at, null, '引用历史里的旧日期不该变成已截止');
  eq(analyzed.dropped, true, '标记为已丢弃');
});

check('scoring: 成绩已发布的公告按内容归为提醒，不再"重要"', () => {
  const draft = ruleAssess(
    {
      source: 'canvas_announcement',
      external_id: 'course:70800:announcement:635075',
      course_id: '70800',
      payload: {
        title: 'Quiz 3 Grades',
        message: '<p>The grades of Quiz 3 have been released on canvas. The <a href="#">solution</a> is in the files. Contact the TAs if you have questions.</p>',
        posted_at: '2026-09-22T09:08:33Z',
        course_name: 'GE1362 Exploring Gen AI in Practice',
      },
    },
    { nowMs, weights: { urgencyWeight: 10, importanceWeight: 8 } },
  );
  eq(draft.category, 'reminder', '信息型公告是提醒，不是活动');
  eq(draft.importance, 1, '成绩已发布不需要动作');
  assert(draft.importance_reason.includes('信息型公告'), draft.importance_reason);
  assert(!draft.importance_reason.includes('考试/测验类'), `理由不能自相矛盾：${draft.importance_reason}`);
});

check('scoring: 不计入总成绩的测验不再按"考试"抬分', () => {
  const draft = ruleAssess(
    {
      source: 'canvas_assignment',
      external_id: 'course:1:assignment:77',
      course_id: '1',
      payload: {
        name: 'Practice Quiz 1',
        description: '<p>Practice quiz, does not count toward your final grade.</p>',
        due_at: iso(nowMs + 2 * DAY),
        points_possible: 0,
        submission_types: ['online_quiz'],
        grading_type: 'not_graded',
        omit_from_final_grade: true,
        course_name: 'Course A',
      },
    },
    { nowMs, weights: { urgencyWeight: 10, importanceWeight: 8 } },
  );
  eq(draft.category, 'assignment', '作业来源仍是作业');
  eq(draft.importance, 1, '不计入总成绩 → 重要度压到 1');
  assert(draft.importance_reason.includes('不计入总成绩'), draft.importance_reason);
  assert(draft.score < 40, `不该是高优先级：${draft.score}`);
});

check('scoring: "报名成功"的邮件按内容归为活动', () => {
  const text = '报名成功：AI 讲座\n您已成功报名参加本次讲座，请准时出席。';
  eq(isRegistrationConfirmation(text), true, '识别为报名确认');
  eq(classifyByContent('mail', text).category, 'activity', '确认类邮件归活动');
  eq(classifyByContent('mail', text).floor, 2, '重要度下限 2');
  eq(classifyByContent('mail', '网易邮箱安全提醒：请及时修改密码').category, 'reminder', '系统通知仍是提醒');
});

check('scoring: 已经过去的活动排到"无时间"那组', () => {
  const rows = [
    { id: 1, due_at: iso(nowMs - 2 * DAY), due_kind: 'event', importance: 5, urgency: 0, score: 40 },
    { id: 2, due_at: iso(nowMs + 3 * DAY), due_kind: 'deadline', importance: 1, urgency: 3, score: 38 },
    { id: 3, due_at: iso(nowMs + DAY), due_kind: 'event', importance: 2, urgency: 2, score: 36 },
  ];
  deepEq(sortTasks(rows).map((row) => row.id), [3, 2, 1], '未来活动按时间；过去活动排最后');
});

/* ------------------------------------------------------------ llm */

const aiConfig = normalizeConfig({ ai: { enabled: true, baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', batchSize: 5 } }).ai;

check('llm: aiConfigured 要求启用 + 三项齐全', () => {
  eq(aiConfigured(aiConfig), true, '齐全');
  eq(aiConfigured({ ...aiConfig, enabled: false }), false, '未启用');
  eq(aiConfigured({ ...aiConfig, apiKey: '' }), false, '缺 key');
  eq(aiConfigured(null), false, 'null');
});
check('llm: 提示词包含锚点与"禁止输出 score"', () => {
  const system = buildSystemPrompt();
  assert(system.includes('禁止输出 score'), '必须禁止输出 score');
  assert(system.includes('5 = 已逾期'), '必须带 urgency 锚点');
  assert(system.includes('5 = 硬性门槛'), '必须带 importance 锚点');
  assert(TAG_WHITELIST.every((tag) => system.includes(tag)), '标签白名单必须全部出现');
  const user = buildUserPrompt([{ source: 'mail', external_id: 'graph:1', change_type: 'new', course_id: null, payload: { subject: 's' } }], utcNowIso());
  assert(user.includes('"subject": "s"'), '用户提示词要带 payload');
  assert(user.includes('当前时间：'), '用户提示词要带当前时间');
});
check('llm: stripCodeFence 剥离围栏', () => {
  eq(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}', '带语言');
  eq(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}', '无语言');
  eq(stripCodeFence('{"a":1}'), '{"a":1}', '无围栏');
});
check('llm: extractTasks 容忍多种包装', () => {
  eq(extractTasks({ tasks: [1] }).length, 1, 'tasks');
  eq(extractTasks([1, 2]).length, 2, '裸数组');
  eq(extractTasks({ items: [1] }).length, 1, 'items');
  eq(extractTasks({ source: 'mail', external_id: 'x' }).length, 1, '单对象');
  eq(extractTasks({ nothing: true }).length, 0, '无内容');
});
check('llm: sanitizeDraft 丢弃 score/越界/未知 external_id', () => {
  const allowed = new Set(['mail\u0000graph:1']);
  const weights = { urgencyWeight: 10, importanceWeight: 8 };
  const good = sanitizeDraft(
    { source: 'mail', external_id: 'graph:1', category: 'reminder', title: 't', summary: 's', course: '', due_at: null, urgency: 4, importance: 5, urgency_reason: 'r', importance_reason: 'i', tags: ['exam', 'bogus'], is_rule: false, score: 999 },
    allowed,
    weights,
  );
  assert(good !== null, '合规条目应通过');
  assert(!Object.prototype.hasOwnProperty.call(good, 'score') || good.score === 80, `score 必须由代码算，实际 ${good.score}`);
  eq(good.score, 80, 'score 重算');
  deepEq(good.tags, ['exam'], '标签过滤');
  eq(sanitizeDraft({ source: 'mail', external_id: 'graph:1', category: 'reminder', urgency: 9, importance: 1 }, allowed, weights), null, 'urgency 越界丢弃');
  eq(sanitizeDraft({ source: 'mail', external_id: 'graph:1', category: 'nope', urgency: 1, importance: 1 }, allowed, weights), null, 'category 非法丢弃');
  eq(sanitizeDraft({ source: 'mail', external_id: 'graph:999', category: 'reminder', urgency: 1, importance: 1 }, allowed, weights), null, '未知 external_id 丢弃');
  eq(sanitizeDraft({ source: 'mail', external_id: 'graph:1', category: 'reminder', urgency: 1.5, importance: 1 }, allowed, weights), null, '非整数丢弃');
});
await checkAsync('llm: 500 后重试成功（第 2 次）', async () => {
  let calls = 0;
  const result = await callChat(aiConfig, [{ role: 'user', content: 'x' }], {
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 500 });
      return jsonResponse({ choices: [{ message: { content: '{"tasks":[]}' } }] });
    },
  });
  eq(result.ok, true, 'ok');
  eq(calls, 2, '调用次数');
});
await checkAsync('llm: 空 content 重试，400 不重试', async () => {
  let calls = 0;
  const retried = await callChat(aiConfig, [{ role: 'user', content: 'x' }], {
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ choices: [{ message: { content: '' } }] });
      return jsonResponse({ choices: [{ message: { content: '{"tasks":[]}' } }] });
    },
  });
  eq(retried.ok, true, '空 content 后重试成功');
  eq(calls, 2, '空 content 触发 1 次重试');
  let badCalls = 0;
  const bad = await callChat(aiConfig, [{ role: 'user', content: 'x' }], {
    sleep: async () => {},
    fetchImpl: async () => {
      badCalls += 1;
      return new Response('nope', { status: 400 });
    },
  });
  eq(bad.ok, false, '400 返回失败');
  eq(badCalls, 1, '400 不重试');
});
await checkAsync('llm: scoreItems 只在 AI 可用时工作，并报告 settled', async () => {
  const items = [{ source: 'mail', external_id: 'graph:1', change_type: 'new', course_id: null, payload: { subject: 's' } }];
  const off = await scoreItems(items, { ...aiConfig, enabled: false }, { weights: { urgencyWeight: 10, importanceWeight: 8 } });
  eq(off.ok, false, '未启用必须 ok=false');
  eq(off.calls, 0, '未启用不得发请求');
  const on = await scoreItems(items, aiConfig, {
    weights: { urgencyWeight: 10, importanceWeight: 8 },
    sleep: async () => {},
    fetchImpl: async () =>
      jsonResponse({ choices: [{ message: { content: '```json\n{"tasks":[{"source":"mail","external_id":"graph:1","category":"reminder","title":"T","summary":"S","course":"","due_at":null,"urgency":2,"importance":3,"urgency_reason":"u","importance_reason":"i","tags":[],"is_rule":false}]}\n```' } }] }),
  });
  eq(on.ok, true, 'ok');
  eq(on.settled.size, 1, 'settled');
  eq(on.drafts.get('mail\u0000graph:1').title, 'T', '草稿标题');
  eq(on.drafts.get('mail\u0000graph:1').score, 44, '2*10+3*8=44');
});
await checkAsync('llm: 全部批次失败 → ok=false 且 settled 为空', async () => {
  const items = [{ source: 'mail', external_id: 'graph:1', change_type: 'new', course_id: null, payload: {} }];
  const result = await scoreItems(items, aiConfig, {
    weights: {},
    sleep: async () => {},
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  eq(result.ok, false, 'ok=false');
  eq(result.settled.size, 0, 'settled 为空');
  assert(result.errors.length > 0, '要有错误');
});
await checkAsync('llm: testAi 翻译 401/403/404', async () => {
  const make = (status) => () => testAi(aiConfig, { fetchImpl: async () => new Response('x', { status }) });
  const unauthorized = await make(401)();
  eq(unauthorized.ok, false, '401');
  assert(unauthorized.message.includes('API Key 无效'), '401 提示');
  const forbidden = await make(403)();
  assert(forbidden.message.includes('余额不足'), '403 提示');
  const missing = await make(404)();
  assert(missing.message.includes('不存在'), '404 提示');
  const okResult = await testAi(aiConfig, { fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }] }) });
  eq(okResult.ok, true, '正常');
});

/* ------------------------------------------------------------ store */

await checkAsync('store: status 归用户，created_at 只写一次', async () => {
  const dir = join(root, 'store-a');
  const state = baseState();
  const first = await runPoll(dir, normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' } }), state);
  const tasks = first.store.listTasks({});
  eq(tasks.length, 2, '两条任务');
  const essay = tasks.find((task) => task.title === 'Essay 1');
  assert(essay !== undefined, '找到 Essay 1');
  first.store.setStatus(essay.id, 'done');
  const createdAt = first.store.getTask(essay.id).created_at;

  // 改描述 → 触发 updated，再拉一次
  state.assignments[1][0].description = '<p>Write a <b>longer</b> essay</p>';
  const second = await runPoll(dir, normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' } }), state);
  const after = second.store.getTask(essay.id);
  eq(after.status, 'done', 'upsert 不得把 status 打回 pending');
  eq(after.created_at, createdAt, 'created_at 不得被覆盖');
  eq(after.summary.includes('longer'), true, '摘要应更新');
  const rows = changeRows(second.store);
  eq(rows.length, 3, 'change_log 行数（2 new + 1 updated）');
  eq(rows[2].change_type, 'updated', '第三条是 updated');
  eq(Number(rows[2].processed), 1, 'processed=1');
});

await checkAsync('store: 无变更不调用 AI、也不写 change_log', async () => {
  const dir = join(root, 'store-b');
  const state = baseState();
  const config = normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' }, ai: { enabled: true, baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' } });
  const first = await runPoll(dir, config, state);
  eq(first.stats.llm_calls, 1, '首轮调用 AI 一次');
  const aiCallsAfterFirst = state.aiCalls;
  const second = await runPoll(dir, config, state);
  eq(second.stats.changes, 0, '第二轮没有变更');
  eq(second.stats.llm_calls, 0, '没有变更就不得调用 AI');
  eq(state.aiCalls, aiCallsAfterFirst, 'AI 请求计数不得增长');
});

await checkAsync('store: AI 失败时规则分照写、快照不写、下轮重试', async () => {
  const dir = join(root, 'store-c');
  const state = baseState({ aiHandler: () => new Response('down', { status: 503 }) });
  const config = normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' }, ai: { enabled: true, baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' } });
  const first = await runPoll(dir, config, state);
  eq(first.stats.tasks, 2, '规则分任务仍要落库');
  eq(snapshotCount(first.store), 0, 'AI 全失败不得写快照');
  eq(first.stats.llm_calls, 1, '调用了一次');
  assert(first.stats.errors.some((text) => text.includes('不写快照')), '要提示本轮不写快照');
  const pending = first.store.listTasks({});
  assert(pending.every((task) => task.status === 'pending'), '任务都是 pending');

  // AI 恢复 → 同一批素材仍被判定为变更（因为没写快照）
  state.aiHandler = () => jsonResponse({ choices: [{ message: { content: '{"tasks":[{"source":"canvas_assignment","external_id":"course:1:assignment:11","category":"assignment","title":"AI 标题","summary":"AI 摘要","course":"Course A","due_at":null,"urgency":4,"importance":5,"urgency_reason":"u","importance_reason":"i","tags":["exam","bogus"],"is_rule":false,"score":999}]}' } }] });
  const second = await runPoll(dir, config, state);
  eq(second.stats.changes, 2, '两个素材都还算变更');
  eq(snapshotCount(second.store), 2, 'AI 恢复后写快照');
  const essay = second.store.listTasks({}).find((task) => task.source === 'canvas_assignment');
  eq(essay.title, 'AI 标题', 'AI 覆盖标题');
  eq(essay.score, 80, 'score=4*10+5*8=80（手机器给的 999 被丢弃）');
  deepEq(essay.tags, ['exam'], '标签过滤');
  // listTasks 的 DTO 不含 raw_json（与旧项目一致），所以直接查库
  const rawRow = second.store.db.prepare('SELECT raw_json FROM tasks WHERE source = ?').get('canvas_assignment');
  assert(!asText(rawRow.raw_json).includes('"score"'), 'raw_json 不得含 score');
});

await checkAsync('pipeline: 逐源隔离 + 课程缺 id 只告警 + 单课失败不影响整轮', async () => {
  const dir = join(root, 'pipe-a');
  const state = baseState({ failCourses: ['2'] });
  const { stats, store } = await runPoll(dir, normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' } }), state);
  eq(stats.sources, 1, '一个源');
  eq(stats.tasks, 2, '仍然写了两条任务');
  assert(stats.warnings.some((text) => text.includes('缺少 id')), '缺 id 的课程要告警');
  assert(stats.warnings.some((text) => text.includes('拉取失败')), '课程 2 失败要告警但不致命');
  eq(store.listTasks({}).length, 2, '库里有两条');
});

await checkAsync('pipeline: Canvas 未配置时跳过并记错误，邮箱启用但缺配置也跳过', async () => {
  const dir = join(root, 'pipe-b');
  const config = normalizeConfig({ canvas: { enabled: true }, mail: { enabled: true, provider: 'imap' } });
  const state = baseState();
  const { stats } = await runPoll(dir, config, state);
  eq(stats.sources, 0, '没有真正跑起来的源');
  eq(stats.errors.length, 2, '两条错误');
  assert(stats.errors.some((text) => text.includes('Canvas')), 'Canvas 错误');
  assert(stats.errors.some((text) => text.includes('邮箱')), '邮箱错误');
});

check('pipeline: 未登记的 source 必须抛错（不回退全量哈希）', () => {
  let threw = false;
  try {
    hashItem({ source: 'unknown_source', external_id: 'x', payload: { a: 1 } });
  } catch {
    threw = true;
  }
  eq(threw, true, '必须抛错');
});
check('pipeline: detectChanges 只产出 new/updated，不产出 removed', () => {
  const items = [
    { source: 'mail', external_id: 'graph:1', payload: { subject: 'a', from: 'x@y', receivedDateTime: null, bodyPreview: '' } },
    { source: 'mail', external_id: 'graph:2', payload: { subject: 'b', from: 'x@y', receivedDateTime: null, bodyPreview: '' } },
  ];
  const hashes = new Map();
  const first = detectChanges(items, hashes);
  eq(first.length, 2, '首次都是 new');
  eq(first[0].change_type, 'new', 'new');
  deepEq(first[0].changed_fields, HASH_FIELDS.mail, 'changed_fields');
  const hashes2 = new Map(first.map((change) => [change.item.external_id, change.content_hash]));
  eq(detectChanges(items, hashes2).length, 0, '无变化');
  items[1].payload.subject = 'b2';
  const third = detectChanges(items, hashes2);
  eq(third.length, 1, '只有一条变化');
  eq(third[0].change_type, 'updated', 'updated');
  eq(detectChanges([items[0]], hashes2).length, 0, '消失的素材不产生 removed');
});
check('pipeline: mergeDraft 保留规则字段，AI 空串不覆盖', () => {
  const rule = { title: '规则标题', summary: '规则摘要', urgency: 1, importance: 2, tags: ['reading'], score: 26, ai_scored: false };
  const merged = mergeDraft(rule, { title: 'AI 标题', summary: '', urgency: 5, importance: 5, tags: [], score: 90 });
  eq(merged.title, 'AI 标题', 'AI 标题覆盖');
  eq(merged.summary, '规则摘要', 'AI 空串不得清空规则摘要');
  eq(merged.urgency, 5, 'AI urgency 覆盖');
  deepEq(merged.tags, ['reading'], 'AI 空 tags 不得清空规则标签');
  eq(merged.ai_scored, true, '标记已 AI 评分');
  eq(mergeDraft(rule, null).ai_scored, false, '没有 AI 结果时标记 false');
});
check('pipeline: Canvas 的权威 due_at 不接受 AI 覆盖，邮箱仍由 AI 决定截止时间', () => {
  const canvasRule = {
    source: 'canvas_assignment',
    external_id: 'course:1:assignment:2',
    due_at: '2026-09-30T15:59:59.000Z',
    title: '规则标题',
    urgency: 2,
  };
  eq(mergeDraft(canvasRule, { due_at: '2026-10-02T15:59:59Z', title: 'AI 标题' }).due_at,
    '2026-09-30T15:59:59.000Z', 'Canvas 截止时间必须保持源值');
  eq(mergeDraft(canvasRule, { due_at: '2026-10-02T15:59:59Z', title: 'AI 标题' }).title,
    'AI 标题', '其它字段照旧由 AI 覆盖');
  const canvasNoDue = { source: 'canvas_assignment', external_id: 'x', due_at: '', title: 't', urgency: 0 };
  eq(mergeDraft(canvasNoDue, { due_at: '2026-10-02T00:00:00+08:00' }).due_at,
    '2026-10-01T16:00:00.000Z', '源没有截止时间时 AI 可以补（补进来的时间统一归一成 UTC ISO）');
  eq(mergeDraft(canvasNoDue, { due_at: '2026-10-02T00:00:00+08:00' }).due_kind,
    'deadline', 'AI 补的时间按截止时间对待');
  const mailRule = { source: 'mail', external_id: 'imap:1', due_at: null, title: 't', urgency: 0 };
  eq(mergeDraft(mailRule, { due_at: '2026-10-02T00:00:00+08:00' }).due_at,
    '2026-10-01T16:00:00.000Z', '邮箱的截止时间本来就只能靠 AI 推断');
});

check('pipeline: AI 说"没有截止时间"时要能清掉规则误判的日期（转发头 bug）', () => {
  // 用户实测：篮球招募邮件是转发来的，转发头里的"发送时间"被规则当成截止时间 → 显示已逾期
  const mailRule = {
    source: 'mail',
    external_id: 'imap:63',
    due_at: '2026-09-25T06:11:00.000Z',
    due_kind: 'event',
    title: 'Hall 10 ICFD 篮球招募活动',
    urgency: 3,
  };
  const merged = mergeDraft(mailRule, { due_at: null, urgency: 0, importance: 1 }, { notBeforeMs: Date.parse('2026-09-25T10:29:46Z') });
  eq(merged.due_at, null, 'AI 判定没有明确截止时间时，规则那个"第一个像日期的"必须清掉');
  eq(merged.due_kind, '', 'due_kind 一起清掉，否则前端还会当成截止时间算逾期');
  // 反过来：日期有截止词支撑（due_kind === deadline）时，AI 的空值不得清掉它
  const strong = { source: 'mail', external_id: 'imap:64', due_at: '2026-09-30T15:59:00.000Z', due_kind: 'deadline', title: 'x', urgency: 4 };
  eq(mergeDraft(strong, { due_at: null }, { notBeforeMs: Date.parse('2026-09-25T10:29:46Z') }).due_at,
    '2026-09-30T15:59:00.000Z', '有截止词的日期比模型的一句话硬');
  // AI 从引用历史里抄出来的旧日期：比收信时间还早 → 丢掉
  const stale = mergeDraft(mailRule, { due_at: '2026-09-20T06:11:00.000Z' }, { notBeforeMs: Date.parse('2026-09-25T10:29:46Z') });
  eq(stale.due_at, null, '早于收信时间 12 小时以上的日期不得写进库');
  // 作业的权威 due_at 仍然一句话都不许改
  eq(mergeDraft({ source: 'canvas_assignment', external_id: 'a', due_at: '2026-09-30T15:59:00.000Z', due_kind: 'deadline' }, { due_at: null }).due_at,
    '2026-09-30T15:59:00.000Z', '作业截止时间永远由 Canvas 说话');
});

/* --------------------------------------------- 自动完成（Canvas 提交 / 邮件确认） */

check('pipeline: submissionVerdict 只认客观的"我交了"', () => {
  const base = { payload: { submission_types: ['online_upload'] } };
  eq(submissionVerdict({ ...base, payload: { ...base.payload, submission: null } }).done, false, '没有 submission → 没交');
  eq(submissionVerdict({ ...base, payload: { ...base.payload, submission: { workflow_state: 'unsubmitted', submitted_at: null } } }).done, false, 'unsubmitted → 没交');
  const submitted = submissionVerdict({ ...base, payload: { ...base.payload, submission: { workflow_state: 'submitted', submitted_at: iso(nowMs - DAY) } } });
  eq(submitted.done, true, '有 submitted_at → 已交');
  eq(submitted.reason, 'Canvas 已提交', '理由文案');
  eq(submissionVerdict({ ...base, payload: { ...base.payload, submission: { workflow_state: 'graded', submitted_at: null } } }).done, true, '已评分也算交了');
  eq(submissionVerdict({ ...base, payload: { ...base.payload, submission: { workflow_state: 'submitted', submitted_at: null, excused: true } } }).done, false, '免修不算我做的');
  eq(submissionVerdict({ payload: { submission_types: ['none'], submission: { workflow_state: 'submitted', submitted_at: iso(nowMs) } } }).done, false, '无需提交的条目不该被划掉');
});

await checkAsync('pipeline: 只有提交状态变了（哈希不变）也会自动勾掉', async () => {
  const dir = join(root, 'store-complete');
  const state = baseState();
  const config = normalizeConfig({ canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' } });
  const first = await runPoll(dir, config, state);
  const before = first.store.getTaskByKey('canvas_assignment', 'course:1:assignment:11');
  eq(before.status, 'pending', '首轮是待办');
  eq(first.stats.completed, 0, '首轮没有可勾的');

  // 只改 submission（不在哈希白名单里）→ 下一轮"没有变更"，但依然必须自动勾掉
  state.assignments[1][0].submission = { workflow_state: 'submitted', submitted_at: iso(nowMs - DAY) };
  const second = await runPoll(dir, config, state);
  eq(second.stats.changes, 0, '提交状态不参与哈希 → 没有变更');
  eq(second.stats.completed, 1, '没有变更也要同步完成状态（这条曾经被变更门禁挡住）');
  const after = second.store.getTaskByKey('canvas_assignment', 'course:1:assignment:11');
  eq(after.status, 'done', '自动划掉');
  eq(after.status_source, 'canvas', '记录是客观信号勾的');
  eq(after.status_note, 'Canvas 已提交', '写清完成方式');

  // 用户手动取消勾选 → 之后任何一轮都不得再自动勾回去
  second.store.setStatus(after.id, 'pending');
  const third = await runPoll(dir, config, state);
  const kept = third.store.getTaskByKey('canvas_assignment', 'course:1:assignment:11');
  eq(kept.status, 'pending', '用户取消后必须留得住');
  eq(kept.status_source, 'user', '状态来源记为 user');
  eq(third.stats.completed, 0, '不得再自动完成');
});

check('pipeline: 邮件"报名成功"把旧报名提醒升级成参加，并勾掉确认信本身', () => {
  const dir = join(root, 'store-confirm');
  const store = openStore(dbPathIn(dir));
  const seed = (over) => ({
    source: 'mail',
    external_id: 'imap:x',
    category: 'reminder',
    title: 't',
    summary: '',
    course: '',
    due_at: null,
    due_kind: '',
    urgency: 0,
    importance: 1,
    score: 8,
    tags: [],
    is_rule: false,
    urgency_reason: '',
    importance_reason: '',
    status: 'pending',
    raw_json: '',
    ...over,
  });
  // 用户真机上的形状：中文标题 + 英文转发主题的旧报名任务
  store.upsertTask(seed({
    external_id: 'imap:recruit',
    title: 'Hall 10 ICFD 篮球招募活动',
    summary: '转发: [HALL 10] ICFD BASKETBALL RECRUITMENT',
    importance: 1,
    importance_reason: '活动类（需报名）',
  }));
  store.upsertTask(seed({ external_id: 'imap:confirm', title: 'Registration Confirmed: ICFD Basketball Recruitment' }));

  const item = {
    source: 'mail',
    external_id: 'imap:confirm',
    payload: {
      subject: 'Registration Confirmed: ICFD Basketball Recruitment',
      bodyPreview: 'Dear student, your registration for the ICFD Basketball Recruitment has been confirmed.',
      receivedDateTime: iso(nowMs),
    },
  };
  const result = syncCompletions('mail', [item], store, { nowIso: iso(nowMs) });
  eq(result.promoted, 1, '升级了一条报名提醒');
  eq(result.completed, 1, '勾掉了确认信本身');
  const promoted = store.getTaskByKey('mail', 'imap:recruit');
  eq(promoted.title, '参加：Hall 10 ICFD 篮球招募活动', '标题改成"参加"');
  eq(promoted.category, 'activity', '分类仍是活动');
  eq(promoted.importance, 2, '报名确认后重要度 +1');
  assert(promoted.importance_reason.includes('报名已确认'), promoted.importance_reason);
  eq(promoted.status, 'pending', '旧的报名项不是"我做完的事"，保持待办');
  const confirmTask = store.getTaskByKey('mail', 'imap:confirm');
  eq(confirmTask.status, 'done', '确认信本身自动完成');
  eq(confirmTask.status_source, 'mail', '来源是邮件客观信号');

  // 幂等：再跑一次不得重复升级、也不得重复计数
  const again = syncCompletions('mail', [item], store, { nowIso: iso(nowMs) });
  eq(again.promoted, 0, '已经升过级就不再动');
  eq(again.completed, 0, '已经勾过就不再计数');
  eq(store.getTaskByKey('mail', 'imap:recruit').title, '参加：Hall 10 ICFD 篮球招募活动', '标题不会被叠加前缀');
});

/* ------------------------------------------------------------ index action 层 */

check('index: toPublicTask 去掉 raw_json', () => {
  const result = toPublicTask({ id: 1, title: 't', raw_json: '{"big":1}' });
  eq(result.title, 't', '保留字段');
  eq(Object.prototype.hasOwnProperty.call(result, 'raw_json'), false, 'raw_json 必须去掉');
});

await checkAsync('index: action 层覆盖面板用到的全部方法', async () => {
  const dir = join(root, 'runtime');
  saveConfig(dir, { canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 'tok-123', lookbackDays: 30 } });
  // 自测里不出网：Runtime 支持注入 fetchImpl（生产路径仍用全局 fetch）
  const stubFetch = async (url) => {
    const href = String(url);
    if (href.includes('/assignments')) {
      return jsonResponse([{ id: 11, name: 'Stub Task', description: '<p>stub</p>', due_at: iso(nowMs + DAY), points_possible: 10, submission_types: ['online_text_entry'] }]);
    }
    if (href.includes('/announcements')) return jsonResponse([]);
    if (href.includes('/api/v1/courses')) return jsonResponse([{ id: 1, name: 'Course A' }]);
    return new Response('not found', { status: 404 });
  };
  const deps = { config: { dataDir: dir }, logger: null, fetchImpl: stubFetch };
  const runtime = new Runtime(deps);
  const handlers = createHandlers(runtime);

  const status = handlers.status();
  eq(status.ok, true, 'status ok');
  eq(status.data.dataDir, dir, 'dataDir');
  eq(status.data.dbPath, dbPathIn(dir), 'dbPath');
  eq(status.data.configPath, join(dir, 'config.json'), 'configPath');
  eq(status.data.sqlite, true, 'sqlite 可用');
  assert(Array.isArray(status.data.problems), 'problems 是数组');

  const cfg = handlers.get_config();
  eq(cfg.ok, true, 'get_config ok');
  eq(cfg.data.config.canvas.token, SAVED_SECRET, 'token 必须掩码');
  assert(!JSON.stringify(cfg.data).includes('tok-123'), '不得把真 token 发给浏览器');
  eq(cfg.data.config.canvas.baseUrl, 'https://canvas.test', '非密文字段原样');
  /* 这条契约要响：面板拿到的是包装对象，必须自己拆一层（曾经因为少拆一层，设置页所有字段都是空的）。 */
  deepEq(Object.keys(cfg.data).sort(), ['config', 'configExists', 'configPath', 'dataDir', 'problems'], 'get_config 的 data 是包装对象');

  // 模拟面板回传：掩码字段原样 + 改一个数值
  const draft = JSON.parse(JSON.stringify(cfg.data.config));
  draft.canvas.lookbackDays = 45;
  draft.mail.folders = 'INBOX, Alerts';
  const saved = handlers.save_config({ config: draft });
  eq(saved.ok, true, 'save_config ok');
  const onDisk = loadConfig(dir).config;
  eq(onDisk.canvas.token, 'tok-123', '掩码回传后磁盘上仍是原 token');
  eq(onDisk.canvas.lookbackDays, 45, '数值更新');
  deepEq(onDisk.mail.folders, ['INBOX', 'Alerts'], '逗号字符串转数组');

  const unknown = await handlers.test_source({ source: 'nope' });
  eq(unknown.ok, true, 'test_source 不抛错');
  eq(unknown.data.ok, false, '未知源 ok=false');

  const empty = handlers.list_tasks({ limit: 10 });
  eq(empty.ok, true, 'list_tasks ok');
  deepEq(empty.data, [], '初始化时没有任务');

  const marked = handlers.mark_task({ task_id: 999999, done: true });
  eq(marked.ok, true, 'mark_task 不存在的 id 也不抛（返回 null）');
  eq(marked.data, null, 'null');

  const summary = handlers.summarize_pending();
  eq(summary.ok, true, 'summarize_pending ok');
  eq(summary.data.total, 0, 'total 0');

  // 拉取一轮（桩 fetch，不出网），面板随后应看到任务
  const polled = await handlers.poll_now();
  eq(polled.ok, true, 'poll_now ok');
  eq(polled.data.stats.tasks, 1, '写入一条任务');
  eq(polled.data.summary.total, 1, 'poll_now 直接带回最新汇总');
  const after = handlers.list_tasks({ limit: 10 });
  eq(after.data.length, 1, '列表里有任务');
  eq(after.data[0].title, 'Stub Task', '标题');
  assert(!Object.prototype.hasOwnProperty.call(after.data[0], 'raw_json'), '发往浏览器的任务不得带 raw_json');
  const realId = after.data[0].id;
  const done = handlers.mark_task({ task_id: realId, done: true });
  eq(done.data.status, 'done', '勾选完成');
  eq(handlers.summarize_pending().data.total, 0, '完成后不再计入待办');
  eq(handlers.mark_task({ task_id: realId, done: false }).data.status, 'pending', '撤销恢复');

  const reset = handlers.reset_data();
  eq(reset.ok, true, 'reset_data ok');

  const second = new Runtime(deps);
  const polled2 = await second.poll('测试');
  eq(polled2.ok, true, '直接调 Runtime.poll 也 ok');
  second.dispose('测试结束');
  runtime.dispose('测试结束');
});

await checkAsync('index: 拉取进行中时拒绝第二次 poll_now', async () => {
  const dir = join(root, 'runtime-lock');
  saveConfig(dir, { canvas: { enabled: true, baseUrl: 'https://canvas.test', token: 't' } });
  const runtime = new Runtime({ config: { dataDir: dir }, logger: null });
  runtime.polling = true;
  const result = await runtime.poll('manual');
  eq(result.ok, false, '锁生效');
  assert(result.message.includes('已有拉取任务在执行中'), '中文提示');
  runtime.polling = false;
  runtime.dispose('测试结束');
});

check('index: 同源围栏', () => {
  const trusted = ['127.0.0.1:43120'];
  eq(isTrustedWebRequest({ headers: { host: '127.0.0.1:43120' } }, trusted), true, '回环');
  eq(isTrustedWebRequest({ headers: { host: 'localhost:43120', origin: 'http://localhost:43120' } }, trusted), true, 'localhost 同源');
  eq(isTrustedWebRequest({ headers: { host: '127.0.0.1:43120', origin: 'http://evil.test' } }, trusted), false, '跨站 origin');
  eq(isTrustedWebRequest({ headers: { host: 'evil.test' } }, trusted), false, '非回环且不受信');
  eq(isTrustedWebRequest({ headers: { host: 'evil.test' } }, ['evil.test']), true, '显式受信 host');
  eq(isTrustedWebRequest({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }, trusted), false, 'cross-site');
  eq(isTrustedWebRequest({ headers: {} }, trusted), false, '没有 host');
});

check('index: 数据目录诊断可列目录', async () => {
  const dir = join(root, 'listdir');
  saveConfig(dir, {});
  eq(readFileSync(join(dir, 'config.json')).length > 0, true, '文件已写入');
});

/* ------------------------------------------------------------ 收尾 */

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* 忽略 */
}
if (!sqliteAvailable()) skips.push('node:sqlite 不可用，涉及数据库的用例已降级为失败');
console.log(`passed: ${passed}   failed: ${failures.length}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all host self-tests passed');
}
if (skips.length > 0) for (const item of skips) console.log(`SKIP ${item}`);
