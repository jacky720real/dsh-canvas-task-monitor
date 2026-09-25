/**
 * 插件自己的配置：默认值、读写、密钥掩码、校验。
 *
 * 设计要点（用户明确要求"插件自带一切，不碰本机文件"）：
 *   - 配置只存在插件自己的数据目录下的 config.json，不读 .env、不读项目目录；
 *   - 保存时原子写入（先写 .tmp 再 rename），UTF-8 无 BOM；
 *   - 面板取配置时所有密钥字段被替换成掩码 SAVED_SECRET，原值永不回传浏览器；
 *   - 保存时收到 SAVED_SECRET 表示"保持原值"。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { asInt, asString, asStringArray, splitList } from './util.js';

/** 环境变量覆盖数据目录（调试/多实例用）。 */
export const DATA_DIR_ENV = 'CTM_DATA_DIR';

/** 密钥掩码：浏览器看到这个字符串就表示"已保存，留空即不修改"。 */
export const SAVED_SECRET = '__SAVED__';

/** 密钥字段路径（点号分隔）。 */
export const SECRET_PATHS = ['canvas.token', 'mail.password', 'mail.clientSecret', 'ai.apiKey'];

export const CATEGORIES = ['assignment', 'activity', 'reminder'];
export const SOURCES = ['canvas', 'mail'];

/** 配置默认值。scoring 权重与旧项目保持一致（urgency*10 + importance*8）。 */
export function defaultConfig() {
  return {
    version: 1,
    canvas: {
      enabled: true,
      baseUrl: '',
      token: '',
      lookbackDays: 30,
      timeoutMs: 20_000,
      maxAttempts: 3,
      requestsPerSecond: 3,
    },
    mail: {
      enabled: false,
      provider: 'imap',
      host: '',
      port: 993,
      user: '',
      password: '',
      folders: ['INBOX'],
      lookbackDays: 14,
      tenantId: '',
      clientId: '',
      clientSecret: '',
      senderDomains: [],
    },
    ai: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.1,
      maxOutputTokens: 4000,
      timeoutMs: 60_000,
      batchSize: 15,
    },
    poll: {
      autoPull: true,
      intervalSeconds: 600,
    },
    scoring: {
      urgencyWeight: 10,
      importanceWeight: 8,
    },
  };
}

/** 数据目录：CTM_DATA_DIR > 配置里的 dataDir > <DSH_HOME>/canvas-task-monitor。 */
export function resolveDataDir(rawConfig = {}) {
  const fromEnv = asString(process.env?.[DATA_DIR_ENV]).trim();
  if (fromEnv.length > 0) return resolve(fromEnv);
  const fromConfig = asString(rawConfig?.dataDir).trim();
  if (fromConfig.length > 0) return resolve(fromConfig);
  const dshHome = asString(process.env?.DSH_HOME).trim();
  const base = dshHome.length > 0 ? dshHome : join(homedir(), '.dsh');
  return join(base, 'canvas-task-monitor');
}

export function configPathIn(dataDir) {
  return join(dataDir, 'config.json');
}

export function dbPathIn(dataDir) {
  return join(dataDir, 'tasks.db');
}

/** 把任意（可能是手改过的、缺字段的、类型错的）输入收敛成完整配置。 */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const canvas = objectOf(input.canvas);
  const mail = objectOf(input.mail);
  const ai = objectOf(input.ai);
  const poll = objectOf(input.poll);
  const scoring = objectOf(input.scoring);

  return {
    version: 1,
    dataDir: asString(input.dataDir).trim(),
    canvas: {
      enabled: canvas.enabled === undefined ? base.canvas.enabled : canvas.enabled !== false,
      baseUrl: asString(canvas.baseUrl).trim().replace(/\/+$/, ''),
      token: asString(canvas.token).trim(),
      lookbackDays: asInt(canvas.lookbackDays, base.canvas.lookbackDays, 1, 3650),
      timeoutMs: asInt(canvas.timeoutMs, base.canvas.timeoutMs, 1000, 300_000),
      maxAttempts: asInt(canvas.maxAttempts, base.canvas.maxAttempts, 1, 10),
      requestsPerSecond: Number(canvas.requestsPerSecond) > 0 ? Number(canvas.requestsPerSecond) : base.canvas.requestsPerSecond,
    },
    mail: {
      enabled: mail.enabled === true,
      provider: asString(mail.provider).toLowerCase() === 'graph' ? 'graph' : 'imap',
      host: asString(mail.host).trim(),
      port: asInt(mail.port, base.mail.port, 1, 65_535),
      user: asString(mail.user).trim(),
      password: asString(mail.password),
      folders: normalizeFolders(mail.folders),
      lookbackDays: asInt(mail.lookbackDays, base.mail.lookbackDays, 1, 3650),
      tenantId: asString(mail.tenantId).trim(),
      clientId: asString(mail.clientId).trim(),
      clientSecret: asString(mail.clientSecret),
      senderDomains: asStringArray(mail.senderDomains).map((item) => item.toLowerCase()),
    },
    ai: {
      enabled: ai.enabled === true,
      baseUrl: asString(ai.baseUrl).trim().replace(/\/+$/, ''),
      apiKey: asString(ai.apiKey).trim(),
      model: asString(ai.model).trim(),
      temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : base.ai.temperature,
      maxOutputTokens: asInt(ai.maxOutputTokens, base.ai.maxOutputTokens, 16, 32_000),
      timeoutMs: asInt(ai.timeoutMs, base.ai.timeoutMs, 1000, 300_000),
      batchSize: asInt(ai.batchSize, base.ai.batchSize, 1, 50),
    },
    poll: {
      autoPull: poll.autoPull !== false,
      intervalSeconds: asInt(poll.intervalSeconds, base.poll.intervalSeconds, 30, 86_400),
    },
    scoring: {
      urgencyWeight: asInt(scoring.urgencyWeight, base.scoring.urgencyWeight, 0, 100),
      importanceWeight: asInt(scoring.importanceWeight, base.scoring.importanceWeight, 0, 100),
    },
  };
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeFolders(value) {
  if (Array.isArray(value)) {
    const list = asStringArray(value);
    return list.length > 0 ? list : ['INBOX'];
  }
  const list = splitList(value);
  return list.length > 0 ? list : ['INBOX'];
}

/** 读取配置：文件不存在 → 默认值；文件损坏 → 抛错（调用方决定怎么提示）。 */
export function loadConfig(dataDir) {
  const path = configPathIn(dataDir);
  if (!existsSync(path)) return { config: defaultConfig(), path, exists: false, dataDir };
  const text = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${path}（${error.message}）`);
  }
  return { config: normalizeConfig(parsed), path, exists: true, dataDir };
}

/** 原子保存配置（同目录 .tmp → rename），返回规范化后的配置。 */
export function saveConfig(dataDir, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const path = configPathIn(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new Error(`写入配置失败：${path}（${error.message}）`);
  }
  return { config, path };
}

function readPath(object, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc !== null && typeof acc === 'object' ? acc[key] : undefined), object);
}

function writePath(object, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (acc[key] === null || typeof acc[key] !== 'object') acc[key] = {};
    return acc[key];
  }, object);
  target[last] = value;
}

/** 回传浏览器用的配置：密钥换成掩码。 */
export function maskSecrets(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const dotted of SECRET_PATHS) {
    const value = asString(readPath(copy, dotted));
    writePath(copy, dotted, value.length > 0 ? SAVED_SECRET : '');
  }
  return copy;
}

/** 保存时合并：掩码 → 沿用旧值；空串 → 真的清空。 */
export function mergeSecrets(incoming, current) {
  const merged = JSON.parse(JSON.stringify(incoming ?? {}));
  for (const dotted of SECRET_PATHS) {
    const value = asString(readPath(merged, dotted));
    if (value === SAVED_SECRET) writePath(merged, dotted, asString(readPath(current, dotted)));
  }
  return normalizeConfig(merged);
}

/** 配置体检：返回问题列表（不影响保存，只在 UI 提示）。 */
export function validateConfig(config) {
  const problems = [];
  const canvas = config.canvas ?? {};
  if (canvas.enabled) {
    if (asString(canvas.baseUrl).length === 0) problems.push('已启用 Canvas，但未填写 Canvas 地址');
    if (asString(canvas.token).length === 0) problems.push('已启用 Canvas，但未填写 Access Token');
  }
  const mail = config.mail ?? {};
  if (mail.enabled) {
    if (mail.provider === 'graph') {
      if (!mail.tenantId || !mail.clientId || !mail.clientSecret) problems.push('Graph 模式需要 tenantId / clientId / clientSecret');
      if (!mail.user) problems.push('Graph 模式需要填写要读取的邮箱地址（user）');
    } else if (!mail.host || !mail.user || !mail.password) {
      problems.push('IMAP 模式需要 host / user / password');
    }
  }
  const ai = config.ai ?? {};
  if (ai.enabled) {
    if (!ai.baseUrl) problems.push('已启用 AI 评分，但未填写 API 地址');
    if (!ai.apiKey) problems.push('已启用 AI 评分，但未填写 API Key');
    if (!ai.model) problems.push('已启用 AI 评分，但未填写模型名');
  }
  if (!canvas.enabled && !mail.enabled) problems.push('Canvas 与邮箱都未启用，拉取不会有任何数据');
  return problems;
}
