/**
 * 真框架集成自测（node test/cordis-check.mjs）
 * ---------------------------------------------------------------------------
 * 其余 fixture 用的都是桩 ctx；这一份用 DSH 自带的**真 cordis** 起一个真插件宿主，
 * 验证宿主半区在真实框架语意下的四件事：
 *   1. `ctx.inject(['webServer','webRuntime'])` 在服务就绪后真的把 fork 出来的
 *      webContext 交给 mount，且 `webContext.webServer` 能拿到服务；
 *   2. `webServer.register()` 收到的 route 形状（kind/path）与返回的 dispose；
 *   3. 真 `http.Server` + 真 IncomingMessage/ServerResponse 下，同源围栏、
 *      action 白名单、请求体解析、信封格式与配置落盘都正确；
 *   4. `ctx.effect` 拆解后路由被撤销、调度器定时器清干净（进程能自然退出）。
 *
 * cordis 不在仓库里（它是 DSH 自己的依赖），所以本文件按以下顺序找它，找不到就
 * 干净跳过（exit 0，打一行 SKIP），绝不把缺失当失败：
 *   1. 环境变量 `CTM_CORDIS`（指向 cordis 的 lib/index.js 或其包目录或其 @deepseek-ai 目录）；
 *   2. `<DSH_HOME>/profiles/node_modules/@deepseek-ai/cordis/lib/index.js`（DSH_HOME 默认 ~/.dsh）；
 *   3. 常见 DSH Desktop 安装位置的 resources/app/node_modules/@deepseek-ai/cordis/lib/index.js。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';

let passed = 0;
let failed = 0;
const failures = [];
const skips = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push(`${name} → ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push(`${name} → ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? ''} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const CORDIS_CANDIDATES = () => {
  const explicit = process.env.CTM_CORDIS;
  const out = [];
  if (explicit) {
    out.push(explicit, join(explicit, 'lib', 'index.js'), join(explicit, 'cordis', 'lib', 'index.js'));
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  out.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));
  const appRoots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app'),
    join(process.env.LOCALAPPDATA ?? '', 'DSH Desktop', 'resources', 'app'),
    join(process.env.ProgramFiles ?? '', 'DSH Desktop', 'resources', 'app'),
  ];
  for (const root of appRoots) out.push(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));
  return out;
};

const cordisPath = CORDIS_CANDIDATES().find((candidate) => candidate && existsSync(candidate));
if (!cordisPath) {
  console.log('SKIP 未找到 DSH 自带的 cordis（可用 CTM_CORDIS 指到它的 lib/index.js）');
  console.log('passed: 0  failed: 0');
  process.exit(0);
}

/* 让插件数据目录只由本次用例注入的 config.dataDir 决定。 */
delete process.env.CTM_DATA_DIR;

const { Context } = await import(pathToFileURL(cordisPath).href);
const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

const root = mkdtempSync(join(tmpdir(), 'ctm-cordis-'));
const routes = [];
let disposedRoutes = 0;
let fiber = null;
const app = new Context();
app.provide('webServer', {
  host: '127.0.0.1',
  port: 0,
  register(route) {
    routes.push(route);
    return () => {
      disposedRoutes += 1;
    };
  },
});
app.provide('webRuntime', { lanAddresses: [], trustedHosts: [] });

const settle = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

console.log(`cordis: ${cordisPath}`);

await checkAsync('真 cordis 里 apply 后路由已挂载', async () => {
  fiber = app.plugin(plugin, { dataDir: root });
  await settle();
  eq(routes.length, 1, '路由条数');
});
check('插件导出 name/inject/apply', () => {
  eq(plugin.name, 'canvas-task-monitor', 'name');
  assert(Array.isArray(plugin.inject), 'inject 必须是数组');
  eq(typeof plugin.apply, 'function', 'apply');
});
check('route.kind === prefix', () => eq(routes[0]?.kind, 'prefix'));
check('route.path === /canvas-task-monitor/api', () => eq(routes[0]?.path, '/canvas-task-monitor/api'));
check('route.handler 是函数', () => eq(typeof routes[0]?.handler, 'function'));

const handler = routes[0].handler;
const server = http.createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/canvas-task-monitor/api`;
const post = (body, headers = {}) =>
  fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

await checkAsync('POST status → 200 / ok:true / 带上版本与数据目录', async () => {
  const response = await post({ action: 'status' });
  eq(response.status, 200, '状态码');
  const body = await response.json();
  eq(body.ok, true, '信封');
  eq(typeof body.data?.version, 'string', 'version');
  eq(body.data?.dataDir, root, '数据目录必须来自本次注入的 config');
  assert(body.data?.counts !== undefined, 'counts 缺失');
});
await checkAsync('POST list_tasks → data 是数组', async () => {
  const response = await post({ action: 'list_tasks', params: { limit: 5 } });
  eq(response.status, 200, '状态码');
  const body = await response.json();
  eq(body.ok, true, '信封');
  assert(Array.isArray(body.data), 'data 必须是数组');
});
await checkAsync('POST summarize_pending → data.total 是数字', async () => {
  const response = await post({ action: 'summarize_pending' });
  eq(response.status, 200, '状态码');
  const body = await response.json();
  eq(body.ok, true, '信封');
  eq(typeof body.data?.total, 'number', 'total');
});
await checkAsync('POST get_config → 200 / ok:true', async () => {
  const response = await post({ action: 'get_config' });
  eq(response.status, 200, '状态码');
  eq((await response.json()).ok, true, '信封');
});
await checkAsync('POST save_config → 落盘后 get_config 读回同一 baseUrl', async () => {
  const response = await post({ action: 'save_config', params: { config: { canvas: { baseUrl: 'https://canvas.example.edu' } } } });
  eq(response.status, 200, '状态码');
  const body = await response.json();
  eq(body.ok, true, '信封');
  assert(Array.isArray(body.data?.problems), 'problems 必须是数组');
  assert(String(body.data?.configPath ?? '').startsWith(root), `configPath 必须在数据目录内：${body.data?.configPath}`);
  eq(existsSync(join(root, 'config.json')), true, 'config.json 未落盘');
  const reread = await post({ action: 'get_config' });
  eq((await reread.json()).data?.config?.canvas?.baseUrl, 'https://canvas.example.edu', '读回的 baseUrl');
});
await checkAsync('mark_task 不存在的 id → 幂等成功且 data 为 null', async () => {
  const response = await post({ action: 'mark_task', params: { id: 999999, done: true } });
  eq(response.status, 200, '状态码');
  const body = await response.json();
  eq(body.ok, true, '信封');
  eq(body.data, null, 'data');
});
await checkAsync('未知 action → 400 且提示方法名', async () => {
  const response = await post({ action: 'definitely_not_an_action' });
  eq(response.status, 400, '状态码');
  assert(String((await response.json()).message ?? '').includes('definitely_not_an_action'), '提示里应含方法名');
});
await checkAsync('GET → 405 且 allow: POST', async () => {
  const response = await fetch(base, { method: 'GET' });
  eq(response.status, 405, '状态码');
  eq(response.headers.get('allow'), 'POST', 'allow 头');
});
await checkAsync('sec-fetch-site: cross-site → 403', async () => {
  eq((await post({ action: 'status' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
});
await checkAsync('同源 Origin → 200', async () => {
  eq((await post({ action: 'status' }, { origin: `http://127.0.0.1:${port}` })).status, 200);
});
await checkAsync('异源 Origin → 403', async () => {
  eq((await post({ action: 'status' }, { origin: 'http://evil.example.com' })).status, 403);
});
await checkAsync('非 JSON 请求体 → 400', async () => {
  const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all' });
  eq(response.status, 400, '状态码');
});
await checkAsync('Host: evil.example.com → 403（非回环且不在 trustedHosts）', async () => {
  const raw = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'POST /canvas-task-monitor/api HTTP/1.1\r\nHost: evil.example.com\r\nContent-Type: application/json\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{"action":"status"}',
      );
    });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(text));
    socket.on('error', () => resolve(text));
  });
  assert(/^HTTP\/1\.1 403/.test(raw), raw.split('\r\n')[0]);
});

await new Promise((resolve) => server.close(resolve));
try {
  await app.stop?.();
} catch {
  /* 忽略 */
}
if (typeof fiber?.dispose === 'function') {
  try {
    await fiber.dispose();
  } catch {
    /* 忽略 */
  }
}
await settle();
check('拆解后路由 dispose 被调用', () => assert(disposedRoutes >= 1, `disposed=${disposedRoutes}`));
check('拆解后无遗留 Timeout 句柄', () => {
  const handles = process.getActiveResourcesInfo();
  assert(!handles.includes('Timeout'), handles.join(','));
});
check('拆解后无遗留 TCPSERVERWRAP 句柄', () => {
  const handles = process.getActiveResourcesInfo();
  assert(!handles.includes('TCPSERVERWRAP'), handles.join(','));
});

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* 忽略 */
}
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all cordis integration checks passed');
}
for (const item of skips) console.log(`SKIP ${item}`);
