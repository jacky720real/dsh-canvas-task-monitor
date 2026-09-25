/**
 * dsh-canvas-task-monitor — 发布前清单自测
 * ---------------------------------------------------------------------------
 * 只做「DSH 会在运行时怎么读这个包」的静态复刻，不联网、不启动 DSH：
 *
 *   1. package.json 基本字段（name / type / main / exports）
 *   2. `dsh.client` 声明：必须 platform: "web"，且 exports["./client"] 指向真实文件
 *      —— DSH 的 client-modules 就是靠这两条决定「这个包有没有浏览器半区」
 *   3. 浏览器半区必须 `window.__ModuleLoader__.load({ id: <package name> })`：
 *      boot 图里的 entry id 就是包名，注册成别的名字会加载失败
 *   4. `dsh.bundle.patch` 指向真实 YAML，且里面恰好有一条 insert 行
 *   5. 宿主半区 `main` 指向真实文件，并且不 spawn 任何子进程（自包含承诺）
 *   6. README / LICENSE / .gitignore 在仓库根（GitHub 可发布）
 *
 * 用法：node test/manifest-check.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
}

/* --------------------------------------------------------------- 1. 清单 */

const pkg = JSON.parse(read('package.json'));

check('包名是 dsh-canvas-task-monitor', pkg.name === 'dsh-canvas-task-monitor', pkg.name);
check('type 是 module', pkg.type === 'module');
check('版本是合法 semver', /^\d+\.\d+\.\d+/.test(String(pkg.version)), pkg.version);
check('engines.node 至少 22.5', /(\d+)/.test(String(pkg.engines?.node ?? '')) && Number(/(\d+)/.exec(String(pkg.engines.node))[1]) >= 22, String(pkg.engines?.node));
check('dsh.engines.dsh 已声明', typeof pkg.dsh?.engines?.dsh === 'string' && pkg.dsh.engines.dsh.length > 0, String(pkg.dsh?.engines?.dsh));
check('声明了 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch));
check('files 覆盖 lib 与两个文档', Array.isArray(pkg.files) && ['lib', 'cordis.patch.yml', 'README.md'].every((f) => pkg.files.includes(f)));

/* ------------------------------------------------------- 2. 浏览器半区 */

check('dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));
check('dsh.client.inject 是字符串数组', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.every((s) => typeof s === 'string'), (pkg.dsh?.client?.inject ?? []).join(', '));

const clientRel = pkg.exports?.['./client'];
check('exports["./client"] 存在', typeof clientRel === 'string', String(clientRel));
const clientAbs = typeof clientRel === 'string' ? join(ROOT, clientRel.replace(/^\.\//, '')) : '';
check('浏览器半区文件在磁盘上', clientAbs !== '' && existsSync(clientAbs), clientRel);

if (clientAbs !== '' && existsSync(clientAbs)) {
  const clientSource = readFileSync(clientAbs, 'utf8');
  // 只认真正的那次调用：注释里也出现过 __ModuleLoader__.load({...}) 的写法。
  const loadMatch = /window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'[\s\S]*?factory:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(clientSource);
  check('浏览器半区调用了 __ModuleLoader__.load', loadMatch !== null);
  check('注册 id 等于包名（boot 图按包名寻址）', loadMatch?.[1] === pkg.name, String(loadMatch?.[1]));
  check('工厂形参是 require', loadMatch?.[2] === 'require', String(loadMatch?.[2]));
  check('最后返回 module.exports', /return\s+module\.exports\s*;/.test(clientSource));
  check('导出 apply 与 inject', /exports\.apply\s*=/.test(clientSource) && /exports\.inject\s*=/.test(clientSource));
  check('浏览器半区不 import node 内置模块', !/require\(['"]node:/.test(clientSource) && !/from\s+['"]node:/.test(clientSource));
}

/* ----------------------------------------------------------- 3. bundle 行 */

const patchRel = pkg.dsh?.bundle?.patch?.replace(/^\.\//, '') ?? '';
const patchAbs = patchRel === '' ? '' : join(ROOT, patchRel);
check('bundle patch 文件在磁盘上', patchAbs !== '' && existsSync(patchAbs), patchRel);

if (patchAbs !== '' && existsSync(patchAbs)) {
  const patch = readFileSync(patchAbs, 'utf8');
  const insertRows = [...patch.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm)].map((m) => m[1]);
  check('patch 恰好有一条 loader 行', insertRows.length === 1, insertRows.join(', '));
  check('loader id 是 canvas-task-monitor', insertRows[0] === 'canvas-task-monitor', String(insertRows[0]));
  check('loader name 指向本包', new RegExp(`name:\\s*'?${pkg.name}'?`).test(patch));
  check('patch 顶层是 insert 操作', /^-\s*insert:\s*$/m.test(patch));
  check('patch 不携带 config（数据目录由插件自己决定）', !/^\s*config:/m.test(patch));
}

/* ------------------------------------------------------------- 4. 宿主半区 */

check('main 指向 lib/index.js', pkg.main === 'lib/index.js' && existsSync(join(ROOT, 'lib/index.js')), String(pkg.main));
const hostSource = read('lib/index.js');
check('宿主半区不加载 child_process', !/from\s+['"]node:child_process['"]/.test(hostSource) && !/require\(['"]child_process['"]\)/.test(hostSource));
const storeSource = read('lib/store.js');
check('存储层用 node:sqlite', /['"]node:sqlite['"]/.test(storeSource));
check('存储层拒绝在没有 node:sqlite 时静默降级', /SQLITE_MISSING_MESSAGE/.test(storeSource));
check('UPSERT 不写 status', /DO UPDATE SET/.test(storeSource) && !/status\s*=\s*excluded\.status/.test(storeSource));
check('UPSERT 不写 created_at', !/created_at\s*=\s*excluded\.created_at/.test(storeSource));
check('宿主半区声明 webServer 路由前缀', hostSource.includes("'/canvas-task-monitor/api'"));
check('宿主半区有同源围栏', /isTrustedWebRequest/.test(hostSource));

/* ----------------------------------------------------------- 5. 发布物 */

for (const file of ['README.md', 'LICENSE', '.gitignore']) {
  check(`仓库根有 ${file}`, existsSync(join(ROOT, file)));
}
const readme = read('README.md');
check('README 写了安装步骤', readme.includes('apply.bat'));
check('README 写了卸载步骤', readme.includes('rollback.bat'));
check('LICENSE 是 MIT', read('LICENSE').includes('MIT License'));
check('程序文件没有 BOM', !read('lib/index.js').startsWith('\uFEFF') && !read('lib/client.js').startsWith('\uFEFF'));
check('install/ 有 apply 与 rollback 各两份', ['apply.ps1', 'apply.bat', 'rollback.ps1', 'rollback.bat'].every((f) => existsSync(join(ROOT, 'install', f))));

console.log('');
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  console.log(`失败的检查：${failures.join(' / ')}`);
  process.exitCode = 1;
}
