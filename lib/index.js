/**
 * canvas-task-monitor — DSH 插件宿主半区
 * ---------------------------------------------------------------------------
 * 这一半区只做三件事，全部在 DSH 主进程里**同步跑完**，不拉子进程、不监听端口、不起 HTTP 服务：
 *   1. 在 DSH 自带的 webServer 上挂一条同源路由 `/canvas-task-monitor/api`，
 *      供浏览器半区（lib/client.js）POST 调用；
 *   2. 把 action 翻译成对 config/store/pipeline 的调用（见 ACTIONS 白名单）；
 *   3. 按配置里的间隔定时拉取（poll.autoPull）。
 *
 * 与旧版（Python bridge 子进程）的区别：数据层用 `node:sqlite` 直接在进程内读写，
 * 插件自带配置（<DSH_HOME>/canvas-task-monitor/config.json），不读 .env、不依赖项目目录。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { dbPathIn, configPathIn, loadConfig, maskSecrets, mergeSecrets, normalizeConfig, resolveDataDir, saveConfig, validateConfig, DATA_DIR_ENV } from './config.js';
import { openStore, isAvailable as sqliteAvailable, SQLITE_MISSING_MESSAGE } from './store.js';
import { pollOnce, testSource, describeSources } from './pipeline.js';
import { sortTasks } from './scoring.js';
import { asInt, asString, errorText, utcNowIso } from './util.js';

/** cordis 插件名（loader 条目 id 与之一致，便于日志归组）。 */
export const name = 'canvas-task-monitor';

/** 本插件不依赖其它 cordis 服务；webServer 通过 `ctx.inject` 惰性获取。 */
export const inject = [];

/** 插件版本（status 里回给面板显示）。 */
export const VERSION = '1.0.0';

const ROUTE_PREFIX = '/canvas-task-monitor/api';
const LOG_TAG = '[canvas-task-monitor]';
const BODY_LIMIT = 1 << 20;

/**
 * HTTP action 白名单。不在表里的 action 一律 400，
 * 避免把宿主半区变成任意调用入口。
 */
const ACTIONS = new Set([
  'status',
  'summarize_pending',
  'list_tasks',
  'get_task',
  'mark_task',
  'poll_now',
  'get_config',
  'save_config',
  'test_source',
  'reset_data',
]);

/* ------------------------------------------------------------------ 工具 */

function parseAuthority(host) {
  if (typeof host !== 'string' || host.length === 0) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * 只接受本机回环 / 可信 host 发起的同源请求（与 dsh-mcp-connector 同款围栏）。
 * 目的是挡住浏览器里其它站点对本路由的跨站调用。
 */
export function isTrustedWebRequest(request, trustedHosts = []) {
  const host = request?.headers?.host;
  const hostUrl = parseAuthority(host);
  if (hostUrl === null) return false;
  const trusted = trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    return entryUrl !== null && entryUrl.host === hostUrl.host;
  });
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false;
  if (String(request?.headers?.['sec-fetch-site'] ?? '') === 'cross-site') return false;
  const origin = request?.headers?.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed;
}

/** 任务行 → 面板需要的形状（去掉 raw_json 这种大字段）。 */
export function toPublicTask(task) {
  if (task === null || task === undefined) return null;
  const copy = { ...task };
  delete copy.raw_json;
  return copy;
}

/* ----------------------------------------------------------- 宿主运行时 */

/**
 * 插件运行时：持有配置、数据目录、SQLite 连接和拉取锁。
 * 所有耗时动作（拉取）都串行化，避免两次拉取同时写库。
 */
export class Runtime {
  constructor(options = {}) {
    this.logger = options.logger ?? console;
    this.rawConfig = options.config ?? {};
    this.dataDir = resolveDataDir(this.rawConfig);
    this.fetchImpl = options.fetchImpl ?? null; // 仅供自测注入；生产路径用全局 fetch
    this.store = null;
    this.polling = false;
    this.lastStats = null;
    this.timer = null;
    this.disposed = false;
  }

  get dbPath() {
    return dbPathIn(this.dataDir);
  }

  get configPath() {
    return configPathIn(this.dataDir);
  }

  /** 每次都从磁盘读配置（设置页刚保存完就能立刻生效）。 */
  loadConfig() {
    return loadConfig(this.dataDir);
  }

  ensureDataDir() {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    return this.dataDir;
  }

  /** 惰性打开 SQLite（node:sqlite 缺失时抛出带说明的错误）。 */
  ensureStore() {
    if (this.store !== null) return this.store;
    this.ensureDataDir();
    this.store = openStore(this.dbPath);
    return this.store;
  }

  close() {
    if (this.store !== null) {
      try {
        this.store.close();
      } catch {
        /* 忽略 */
      }
      this.store = null;
    }
  }

  describe() {
    const loaded = this.loadConfig();
    let counts = { pending: 0, done: 0, total: 0 };
    let sqliteError = null;
    if (sqliteAvailable()) {
      try {
        counts = this.ensureStore().counts();
      } catch (error) {
        sqliteError = errorText(error, '打开数据库失败');
      }
    }
    return {
      version: VERSION,
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      configPath: this.configPath,
      configExists: loaded.exists,
      configError: null,
      sqlite: sqliteAvailable(),
      sqliteError,
      counts,
      sources: describeSources(loaded.config),
      problems: validateConfig(loaded.config),
      lastPollAt: this.lastStats === null ? null : this.lastStats.finished_at,
      lastPollStats: this.lastStats,
      polling: this.polling,
      autoPull: loaded.config.poll.autoPull,
      intervalSeconds: loaded.config.poll.intervalSeconds,
      envOverride: asString(process.env?.[DATA_DIR_ENV]).length > 0,
      now: utcNowIso(),
    };
  }

  /** 跑一轮拉取；已有拉取进行中时直接拒绝（面板会提示"稍候"）。 */
  async poll(reason = 'manual', sources = null) {
    if (this.polling) return { ok: false, message: '已有拉取任务在执行中，请稍候' };
    this.polling = true;
    try {
      const loaded = this.loadConfig();
      const store = this.ensureStore();
      const stats = await pollOnce({
        dataDir: this.dataDir,
        config: loaded.config,
        logger: this.logger,
        store,
        sources: sources ?? undefined,
        fetchImpl: this.fetchImpl ?? undefined,
      });
      this.lastStats = stats;
      const summary = `sources=${stats.sources} changes=${stats.changes} tasks=${stats.tasks} llm=${stats.llm_calls}`;
      this.logger?.info?.(`${LOG_TAG} 拉取完成（${reason}）：${summary}`);
      for (const warning of stats.warnings.slice(0, 5)) this.logger?.warn?.(`${LOG_TAG} ${warning}`);
      for (const error of stats.errors.slice(0, 5)) this.logger?.warn?.(`${LOG_TAG} ${error}`);
      return { ok: true, data: stats };
    } catch (error) {
      const message = errorText(error, '拉取失败');
      this.logger?.error?.(`${LOG_TAG} 拉取失败（${reason}）：${message}`);
      return { ok: false, message };
    } finally {
      this.polling = false;
    }
  }

  /** 定时拉取：先等 20s 再跑第一轮，然后按 intervalSeconds 循环。 */
  startScheduler() {
    this.stopScheduler();
    if (this.disposed) return;
    const loaded = this.loadConfig();
    if (loaded.config.poll.autoPull !== true) return;
    const intervalMs = asInt(loaded.config.poll.intervalSeconds, 600, 30, 86_400) * 1000;
    let first = true;
    const tick = async () => {
      if (this.disposed) return;
      try {
        if (sqliteAvailable()) await this.poll('auto');
      } catch (error) {
        this.logger?.warn?.(`${LOG_TAG} 自动拉取异常：${errorText(error, '未知错误')}`);
      }
      this.timer = setTimeout(tick, intervalMs);
      this.timer?.unref?.();
    };
    const delay = first ? 20_000 : intervalMs;
    first = false;
    this.timer = setTimeout(tick, delay);
    this.timer?.unref?.();
    this.logger?.debug?.(`${LOG_TAG} 已开启自动拉取，间隔 ${intervalMs / 1000}s`);
  }

  stopScheduler() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(reason = '插件卸载') {
    this.disposed = true;
    this.stopScheduler();
    this.close();
    this.logger?.debug?.(`${LOG_TAG} 已释放（${reason}）`);
  }
}

/* ---------------------------------------------------------------- action */

/** action → 处理函数。全部返回 { ok, data } 或 { ok:false, message }。 */
export function createHandlers(runtime) {
  const fail = (error) => ({ ok: false, message: errorText(error, '未知错误') });

  return {
    status() {
      try {
        return { ok: true, data: runtime.describe() };
      } catch (error) {
        return fail(error);
      }
    },

    summarize_pending() {
      try {
        return { ok: true, data: runtime.ensureStore().summarize(Date.now()) };
      } catch (error) {
        return fail(error);
      }
    },

    list_tasks(params) {
      try {
        const category = asString(params?.category);
        const status = asString(params?.status);
        const limit = asInt(params?.limit, 500, 1, 5000);
        const rows = runtime.ensureStore().listTasks({ category, status, limit });
        return { ok: true, data: sortTasks(rows).map(toPublicTask) };
      } catch (error) {
        return fail(error);
      }
    },

    get_task(params) {
      try {
        const task = runtime.ensureStore().getTask(asInt(params?.task_id, 0));
        return { ok: true, data: toPublicTask(task) };
      } catch (error) {
        return fail(error);
      }
    },

    mark_task(params) {
      try {
        const task = runtime.ensureStore().setStatus(asInt(params?.task_id, 0), params?.done === false ? 'pending' : 'done');
        return { ok: true, data: toPublicTask(task) };
      } catch (error) {
        return fail(error);
      }
    },

    async poll_now() {
      const result = await runtime.poll('manual');
      if (result.ok !== true) return result;
      try {
        return {
          ok: true,
          data: {
            stats: result.data,
            summary: runtime.ensureStore().summarize(Date.now()),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },

    get_config() {
      try {
        const loaded = runtime.loadConfig();
        return {
          ok: true,
          data: {
            config: maskSecrets(loaded.config),
            dataDir: runtime.dataDir,
            configPath: runtime.configPath,
            configExists: loaded.exists,
            problems: validateConfig(loaded.config),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },

    save_config(params) {
      try {
        const incoming = params?.config ?? params ?? {};
        const current = runtime.loadConfig().config;
        const merged = mergeSecrets(incoming, current);
        const saved = saveConfig(runtime.dataDir, merged);
        runtime.startScheduler();
        return {
          ok: true,
          data: {
            config: maskSecrets(saved.config),
            configPath: saved.path,
            problems: validateConfig(saved.config),
            savedAt: utcNowIso(),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },

    async test_source(params) {
      try {
        const loaded = runtime.loadConfig();
        const source = asString(params?.source);
        const result = await testSource(loaded.config, source);
        return { ok: true, data: { source, ...result } };
      } catch (error) {
        return fail(error);
      }
    },

    reset_data() {
      try {
        const store = runtime.ensureStore();
        store.reset();
        return { ok: true, data: { ...store.counts(), resetAt: utcNowIso() } };
      } catch (error) {
        return fail(error);
      }
    },
  };
}

/* ---------------------------------------------------------------- 路由 */

export function mountRoutes(webContext, runtime, logger) {
  const trustedHosts = webContext?.webRuntime?.trustedHosts ?? [];
  const handlers = createHandlers(runtime);
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrustedWebRequest(request, trustedHosts)) {
        writeJson(response, 403, { ok: false, message: 'forbidden' });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        writeJson(response, 400, { ok: false, message: errorText(error, '请求体解析失败') });
        return;
      }
      const action = asString(body.action);
      if (!ACTIONS.has(action)) {
        writeJson(response, 400, { ok: false, message: `未知方法 "${action}"` });
        return;
      }
      const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
      try {
        const result = await handlers[action](params);
        if (result?.ok === true) writeJson(response, 200, { ok: true, data: result.data ?? null });
        else writeJson(response, 200, { ok: false, message: asString(result?.message) || '调用失败' });
      } catch (error) {
        const message = errorText(error, '调用失败');
        logger?.warn?.(`${LOG_TAG} ${action} 失败：${message}`);
        writeJson(response, 502, { ok: false, message });
      }
    },
  };
  const dispose = webContext.webServer.register(route);
  logger?.debug?.(`${LOG_TAG} 已挂载 ${ROUTE_PREFIX}`);
  return typeof dispose === 'function' ? dispose : () => {};
}

/* -------------------------------------------------------------------- 入口 */

export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  const runtime = new Runtime({ config, logger });

  try {
    runtime.ensureDataDir();
  } catch (error) {
    logger?.warn?.(`${LOG_TAG} 数据目录不可用：${errorText(error, '未知错误')}`);
  }
  if (!sqliteAvailable()) logger?.warn?.(`${LOG_TAG} ${SQLITE_MISSING_MESSAGE}`);

  let disposeRoutes = null;
  let mounted = false;
  const mount = (webContext) => {
    if (mounted) return;
    try {
      disposeRoutes = mountRoutes(webContext, runtime, logger);
      mounted = true;
      runtime.startScheduler();
    } catch (error) {
      logger?.error?.(`${LOG_TAG} 挂载路由失败：${errorText(error, '未知错误')}`);
    }
  };

  if (typeof ctx?.inject === 'function') ctx.inject(['webServer', 'webRuntime'], mount);
  else mount(ctx);

  const teardown = () => {
    try {
      disposeRoutes?.();
    } catch {
      /* 忽略 */
    }
    disposeRoutes = null;
    mounted = false;
    runtime.dispose('插件卸载');
  };
  if (typeof ctx?.effect === 'function') ctx.effect(() => teardown, 'canvas-task-monitor: web 路由与拉取调度');
  else if (typeof ctx?.on === 'function') ctx.on('dispose', teardown);

  return { runtime, dispose: teardown };
}

/** 诊断用：数据目录里有什么（面板不调用，只给排障用）。 */
export function listDataDir(dataDir) {
  const dir = asString(dataDir) || resolveDataDir({});
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((entry) => {
    const path = join(dir, entry);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    return { name: entry, size };
  });
}

export { normalizeConfig };
