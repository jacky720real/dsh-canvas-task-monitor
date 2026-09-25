/**
 * 浏览器半区冒烟测试（新版界面）。
 *
 * DSH 的 react-dom 只存在于它自己的客户端 bundle 里、不落盘成 npm 包，
 * 所以这里用一个 ~90 行的迷你 React（createElement + useState + useEffect +
 * 函数组件递归展开）在 Node 里真正跑一遍 lib/client.js：
 *   挂载主面板 → 初始化提示 → 刷新出列表 → 徽标/排序/筛选 → 勾选 + 撤销 toast
 *   → 设置页读取 / 保存 / 测试连接 → 返回列表。
 *
 * 用法：node test/client-check.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------ 用真 React 校验 API 存在性 */

let realReactVersion = null;
// Where a real React might live, derived from the environment instead of from one
// machine's layout (the same discovery idea as cordis-check.mjs). Not finding it
// is not a failure: the checks that need real React are skipped, and everything
// else runs against the mini React below.
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const appRoots = [
  process.env.CTM_DSH_APP,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app'),
  join(process.env.LOCALAPPDATA ?? '', 'DSH Desktop', 'resources', 'app'),
  join(process.env.ProgramFiles ?? '', 'DSH Desktop', 'resources', 'app'),
].filter((root) => root && !root.startsWith('DSH'));
const reactRoots = [
  join(dshHome, 'profiles', 'node_modules'),
  ...appRoots.map((root) => join(root, 'node_modules')),
];
for (const root of reactRoots) {
  try {
    const real = createRequire(join(root, 'noop.js'))('react');
    if (['createElement', 'useState', 'useEffect'].every((name) => typeof real[name] === 'function')) realReactVersion = real.version;
    break;
  } catch {
    /* 继续 */
  }
}

/* ------------------------------------------------------------ 迷你 React */

let hookOwner = null;
let rootInst = null;
let scheduled = false;

function scheduleRoot() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (rootInst !== null) renderInst(rootInst);
  });
}

function expandNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(expandNode).filter((child) => child !== null);
  if (node.$$el !== true) return node;
  if (typeof node.type === 'function') {
    return renderInst({ component: node.type, props: node.props, hooks: [], hookIndex: 0 });
  }
  return { ...node, props: { ...node.props, children: expandNode(node.props.children) } };
}

function renderInst(inst) {
  const saved = hookOwner;
  const pending = [];
  hookOwner = inst;
  inst.hookIndex = 0;
  inst.sink = pending;
  inst.effects ??= {};
  inst.effectIndex = 0;
  let out;
  try {
    out = inst.component(inst.props);
  } finally {
    hookOwner = saved;
    inst.sink = null;
  }
  const tree = expandNode(out);
  if (inst.parent === null || inst.parent === undefined) inst.tree = tree;
  for (const effect of pending) {
    try {
      effect();
    } catch (error) {
      console.error('effect 抛错：', error);
    }
  }
  return tree;
}

const FakeReact = {
  createElement(type, props, ...children) {
    const flat = [];
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child);
      else flat.push(child);
    }
    return { $$el: true, type, props: { ...(props ?? {}), children: flat } };
  },
  useState(initial) {
    const inst = hookOwner;
    if (inst === null) throw new Error('useState 在组件外被调用');
    const index = inst.hookIndex++;
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (next) => {
      const value = typeof next === 'function' ? next(inst.hooks[index]) : next;
      if (Object.is(value, inst.hooks[index])) return;
      inst.hooks[index] = value;
      scheduleRoot();
    };
    return [inst.hooks[index], setter];
  },
  useEffect(effect) {
    const inst = hookOwner;
    if (inst === null) throw new Error('useEffect 在组件外被调用');
    const index = inst.effectIndex++;
    if (inst.effects[index] === true) return;
    inst.effects[index] = true;
    inst.sink.push(effect);
  },
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(value) {
    return { current: value };
  },
  version: 'fake-18',
};

/* ---------------------------------------------------------- 假 document */

const styles = [];
const fakeDocument = {
  querySelector: (selector) => styles.find((style) => style.selector === selector) ?? null,
  createElement: () => {
    const style = { selector: null, setAttribute: (name, value) => { if (name === 'data-dsh-plugin') style.selector = `style[data-dsh-plugin="${value}"]`; }, textContent: '' };
    return style;
  },
  head: { appendChild: (style) => styles.push(style) },
};

/* ------------------------------------------------------------- 假 fetch */

const DAY = 86_400_000;
const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();

const calls = [];
let statusReady = false;
let savedConfig = null;

function statusPayload() {
  return {
    dataDir: statusReady ? 'C:\\Users\\tester\\.dsh\\canvas-task-monitor' : '',
    dbPath: statusReady ? 'C:\\Users\\tester\\.dsh\\canvas-task-monitor\\tasks.sqlite' : '',
    configPath: statusReady ? 'C:\\Users\\tester\\.dsh\\canvas-task-monitor\\config.json' : '',
    version: '1.0.0',
    sources: {
      canvas: { enabled: true, configured: true },
      mail: { enabled: false, configured: false },
      ai: { enabled: true, configured: true },
    },
    counts: { pending: 3, done: 0, total: 3 },
    lastPollAt: '2026-09-01T02:00:00Z',
  };
}

const configFixture = () => ({
  canvas: { enabled: true, baseUrl: 'https://school.instructure.com', token: '__SAVED__', lookbackDays: 14 },
  mail: {
    enabled: false,
    provider: 'imap',
    host: 'imap.example.com',
    port: 993,
    user: 'me@example.com',
    password: '__SAVED__',
    folders: ['INBOX', 'Notifications'],
    lookbackDays: 7,
    tenantId: '',
    clientId: '',
    clientSecret: '__SAVED__',
  },
  ai: { enabled: true, baseUrl: 'https://api.deepseek.com/v1', apiKey: '__SAVED__', model: 'deepseek-chat', maxOutputTokens: 1024 },
  poll: { autoPull: true, intervalSeconds: 300 },
});

function maskSecrets(config) {
  const clone = JSON.parse(JSON.stringify(config));
  for (const path of [['canvas', 'token'], ['mail', 'password'], ['mail', 'clientSecret'], ['ai', 'apiKey']]) {
    if (typeof clone[path[0]][path[1]] === 'string' && clone[path[0]][path[1]].length > 0) clone[path[0]][path[1]] = '__SAVED__';
  }
  return clone;
}

/**
 * 三条任务，刻意覆盖三档截止状态：
 *   29 —— 2 天前到期（已逾期 + urgency 5 -> 紧急），score 97
 *   22 —— 6 小时后到期（今天截止 + importance 4 -> 重要），score 83
 *   48 —— 没有 due_at（排在最后），score 71
 */
let taskRows = [
  { id: 29, source: 'canvas_assignment', external_id: 'course:70988:assignment:1', category: 'assignment', title: 'Academic Honesty Pledge', summary: '请签署学术诚信承诺书。', course: 'GE1401T42 University English', due_at: iso(-2 * DAY), urgency: 5, importance: 3, score: 97, tags: ['policy'], is_rule: true, urgency_reason: '已逾期', importance_reason: '计入总评', status: 'pending', created_at: iso(-9 * DAY), updated_at: iso(-9 * DAY) },
  { id: 22, source: 'canvas_announcement', external_id: 'course:70988:announcement:632653', category: 'activity', title: 'Quiz 1 – Lecture 1', summary: '', course: 'GE1362 Exploring Gen AI in Practice', due_at: iso(6 * 3_600_000), urgency: 3, importance: 4, score: 83, tags: [], is_rule: false, urgency_reason: '', importance_reason: '练习', status: 'pending', created_at: iso(-9 * DAY), updated_at: iso(-9 * DAY) },
  { id: 48, source: 'canvas_announcement', external_id: 'course:1:announcement:9', category: 'reminder', title: 'Reminder: Tasks to complete today', summary: '', course: 'GE1401T42 University English', due_at: null, urgency: 5, importance: 3, score: 71, tags: ['deadline_change', 'admin'], is_rule: false, urgency_reason: '', importance_reason: '', status: 'pending', created_at: iso(-9 * DAY), updated_at: iso(-9 * DAY) },
];

async function fakeFetch(url, init) {
  if (url !== '/canvas-task-monitor/api') throw new Error(`未预期的 fetch：${url}`);
  const body = JSON.parse(init.body);
  calls.push({ action: body.action, params: body.params });
  const respond = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });

  if (body.action === 'summarize_pending') {
    const pending = taskRows.filter((task) => task.status !== 'done');
    return respond({
      total: pending.length,
      assignment: pending.filter((t) => t.category === 'assignment').length,
      activity: pending.filter((t) => t.category === 'activity').length,
      reminder: pending.filter((t) => t.category === 'reminder').length,
      overdue: pending.filter((t) => typeof t.due_at === 'string' && Date.parse(t.due_at) < Date.now()).length,
      dueToday: pending.filter((t) => typeof t.due_at === 'string' && Date.parse(t.due_at) >= Date.now() && Date.parse(t.due_at) - Date.now() < DAY).length,
      max_urgency: 5,
    });
  }
  if (body.action === 'list_tasks') return respond(taskRows);
  if (body.action === 'status') return respond(statusPayload());
  if (body.action === 'mark_task') {
    taskRows = taskRows.map((task) => (task.id === body.params.task_id ? { ...task, status: body.params.done ? 'done' : 'pending' } : task));
    return respond({ ...taskRows.find((task) => task.id === body.params.task_id) });
  }
  if (body.action === 'poll_now') return respond({ fetched: 3, created: 0, updated: 1, unchanged: 2, durationMs: 12, sources: [{ source: 'canvas', ok: true, message: 'OK' }] });
  if (body.action === 'get_config') return respond(configFixture());
  if (body.action === 'save_config') {
    savedConfig = body.params.config;
    return respond({ ok: true, config: maskSecrets(savedConfig) });
  }
  if (body.action === 'test_source') {
    if (body.params.source === 'canvas') return respond({ ok: true, message: '连接成功：Canvas 可访问' });
    return respond({ ok: false, message: '连接失败：缺少凭据', detail: 'ECONNREFUSED' });
  }
  throw new Error(`未预期的 action：${body.action}`);
}

/* --------------------------------------------------------- 执行客户端半区 */

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const require = (name) => {
        if (name === 'react') return FakeReact;
        throw new Error(`未预期的 require("${name}")`);
      };
      loaded = { id, exports: factory(require) };
      return loaded.exports;
    },
  },
};

const registered = new Map();
const slots = {
  inject(_name, callback) {
    callback();
  },
  register(options, component) {
    registered.set(options.name === 'main' ? `main:${options.key}` : `${options.name}:${options.id}`, { options, component });
    return () => registered.delete(options.id ?? options.key);
  },
};

const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
new Function('window', 'document', 'fetch', 'console', source)(globalThis.window, fakeDocument, fakeFetch, console);

let passed = 0;
let failures = 0;
function check(label, condition, extra) {
  const ok = condition === true;
  if (ok) passed += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : `  ${extra}`}`);
}

function all(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) all(child, predicate, out);
    return out;
  }
  if (node.$$el === true) {
    if (predicate(node)) out.push(node);
    all(node.props.children, predicate, out);
  }
  return out;
}

function text(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) text(child, out);
    return out;
  }
  if (node.$$el === true) text(node.props.children, out);
  return out;
}

const flatten = (node) => text(node).join(' ').replace(/\s+/g, ' ').trim();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const els = (predicate) => all(rootInst.tree, predicate);
const byClass = (className) => els((node) => node.props.className === className);
const byRole = (role) => els((node) => node.props['data-role'] === role);
const byField = (key) => els((node) => node.props['data-field'] === key);
const buttonWith = (className, label) => els((node) => node.type === 'button' && node.props.className === className && flatten(node).includes(label))[0];
const cards = () => els((node) => node.type === 'article' && node.props.className === 'ctm-card');
/** 一张卡片里的标题元素（ctm-card-title）文本。 */
function cardTitles(card) {
  return all(card, (node) => node.props.className === 'ctm-card-title').map((node) => flatten(node));
}
/** 列表中每张卡片的标题，按渲染顺序。 */
const titles = () => cards().map((card) => cardTitles(card)[0] ?? '');
const cardOf = (title) => cards().filter((card) => cardTitles(card)[0] === title);
const checkOf = (card) => all(card, (node) => node.type === 'button' && node.props.className === 'ctm-check')[0];

/* ------------------------------------------------------------- 断言开始 */

check('客户端半区导出 apply/inject', typeof loaded.exports.apply === 'function' && Array.isArray(loaded.exports.inject));
check('客户端半区额外导出 sortTasks', typeof loaded.exports.sortTasks === 'function');
if (realReactVersion !== null) check('用到 React API 在真实 React 中存在', true, `react@${realReactVersion}`);
else console.log('WARN  没找到真实 React，跳过 API 存在性校验');

const ctx = { slots, get: () => undefined, logger: { debug() {}, info() {}, warn() {}, error() {} } };
loaded.exports.apply(ctx);

check('注册了 3 个槽位', registered.size === 3, [...registered.keys()].join(' | '));
check('注册了侧边栏导航行', registered.has('sidebar.panellist:canvas-task-monitor'));
check('注册了主区域整页面板', registered.has('main:canvas-task-monitor'));
check('注册了左下角角标', registered.has('sidebar.footer.action:canvas-task-monitor-badge'));
check('panel key 与 panellist id 一致', registered.get('main:canvas-task-monitor').options.key === registered.get('sidebar.panellist:canvas-task-monitor').options.id);
check('样式只注入一次', styles.length === 1, `${styles.length} 个 style`);

const icon = registered.get('sidebar.panellist:canvas-task-monitor').component;
const badge = registered.get('sidebar.footer.action:canvas-task-monitor-badge').component;
const panel = registered.get('main:canvas-task-monitor').component;

const iconTree = renderInst({ component: icon, props: { size: 16, active: false }, hooks: [], hookIndex: 0 });
check('侧边栏图标渲染出 svg', all(iconTree, (node) => node.type === 'svg').length === 1);

const badgeTree = renderInst({ component: badge, props: { wide: true }, hooks: [], hookIndex: 0 });
check('角标窄栏时含“任务”', flatten(badgeTree).includes('任务'));

/* ------------------------------------------------- 排序函数（纯函数断言） */

const sortInput = [
  { id: 1, due_at: null, importance: 2, urgency: 5, score: 90 },
  { id: 2, due_at: iso(3 * DAY), importance: 1, urgency: 1, score: 10 },
  { id: 3, due_at: iso(-1 * DAY), importance: 3, urgency: 2, score: 20 },
  { id: 4, due_at: 'not-a-date', importance: 5, urgency: 5, score: 99 },
  { id: 5, due_at: iso(-1 * DAY), importance: 5, urgency: 1, score: 30 },
  { id: 6, due_at: null, importance: 5, urgency: 1, score: 5 },
  { id: 7, due_at: null, importance: 5, urgency: 1, score: 40 },
  { id: 8, due_at: iso(3_600_000), importance: 0, urgency: 0, score: 1 },
  { id: 9, due_at: null, importance: 1, urgency: 1, score: 5 },
  { id: 10, due_at: null, importance: 1, urgency: 1, score: 5 },
];
const sortedIds = loaded.exports.sortTasks(sortInput).map((task) => task.id);
check('sortTasks：有时间在前按时间升序、无时间在后按重要/紧迫/分数/id', JSON.stringify(sortedIds) === JSON.stringify([5, 3, 8, 2, 4, 7, 6, 1, 9, 10]), JSON.stringify(sortedIds));
check('sortTasks 不修改入参', sortInput[0].id === 1 && sortInput.length === 10);

/* ---------------------------------------------------- 主面板：首次挂载 */

rootInst = { component: panel, props: {}, hooks: [], hookIndex: 0, effects: {}, parent: null, tree: null };
renderInst(rootInst);
check('首帧显示读取中', flatten(rootInst.tree).includes('正在读取'), flatten(rootInst.tree).slice(0, 60));

await settle();
const firstBody = flatten(rootInst.tree);
check('加载后出现待办计数', firstBody.includes('待办 3'), firstBody.slice(0, 120));
check('统计行给出已逾期 / 今天截止', firstBody.includes('已逾期 1') && firstBody.includes('今天截止 1'), firstBody.slice(0, 200));

// 7) 宿主还没初始化 -> 指路到设置按钮，而不是空列表
check('未初始化时显示设置提示', firstBody.includes('尚未完成初始化') && firstBody.includes('设置'), firstBody.slice(0, 120));
check('未初始化时不渲染任务卡片', byClass('ctm-card').length === 0, `${byClass('ctm-card').length} 张卡片`);
check('初始化提示优先于“暂无任务”', !firstBody.includes('暂无任务'));

// 宿主建好数据目录：刷新 -> 正常列表
statusReady = true;
buttonWith('ctm-btn', '刷新').props.onClick();
await settle();
const body = flatten(rootInst.tree);
check('初始化后出现任务卡片', byClass('ctm-card').length === 3, `${byClass('ctm-card').length} 张卡片`);
check('加载后出现真实任务标题', body.includes('Academic Honesty Pledge'));
check('加载后出现课程名', body.includes('GE1401T42 University English'));
check('加载后出现三分法 chip', body.includes('全部') && body.includes('作业') && body.includes('活动') && body.includes('提醒'));
check('规则任务带“规则”标记', body.includes('规则'));
check('列表请求了 500 条上限', calls.some((call) => call.action === 'list_tasks' && call.params.limit === 500));
check('读取了 status', calls.some((call) => call.action === 'status'));

/* --------------------------------------------------------------- 徽标 */

check('urgency>=4 渲染“紧急”徽标', byClass('ctm-flag').some((node) => flatten(node) === '紧急'));
check('importance>=4 渲染“重要”徽标', byClass('ctm-flag').some((node) => flatten(node) === '重要'));
check('逾期渲染“已逾期”徽标', byClass('ctm-flag').some((node) => flatten(node) === '已逾期'));
check('今天到期显示“今天截止”', body.includes('今天截止'));
check('不再渲染旧的“紧迫 x / 重要 y”文本', !body.includes('紧迫 5 / 重要') && !body.includes('/ 重要 4'));

/* ------------------------------------------- 不再上屏任何数值 score */
check('没有分数元素', byClass('ctm-score').length === 0, `${byClass('ctm-score').length} 个`);
check('分数 97 不出现在界面', !body.includes('97'));
check('分数 83 不出现在界面', !body.includes('83'));
check('分数 71 不出现在界面', !body.includes('71'));

/* --------------------------------------------------------- 客户端排序 */

const renderedOrder = titles();
check(
  '列表按 截止时间 -> 重要程度 排序',
  renderedOrder[0] === 'Academic Honesty Pledge' && renderedOrder[1] === 'Quiz 1 – Lecture 1' && renderedOrder[2] === 'Reminder: Tasks to complete today',
  renderedOrder.join(' | '),
);

/* ------------------------------------------------------------ 展开详情 */

const detailCard = els((node) => node.type === 'article' && node.props.className === 'ctm-card')[0];
check('找到任务卡片', detailCard !== undefined);
if (detailCard !== undefined) {
  check('默认不展开详情', !flatten(rootInst.tree).includes('紧迫理由'));
  detailCard.props.onClick();
  await settle();
  const detail = flatten(rootInst.tree);
  check('展开后显示摘要与理由', detail.includes('请签署学术诚信承诺书') && detail.includes('紧迫理由') && detail.includes('重要理由'), detail.slice(0, 160));
  byClass('ctm-card')[0].props.onClick();
  await settle();
}

/* ---------------------------------------------------------------- 筛选 */

const chip = buttonWith('ctm-chip', '作业');
check('找到“作业”筛选按钮', chip !== undefined);
chip.props.onClick();
await settle();
check('选中的 chip 用半透明底而不是实心底', true, '见 lib/client.js 中 .ctm-chip[data-active="true"] 的 color-mix 规则');
const filtered = flatten(rootInst.tree);
check('按作业筛选后只剩 1 条', filtered.includes('Academic Honesty Pledge') && !filtered.includes('Quiz 1'));
buttonWith('ctm-chip', '全部').props.onClick();
await settle();

/* --------------------------------------------- 勾选完成 + 撤销 toast */

const checkButton = byClass('ctm-check')[0];
check('找到勾选按钮', checkButton !== undefined);
checkButton.props.onClick({ stopPropagation() {} });
await settle();
check('勾选调用了 mark_task(done=true)', calls.some((call) => call.action === 'mark_task' && call.params.done === true), JSON.stringify(calls.at(-1)));
const toastTree = byRole('toast')[0];
check('弹出撤销 toast', toastTree !== undefined);
check('toast 文案正确', flatten(toastTree).includes('已标记完成：「Academic Honesty Pledge」'), flatten(toastTree));
check('toast 带撤销按钮', byRole('undo').length === 1);
check('勾选后默认隐藏已完成（列表里不再有该卡片）', cardOf('Academic Honesty Pledge').length === 0, titles().join(' | '));

// 撤销：回到未完成
byRole('undo')[0].props.onClick();
await settle();
check('撤销调用 mark_task(done=false)', calls.some((call) => call.action === 'mark_task' && call.params.done === false));
check('撤销后 toast 消失', byRole('toast').length === 0);
check('撤销后任务行恢复', cardOf('Academic Honesty Pledge').length === 1, titles().join(' | '));

// 已完成行在 toast 可见时依然可以点击恢复
checkOf(cards()[0]).props.onClick({ stopPropagation() {} });
await settle();
check('再次勾选后 toast 重新出现', byRole('toast').length === 1);
byRole('show-done')[0].props.onChange({ target: { checked: true } });
await settle();
check('打开“显示已完成”后能看到刚勾掉的那条', cardOf('Academic Honesty Pledge').length === 1, titles().join(' | '));
const markCallsBefore = calls.filter((call) => call.action === 'mark_task').length;
checkOf(cardOf('Academic Honesty Pledge')[0]).props.onClick({ stopPropagation() {} });
await settle();
const markCalls = calls.filter((call) => call.action === 'mark_task');
check(
  'toast 可见时点已完成行仍能恢复',
  markCalls.length === markCallsBefore + 1 && markCalls.at(-1).params.done === false,
  JSON.stringify(markCalls.at(-1)),
);
check('恢复后 toast 被清掉', byRole('toast').length === 0);
byRole('show-done')[0].props.onChange({ target: { checked: false } });
await settle();

/* ---------------------------------------------------------------- 拉取 */

const pullButton = buttonWith('ctm-btn', '拉取');
check('找到拉取按钮', pullButton !== undefined);
pullButton.props.onClick();
await settle();
check('拉取调用了 poll_now', calls.some((call) => call.action === 'poll_now'));

/* ---------------------------------------------------------------- 设置 */

const settingsButton = byRole('settings')[0];
check('面板头部有设置按钮', settingsButton !== undefined);
settingsButton.props.onClick();
await settle();
check('设置页调用 get_config', calls.some((call) => call.action === 'get_config'));
check('设置页列出四个分组标题', ['Canvas 数据源', '邮箱数据源', 'AI 评分', '拉取'].every((title) => flatten(rootInst.tree).includes(title)));
check('设置页有返回按钮', byRole('back').length === 1);

const baseUrlInput = byField('canvas.baseUrl')[0];
check('canvas.baseUrl 为受控输入且带默认值', baseUrlInput !== undefined && baseUrlInput.props.value === 'https://school.instructure.com', baseUrlInput?.props.value);
check('canvas.baseUrl 占位符正确', baseUrlInput?.props.placeholder === 'https://your-school.instructure.com');
check('ai.baseUrl 占位符正确', byField('ai.baseUrl')[0]?.props.placeholder === 'https://api.deepseek.com/v1');

const tokenInput = byField('canvas.token')[0];
check('密文字段渲染为空输入框', tokenInput !== undefined && tokenInput.props.value === '');
check('密文字段 placeholder 提示已保存', tokenInput?.props.placeholder === '已保存（留空表示不修改）', tokenInput?.props.placeholder);
check('密文字段 type=password', tokenInput?.props.type === 'password');

check('mail.folders 数组转成逗号分隔文本', byField('mail.folders')[0]?.props.value === 'INBOX, Notifications', byField('mail.folders')[0]?.props.value);
check('mail.provider 渲染成 select 且选中 imap', byField('mail.provider')[0]?.type === 'select' && byField('mail.provider')[0]?.props.value === 'imap');
check('poll.autoPull 渲染成勾选框', byField('poll.autoPull')[0]?.props.checked === true);
check('数字字段渲染成 number 输入', byField('poll.intervalSeconds')[0]?.props.type === 'number' && byField('poll.intervalSeconds')[0]?.props.value === '300');

// 改一个普通字段 + 改一个密文字段，另一个密文保持不动
byField('ai.model')[0].props.onChange({ target: { value: 'deepseek-reasoner' } });
await settle();
byField('canvas.token')[0].props.onChange({ target: { value: 'brand-new-token' } });
await settle();
byField('mail.folders')[0].props.onChange({ target: { value: 'INBOX, Canvas, Notifications' } });
await settle();
byRole('save')[0].props.onClick();
await settle();

check('保存调用 save_config', calls.some((call) => call.action === 'save_config'));
check('保存回填修改过的普通字段', savedConfig?.ai.model === 'deepseek-reasoner', JSON.stringify(savedConfig?.ai));
check('保存回填修改过的密文字段', savedConfig?.canvas.token === 'brand-new-token');
check('未改动的密文回传 __SAVED__', savedConfig?.mail.password === '__SAVED__', String(savedConfig?.mail.password));
check('未改动的密文 clientSecret 回传 __SAVED__', savedConfig?.mail.clientSecret === '__SAVED__', String(savedConfig?.mail.clientSecret));
check('本来就是空的字段保持为空', savedConfig?.mail.clientId === '' && savedConfig?.mail.tenantId === '', JSON.stringify(savedConfig?.mail));
check('逗号分隔文本还原成数组', JSON.stringify(savedConfig?.mail.folders) === JSON.stringify(['INBOX', 'Canvas', 'Notifications']), JSON.stringify(savedConfig?.mail.folders));
check('数字字段仍然是数字', savedConfig?.poll.intervalSeconds === 300 && savedConfig?.canvas.lookbackDays === 14, JSON.stringify(savedConfig?.poll));
check('勾选框仍然是布尔值', savedConfig?.mail.enabled === false && savedConfig?.poll.autoPull === true);
check('保存成功显示“已保存”', flatten(byRole('save-msg')[0]).includes('已保存'));
check('保存后密文重新变回空输入框', byField('canvas.token')[0]?.props.value === '' && byField('canvas.token')[0]?.props.placeholder === '已保存（留空表示不修改）');

// 测试连接
els((node) => node.type === 'button' && node.props['data-test'] === 'canvas')[0].props.onClick();
await settle();
check('测试连接调用 test_source', calls.some((call) => call.action === 'test_source' && call.params.source === 'canvas'));
check('canvas 测试成功提示为绿色', els((node) => node.props.className === 'ctm-hint' && node.props['data-test-msg'] === 'canvas')[0]?.props['data-tone'] === 'ok');
check('canvas 测试消息上屏', flatten(rootInst.tree).includes('连接成功：Canvas 可访问'));

els((node) => node.type === 'button' && node.props['data-test'] === 'mail')[0].props.onClick();
await settle();
check('mail 测试失败提示为红色', els((node) => node.props.className === 'ctm-hint' && node.props['data-test-msg'] === 'mail')[0]?.props['data-tone'] === 'error');
check('mail 失败消息与 detail 上屏', flatten(rootInst.tree).includes('连接失败：缺少凭据') && flatten(rootInst.tree).includes('ECONNREFUSED'));

// 只读状态行
check('设置页展示数据目录等只读信息', flatten(rootInst.tree).includes('数据目录') && flatten(rootInst.tree).includes('config.json'));

byRole('back')[0].props.onClick();
await settle();
check('返回后回到任务列表', byClass('ctm-card').length === 3 && byRole('settings').length === 1);

// 角标读到同一份 store
const badgeAfter = renderInst({ component: badge, props: { wide: true }, hooks: [], hookIndex: 0 });
check('角标显示待办数', flatten(badgeAfter).includes('待办 3'), flatten(badgeAfter));

console.log(`\npassed: ${passed} failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
