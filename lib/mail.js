/**
 * 邮箱连接器（IMAP / Microsoft Graph）——从 Python 版 connectors/{imap_mail,graph_mail}.py 移植。
 *
 * 设计要点（与 Python 版保持一致）：
 * - 只负责"拉数据"，不做变更判断、不碰数据库。
 * - payload 字段名固定为 subject / from / receivedDateTime / bodyPreview 四项，
 *   顺序也必须保持，因为 core/hashing.py 的 mail 白名单按这四项算内容指纹；
 *   多一个少一个都会让哈希每轮都变、导致每次都误报变更并白烧 LLM token。
 * - external_id 前缀 graph: / imap: / imap:seq: 与 Python 版一字不差；
 *   中途换 provider 会把同一封邮件当成新条目，属于已知取舍。
 * - 零依赖：只用 node: 内置模块与全局 fetch；connect / fetchImpl 都可以注入，
 *   便于离线 fixture 完整跑通协议而完全不碰网络。
 *
 * 【Graph 鉴权坑点】client_credentials 需要租户管理员授予应用级 Mail.Read，
 * 绝大多数学校租户不给学生自助授予，会直接 401/403 —— 此时应改用 IMAP。
 *
 * @module dsh-canvas-task-monitor/lib/mail
 */

import tls from 'node:tls';
import { Buffer } from 'node:buffer';

export const SOURCE_MAIL = 'mail';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_RATE_LIMIT_RPS = 2;

// ---- Graph ----
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const SELECT_FIELDS = 'subject,from,receivedDateTime,bodyPreview,internetMessageId';
const TOKEN_EXPIRY_SKEW_MS = 60_000; // 提前 60 秒视为过期，避免用到临界令牌
const PAGE_TOP = 50;
const MAX_DATE_CHARS = 200; // 异常时间字段保留原文时的截断上限
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE = 1.5;

// ---- IMAP ----
const IMAP_DATE_FORMAT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const BODY_PREVIEW_CHARS = 500;
const TAG_PATTERN = /<[^>]+>/g;
const FETCH_CHUNK_SIZE = 20; // 每批 FETCH 的序号数，避免大邮箱一次性把内存打爆
const IMAP_FETCH_ITEM = 'BODY.PEEK[]';

// IMAP 命令清单（LOGIN / SELECT / SEARCH / FETCH / LOGOUT）
const IMAP_HINT = '请改用 IMAP（把 mail.provider 改成 "imap"，填 host/username/password 即可）。';

const GRAPH_REQUIRED_FIELDS = ['tenantId', 'clientId', 'clientSecret', 'user'];
const IMAP_REQUIRED_FIELDS = ['host', 'username', 'password'];

// ---------------------------------------------------------------------------
// 配置检查
// ---------------------------------------------------------------------------

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** 只把「有值」的键放进目标对象，避免 undefined 覆盖掉默认值。 */
function assignDefined(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) target[key] = value;
  }
  return target;
}

/** 扁平的 `mail.folders[0]` -> 连接器用的单个 `folder`。 */
function firstFolderOf(config) {
  const folders = config && config.folders;
  if (!Array.isArray(folders)) return undefined;
  for (const entry of folders) {
    if (!isBlank(entry)) return String(entry);
  }
  return undefined;
}

/** 扁平 `timeoutMs` -> 底层 `timeoutSeconds`（>=1 秒）。 */
function timeoutSecondsOf(config) {
  const ms = Number(config && config.timeoutMs);
  return Number.isFinite(ms) && ms > 0 ? Math.max(ms / 1000, 1) : undefined;
}

/** 扁平 `requestsPerSecond` -> 底层 `rateLimitRps`。 */
function rateLimitRpsOf(config) {
  const rps = Number(config && config.requestsPerSecond);
  return Number.isFinite(rps) && rps > 0 ? rps : undefined;
}

/** 扁平 `maxAttempts`/`backoffBase` -> 底层 `retry.{maxAttempts,backoffBase}`。 */
function retryOf(config) {
  const retry = {};
  if (config && config.maxAttempts !== undefined) retry.maxAttempts = config.maxAttempts;
  if (config && config.backoffBase !== undefined) retry.backoffBase = config.backoffBase;
  return Object.keys(retry).length > 0 ? retry : undefined;
}

/**
 * 取 Graph 配置段。
 *
 * 插件自身（lib/config.js / lib/pipeline.js）传下来的是**扁平**形状
 * （`mail.tenantId`、`mail.clientSecret`、`mail.user` ...），而历史调用方与既有
 * 测试用的是**嵌套**形状（`mail.graph.*`）。这里先把扁平字段铺平，再让嵌套段
 * 覆盖，两种形状都能用；嵌套优先，因为它是更"具体"的写法。
 */
function graphSection(config) {
  const flat = config && typeof config === 'object' ? config : {};
  const section = {
    tenantId: flat.tenantId,
    clientId: flat.clientId,
    clientSecret: flat.clientSecret,
    user: flat.user,
    mailboxFolder: flat.mailboxFolder,
    filterFromDomains: flat.senderDomains,
    lookbackDays: flat.lookbackDays,
  };
  if (isBlank(section.mailboxFolder)) section.mailboxFolder = firstFolderOf(flat);
  assignDefined(section, {
    timeoutSeconds: timeoutSecondsOf(flat),
    rateLimitRps: rateLimitRpsOf(flat),
    retry: retryOf(flat),
  });
  return assignDefined({ ...section }, flat.graph);
}

/**
 * 取 IMAP 配置段（扁平铺平 + 嵌套覆盖）。
 *
 * 扁平形状里用户名字段叫 `user`（对齐 Graph 的写法），连接器内部叫 `username`，
 * 这里做一次改名；目录用 `folders[0]` 对到连接器的 `folder`。
 */
function imapSection(config) {
  const flat = config && typeof config === 'object' ? config : {};
  const section = {
    host: flat.host,
    port: flat.port,
    username: flat.user,
    password: flat.password,
    folder: firstFolderOf(flat),
    lookbackDays: flat.lookbackDays,
  };
  assignDefined(section, {
    timeoutSeconds: timeoutSecondsOf(flat),
    rateLimitRps: rateLimitRpsOf(flat),
    retry: retryOf(flat),
  });
  return assignDefined({ ...section }, flat.imap);
}

/**
 * 选中的 provider 是否已填齐必填字段。
 *
 * @param {object} config mail 配置段
 * @returns {boolean}
 */
export function mailConfigured(config) {
  return mailMissingFields(config).length === 0;
}

/**
 * 返回缺失字段名清单（供设置页高亮）。
 *
 * @param {object} config mail 配置段
 * @returns {string[]}
 */
export function mailMissingFields(config) {
  const provider = String((config && config.provider) || 'imap').trim().toLowerCase();
  if (provider === 'graph') {
    const section = graphSection(config);
    return GRAPH_REQUIRED_FIELDS.filter((field) => isBlank(section[field]));
  }
  if (provider === 'imap') {
    const section = imapSection(config);
    return IMAP_REQUIRED_FIELDS.filter((field) => isBlank(section[field]));
  }
  return ['provider'];
}

function describeMissing(missing) {
  return `缺少配置：${missing.join('、')}`;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function resolveLogger(logger) {
  return logger || {};
}

function logWarn(logger, ...args) {
  if (typeof logger.warn === 'function') logger.warn(...args);
}

function logInfo(logger, ...args) {
  if (typeof logger.info === 'function') logger.info(...args);
}

function logDebug(logger, ...args) {
  if (typeof logger.debug === 'function') logger.debug(...args);
}

function logError(logger, ...args) {
  if (typeof logger.error === 'function') logger.error(...args);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeNow(options) {
  return typeof options.now === 'function' ? Number(options.now()) : Date.now();
}

function resolveSleep(options) {
  if (typeof options.sleep === 'function') return options.sleep;
  return (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

/**
 * 异步令牌桶：与 Python core/rate_limiter.py 同语义（按时间差补令牌，无后台定时器）。
 * 每个 fetchMail 调用各持一个实例，因此 Graph 与 IMAP 的限流互不干扰。
 */
function createTokenBucket(ratePerSec, burst = 1, now = () => Date.now(), sleep = null) {
  const rate = Number(ratePerSec);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`rateLimitRps 必须大于 0，当前为 ${ratePerSec}`);
  }
  let tokens = burst;
  let updatedAt = now();
  let queue = Promise.resolve();

  const refill = () => {
    const current = now();
    const elapsed = (current - updatedAt) / 1000;
    if (elapsed <= 0) return;
    tokens = Math.min(burst, tokens + elapsed * rate);
    updatedAt = current;
  };

  const waitSeconds = () => Math.max((1 - tokens) / rate, 0.01);

  const acquire = () => {
    const run = queue.then(async () => {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const wait = waitSeconds() * 1000;
        if (typeof sleep === 'function') await sleep(wait);
        else await new Promise((resolve) => setTimeout(resolve, wait));
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  return { acquire };
}

// ---------------------------------------------------------------------------
// 文本 / MIME 解码工具（对位 Python email 模块的行为）
// ---------------------------------------------------------------------------

// Python 常见别名里 TextDecoder 不认识的那几个，手工补齐，避免"未知字符集"退化。
const CHARSET_ALIASES = new Map([
  ['ascii', 'ascii'],
  ['us-ascii', 'ascii'],
  ['ansi_x3.4-1968', 'ascii'],
  ['646', 'ascii'],
  ['latin-1', 'iso-8859-1'],
  ['latin1', 'iso-8859-1'],
  ['latin_1', 'iso-8859-1'],
  ['iso8859-1', 'iso-8859-1'],
  ['iso-8859-8-i', 'iso-8859-8'],
  ['cp1252', 'windows-1252'],
  ['cp1251', 'windows-1251'],
  ['gb2312', 'gbk'],
  ['gb-2312', 'gbk'],
  ['ks_c_5601-1987', 'euc-kr'],
  ['utf8', 'utf-8'],
  ['utf-8', 'utf-8'],
  ['utf-16', 'utf-16le'],
  ['ksc5601', 'euc-kr'],
  ['big-5', 'big5'],
]);

const ASCII_DECODER = new TextDecoder('latin1');

function bytesToLatin1String(bytes) {
  // latin1 是字节到码位的一一映射，用来还原 Python surrogateescape 的效果
  return ASCII_DECODER.decode(bytes);
}

function normalizeCharsetLabel(charset) {
  if (charset === undefined || charset === null) return '';
  const raw = String(charset).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!raw) return '';
  // Python 会去掉 RFC 2231 语言后缀：utf-8*en → utf-8
  const base = raw.split('*')[0];
  return CHARSET_ALIASES.get(base) || base;
}

/**
 * 解析字符集标签为 TextDecoder；未知标签抛错（调用方决定是退化还是报错）。
 *
 * @param {string} charset
 * @returns {TextDecoder}
 */
export function decoderForCharset(charset) {
  const label = normalizeCharsetLabel(charset);
  if (!label) throw new Error('缺少字符集声明');
  return new TextDecoder(label, { fatal: false });
}

function decodeBytesWith(charset, bytes) {
  const decoder = decoderForCharset(charset);
  if (decoder.encoding === 'latin1') return bytesToLatin1String(bytes);
  return decoder.decode(bytes);
}

/**
 * 对位 Python `_decode_bytes`：字符集未知时退化为 utf-8（errors=replace）。
 *
 * @param {Uint8Array} bytes
 * @param {string} charset
 * @returns {string}
 */
export function decodeBytes(bytes, charset) {
  try {
    return decodeBytesWith(charset, bytes);
  } catch (error) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** 对位 Python `_decode_header_value` 的第一段：把编码字还原成字节或字面文本。 */
function decodeEncodedWord(encoding, encoded, charset) {
  const payload = String(encoded ?? '');
  try {
    if (encoding === 'B') {
      const stripped = payload.replace(/\s+/g, '');
      const padded = stripped + '='.repeat((4 - (stripped.length % 4)) % 4);
      const bytes = Uint8Array.from(Buffer.from(padded, 'base64'));
      return { bytes };
    }
    if (encoding === 'Q') {
      const bytes = [];
      for (let i = 0; i < payload.length; i += 1) {
        const ch = payload[i];
        if (ch === '_') {
          bytes.push(0x20);
        } else if (ch === '=' && i + 2 < payload.length) {
          const hex = payload.slice(i + 1, i + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            bytes.push(Number.parseInt(hex, 16));
            i += 2;
          } else {
            bytes.push(ch.charCodeAt(0));
          }
        } else {
          bytes.push(ch.charCodeAt(0) & 0xff);
        }
      }
      return { bytes: Uint8Array.from(bytes) };
    }
    if (charset) {
      // 未知编码（如 =?utf-8?X?...?=）：Python 原样返回编码串作为字面文本
      return { text: `=?${charset}?${encoding}?${payload}?=` };
    }
    return { text: payload };
  } catch (error) {
    return { text: payload };
  }
}

const ENCODED_WORD_PATTERN = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/**
 * 解码 MIME 头（=?utf-8?B?...?= / =?gbk?Q?...?=，含多段与多行）。
 *
 * 与 Python email.header.decode_header 的差异已在报告里注明：
 * 这里把整段原文按"\S+ 与编码字边界"切分后再惰性拼接，
 * 因此"编码字 + 普通文本 + 编码字"这类混合主体的切分点会略有不同。
 *
 * @param {string|null|undefined} raw
 * @returns {{fragments: Array<{bytes?: Uint8Array, text?: string, charset?: string}>, text: string}}
 */
export function decodeHeaderValue(raw) {
  const source = raw === undefined || raw === null ? '' : String(raw);
  if (!source) return { fragments: [], text: '' };

  const fragments = [];
  let cursor = 0;
  ENCODED_WORD_PATTERN.lastIndex = 0;
  let match = ENCODED_WORD_PATTERN.exec(source);
  while (match !== null) {
    if (match.index > cursor) {
      fragments.push({ text: source.slice(cursor, match.index), ascii: true });
    }
    const charset = match[1];
    const encoding = match[2].toUpperCase();
    const decoded = decodeEncodedWord(encoding, match[3], charset);
    fragments.push(decoded.bytes ? { ...decoded, charset } : { ...decoded, ascii: true });
    cursor = match.index + match[0].length;
    match = ENCODED_WORD_PATTERN.exec(source);
  }
  if (cursor < source.length) {
    fragments.push({ text: source.slice(cursor), ascii: true });
  }

  const text = fragments
    .map((fragment) => {
      if (fragment.bytes) return decodeBytes(fragment.bytes, fragment.charset);
      if (fragment.ascii) return fragment.text;
      return fragment.text ?? '';
    })
    .join('')
    .trim();
  return { fragments, text };
}

/**
 * 按 MIME 规则拆解一条原始邮件（headers + body）。
 *
 * 只实现移植所需的子集：Content-Type / Content-Transfer-Encoding /
 * Content-Disposition / charset 参数，以及 RFC 2045 与 RFC 2231 两种参数写法。
 *
 * @param {Uint8Array|Buffer|string} rawBytes
 * @returns {{headers: Map<string,string>, contentLines: string[], raw: Buffer, rawString: string}}
 */
export function parseMimeMessage(rawBytes) {
  const raw = typeof rawBytes === 'string' ? Buffer.from(rawBytes, 'latin1') : Buffer.from(rawBytes);
  const text = bytesToLatin1String(raw);
  const lines = text.split(/\r\n|\n|\r/);

  // 头部：以第一个空行为界；折叠续行按 RFC 5322 用单个空格拼接
  const headers = new Map();
  let index = 0;
  let pendingName = null;
  let pendingValue = '';
  const flushPending = () => {
    if (pendingName !== null) {
      // 同名头重复出现时保留第一份（对位 Python Message.get）
      if (!headers.has(pendingName)) headers.set(pendingName, pendingValue);
      pendingName = null;
      pendingValue = '';
    }
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') {
      index += 1;
      break;
    }
    if (pendingName !== null && /^[ \t]/.test(line)) {
      pendingValue += ` ${line.trim()}`;
      continue;
    }
    flushPending();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    pendingName = line.slice(0, colon).trim().toLowerCase();
    pendingValue = line.slice(colon + 1).trim();
  }
  flushPending();
  const headerValue = (name) => {
    const key = String(name).toLowerCase();
    return headers.has(key) ? headers.get(key) : null;
  };

  return {
    headers,
    headerValue,
    contentLines: lines.slice(index),
    raw,
    rawString: text,
  };
}

function splitHeaderParams(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  const source = String(value ?? '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (ch === '\\' && quoted && i + 1 < source.length) {
      current += ch + source[i + 1];
      i += 1;
      continue;
    }
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function unquoteParam(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return text;
}

/**
 * 解析 Content-Type / Content-Disposition 的值，支持 RFC 2231（charset''xx）。
 *
 * @param {string|null} value
 * @returns {{value: string, type: string, params: Record<string,string>}}
 */
export function parseHeaderParams(value) {
  const parts = splitHeaderParams(value);
  const main = (parts.shift() ?? '').trim();
  const params = {};
  const pending = new Map();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const rawValue = part.slice(eq + 1).trim();
    const star = key.endsWith('*');
    const baseKey = star ? key.slice(0, -1) : key;
    const decoded = unquoteParam(rawValue);
    if (star) {
      const pieces = decoded.split("'");
      if (pieces.length >= 3) {
        const charset = pieces[0];
        const encoded = pieces.slice(2).join("'");
        const bytes = [];
        for (let i = 0; i < encoded.length; i += 1) {
          if (encoded[i] === '%' && i + 2 < encoded.length) {
            const hex = encoded.slice(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
              bytes.push(Number.parseInt(hex, 16));
              i += 2;
              continue;
            }
          }
          bytes.push(encoded.charCodeAt(i) & 0xff);
        }
        params[baseKey] = decodeBytes(Uint8Array.from(bytes), charset);
      } else {
        params[baseKey] = decoded;
      }
      continue;
    }
    const continuation = /^(.+)\*(\d+)$/.exec(key);
    if (continuation) {
      const list = pending.get(continuation[1]) || [];
      list[Number.parseInt(continuation[2], 10)] = decoded;
      pending.set(continuation[1], list);
      continue;
    }
    params[key] = decoded;
  }
  for (const [key, list] of pending) {
    if (params[key] === undefined) params[key] = list.filter(Boolean).join('');
  }
  const type = main.toLowerCase().split(';')[0].trim();
  return { value: main, type, params };
}

function contentTypeOf(message) {
  const parsed = parseHeaderParams(message.headerValue('content-type'));
  if (!parsed.type) return 'text/plain';
  return parsed.type;
}

/** 对位 Python Message.get_content_charset()：显式 charset → 否则按类型给默认值。 */
function contentCharsetOf(message) {
  const parsed = parseHeaderParams(message.headerValue('content-type'));
  const explicit = parsed.params.charset;
  if (explicit) {
    const text = String(explicit).trim();
    if (text) return text.toLowerCase();
  }
  const type = parsed.type;
  if (type === 'text/plain' || type === 'text/html') return 'us-ascii';
  if (type.startsWith('text/')) return 'us-ascii';
  return null;
}

const HTML_ENTITY_PATTERN = /&[a-zA-Z#0-9]+;/g;

function decodeQuotedPrintable(input) {
  const bytes = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '=') {
      const next = input[i + 1];
      const after = input[i + 2];
      if (next === '\r' && after === '\n') {
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

function decodeTransferBody(message) {
  const encoding = String(message.headerValue('content-transfer-encoding') ?? '').trim().toLowerCase();
  const body = message.contentLines.join('\r\n');
  if (encoding === 'base64') {
    const stripped = body.replace(/[^A-Za-z0-9+/=]/g, '');
    return Uint8Array.from(Buffer.from(stripped, 'base64'));
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return Buffer.from(body, 'latin1');
}

function decodePartPayload(message) {
  const bytes = decodeTransferBody(message);
  return decodeBytesWith(contentCharsetOf(message), bytes);
}

/** 对位 Python `_extract_body` 的 multipart 优先规则。 */
function extractBody(message) {
  const parsed = parseHeaderParams(message.headerValue('content-type'));
  if (parsed.type.startsWith('multipart/') && parsed.params.boundary) {
    const boundary = parsed.params.boundary;
    const lines = message.contentLines;
    let plain = '';
    let html = '';
    const visit = (segment) => {
      const sub = parseMimeMessage(segment.join('\r\n'));
      const subParsed = parseHeaderParams(sub.headerValue('content-type'));
      const disposition = String(sub.headerValue('content-disposition') ?? '').toLowerCase();
      if (disposition.includes('attachment')) return;
      if (subParsed.type.startsWith('multipart/') && subParsed.params.boundary) {
        visitMatching(sub.contentLines, subParsed.params.boundary, visit);
        return;
      }
      if (subParsed.type === 'text/plain' && !plain) plain = decodePartPayload(sub);
      else if (subParsed.type === 'text/html' && !html) html = decodePartPayload(sub);
    };
    visitMatching(lines, boundary, visit);
    if (plain) return plain;
    return html ? stripHtml(html) : '';
  }
  const payload = decodePartPayload(message);
  return contentTypeOf(message) === 'text/html' ? stripHtml(payload) : payload;
}

function visitMatching(lines, boundary, visit) {
  const marker = `--${boundary}`;
  let current = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === marker || trimmed === `${marker}--`) {
      if (current.length > 0) visit(current);
      current = [];
      if (trimmed === `${marker}--`) return;
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) visit(current);
}

/** 对位 Python `_strip_html`：去标签 + 压缩空白；另外把 HTML 实体折叠成一个空格。 */
export function stripHtml(text) {
  const source = String(text ?? '');
  const replaced = source.replace(HTML_ENTITY_PATTERN, ' ');
  return replaced
    .replace(TAG_PATTERN, ' ')
    .split(/\s+/)
    .filter((chunk) => chunk.length > 0)
    .join(' ');
}

/** 对位 Python `_clean_message_id`。 */
function cleanMessageId(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

/**
 * 对位 Python `_normalize_date`：可解析 → ISO 8601；不可解析 → 原文截断 200；
 * 缺失/空串 → null。朴素日期（无时区）按 UTC 处理。
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function normalizeDate(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const parsed = parseRfc2822Date(text);
  if (!parsed) return text.slice(0, MAX_DATE_CHARS);
  return parsed;
}

function parseRfc2822Date(text) {
  const match = /^(?:\w{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|[+-]\d{2}:\d{2}|UT|UTC|GMT|Z|[A-Za-z]{3,}))?/i.exec(
    text,
  );
  if (!match) return null;
  const day = Number.parseInt(match[1], 10);
  const monthName = match[2].toLowerCase();
  let year = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = match[6] === undefined ? 0 : Number.parseInt(match[6], 10);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthIndex = months.indexOf(monthName.slice(0, 3));
  if (monthIndex < 0) return null;
  if (year < 100) year += year < 50 ? 2000 : 1900;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const utcMs = Date.UTC(year, monthIndex, day, hour, minute, second > 59 ? 59 : second);
  if (!Number.isFinite(utcMs)) return null;
  const canonical = new Date(utcMs);
  if (canonical.getUTCDate() !== day || canonical.getUTCMonth() !== monthIndex) return null;
  /* 墙上时间照抄原文，时区用原文偏移：这样 "08:30 +0800" 既不会被误标成 UTC，
     也不会被换算成另一个瞬间（换算成 UTC 再贴 +08:00 会凭空挪 8 小时）。 */
  return `${formatIsoDate(year, monthIndex, day, hour, minute, second > 59 ? 59 : second)}${normalizeOffset(match[7])}`;
}

function formatIsoDate(year, monthIndex, day, hour, minute, second) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${pad(year, 4)}-${pad(monthIndex + 1)}-${pad(day)}`
    + `T${pad(hour)}:${pad(minute)}:${pad(second)}`
  );
}

/** 把 RFC 2822 的时区写法归一为 `±HH:MM`；无法识别（含 UT/GMT/Z 与缺失）一律 `+00:00`。 */
function normalizeOffset(raw) {
  if (!raw) return '+00:00';
  const text = String(raw).trim().toUpperCase();
  if (text === 'Z' || text === 'UT' || text === 'UTC' || text === 'GMT') return '+00:00';
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (!match) return '+00:00';
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3], 10);
  if (hours > 23 || minutes > 59) return '+00:00';
  return `${match[1]}${match[2]}:${match[3]}`;
}

// ---------------------------------------------------------------------------
// IMAP 协议层
// ---------------------------------------------------------------------------

/** 把 buf 中从 start 开始的下一行切出来；同时容忍 CRLF 与裸 LF（以及裸 CR）。 */
function readCrlfLine(buf, start) {
  for (let i = start; i < buf.length; i += 1) {
    if (buf[i] === 10) {
      return { ended: true, content: buf.subarray(start, i), next: i + 1 };
    }
    if (buf[i] === 13) {
      if (i + 1 < buf.length) {
        if (buf[i + 1] === 10) {
          return { ended: true, content: buf.subarray(start, i), next: i + 2 };
        }
        return { ended: true, content: buf.subarray(start, i), next: i + 1 };
      }
      // 行尾 CR 落在缓冲区末尾：等更多字节再判定
      return { ended: false, content: null, next: i };
    }
  }
  return { ended: false, content: null, next: buf.length };
}

/** 找行尾的 {n} 字面量标记（也接受 {n+}）。 */
function matchLiteralMarker(lineBuffer) {
  const text = bytesToLatin1String(lineBuffer);
  const match = /\{(\d+)\+?\}$/.exec(text);
  if (!match) return null;
  return { count: Number.parseInt(match[1], 10), text };
}

function isTaggedCompletion(lineText, tag) {
  if (!tag) return false;
  const match = /^(\S+)\s+(OK|NO|BAD)\b/i.exec(lineText.trim());
  if (!match) return false;
  return match[1].toLowerCase() === tag.toLowerCase();
}

function mergeLiterals(literals) {
  if (literals.length === 1) return literals[0];
  return Buffer.concat(literals);
}

/**
 * 解析一段完整的 IMAP 响应字节流。
 *
 * 关键点：响应行以 `{<n>}\r\n` 结尾时，紧随其后的 n 个字节是字面量 ——
 * 这 n 个字节里可能本来就含 `\r\n` 与 `{`，绝不能当作行分隔符或新标记。
 * 纯函数，便于离线 fixture 直接喂录音逐字节验证。
 *
 * @param {Uint8Array|Buffer|string} bytes
 * @param {{tag?: string}} [options]
 * @returns {{lines: Array<object>, tagged: object|null, literals: Buffer[]}}
 */
export function parseImapResponse(bytes, options = {}) {
  const buf = typeof bytes === 'string'
    ? Buffer.from(bytes, 'latin1')
    : Buffer.from(bytes.buffer ? bytes : Uint8Array.from(bytes));
  const wantedTag = options.tag ? String(options.tag) : '';
  const lines = [];
  const literals = [];
  let pos = 0;
  let pending = null; // 正在积累字面量的那一行
  let tagged = null;

  while (pos < buf.length) {
    const scanned = readCrlfLine(buf, pos);
    if (!scanned.ended) break; // 残行：交给调用方继续缓冲
    const lineBuf = scanned.content;
    const lineText = bytesToLatin1String(lineBuf);
    const marker = matchLiteralMarker(lineBuf);
    if (marker) {
      if (marker.count > buf.length - scanned.next) break; // 字面量还没到齐
      const data = buf.subarray(scanned.next, scanned.next + marker.count);
      literals.push(Buffer.from(data));
      if (pending) {
        pending.literalCount += 1;
      } else {
        pending = { text: lineText, literalCount: 1 };
      }
      pos = scanned.next + marker.count;
      // 字面量之后协议上紧跟 CRLF；容忍缺失
      if (pos < buf.length && buf[pos] === 13 && pos + 1 < buf.length && buf[pos + 1] === 10) pos += 2;
      else if (pos < buf.length && buf[pos] === 10) pos += 1;
      continue;
    }
    pos = scanned.next;
    if (lineText.trim() === '') continue;
    if (pending) {
      lines.push({ raw: pending.text, literalCount: pending.literalCount });
      pending = null;
    }
    if (lineText.startsWith('*')) {
      lines.push({ raw: lineText, literalCount: 0 });
      continue;
    }
    const completion = /^(\S+)\s+(OK|NO|BAD)(?:\s+\[[^\]]*\])?(?:\s+(.*))?$/i.exec(lineText.trim());
    if (completion) {
      const entry = {
        tag: completion[1],
        status: completion[2].toUpperCase(),
        text: completion[3] === undefined ? '' : completion[3],
        raw: lineText,
      };
      if (!wantedTag || entry.tag.toLowerCase() === wantedTag.toLowerCase()) {
        tagged = entry;
        lines.push(entry);
        break;
      }
      lines.push(entry);
      continue;
    }
    // 既不是未标记行也不是带标记完成行：按未知行保留，避免丢信息
    lines.push({ raw: lineText, literalCount: 0 });
  }

  return { lines, tagged, literals };
}

/**
 * 把若干响应字节拼成一次"完整回复"所需的缓冲：字面量未到齐时返回 null。
 *
 * 问候语是**未标记**行（`* OK ...` / `* PREAUTH ...`），没有 `aN OK` 完成行，
 * 所以 tag 为空串时按"收到一条未标记行"就算完整。
 */
function responseComplete(buf, tag) {
  const parsed = parseImapResponse(buf, { tag });
  if (parsed.tagged) return parsed;
  if (!tag && parsed.lines.length > 0) return parsed;
  return null;
}

class ImapClient {
  constructor(config, options) {
    const section = imapSection(config);
    this.host = String(section.host ?? '');
    this.port = parsePositiveInt(section.port, 993);
    this.username = String(section.username ?? '');
    this.password = String(section.password ?? '');
    this.folder = String(section.folder ?? 'INBOX') || 'INBOX';
    this.lookbackDays = parsePositiveInt(section.lookbackDays, DEFAULT_LOOKBACK_DAYS);
    this.timeoutSeconds = Number(section.timeoutSeconds) > 0
      ? Number(section.timeoutSeconds)
      : DEFAULT_TIMEOUT_SECONDS;
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.counter = 0;
    this.done = false;
    this.closed = false;
    this.failure = null;
    this.sawOk = false;
    this.connected = false;
  }

  escapeString(value) {
    // IMAP 引号字符串：反斜杠与双引号都要转义
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  async connect() {
    const options = this.options;
    const connectImpl = typeof options.connect === 'function' ? options.connect : tls.connect;
    const socket = connectImpl({
      host: this.host,
      port: this.port,
      servername: this.host,
      rejectUnauthorized: true,
    });
    this.socket = socket;
    socket.setEncoding('latin1');
    if (typeof socket.setTimeout === 'function' && !options.connect) {
      socket.setTimeout(this.timeoutSeconds * 1000);
    }
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk), 'latin1');
      this.buffer = Buffer.concat([this.buffer, bytes]);
      this.pump('data');
    };
    const onError = (error) => {
      if (this.done || this.closed) return;
      this.closed = true;
      this.pump('error', error);
    };
    const onClose = () => {
      this.closed = true;
      if (this.done) {
        this.pump('close', null);
        return;
      }
      const reason = this.failure || new Error('IMAP 连接被对方关闭');
      this.failure = reason;
      this.pump('error', reason);
    };
    const onTimeout = () => {
      const reason = new Error(`IMAP 连接超时（${this.timeoutSeconds}s）`);
      try {
        socket.destroy(reason);
      } catch (error) {
        /* 忽略 destroy 异常 */
      }
      if (this.done || this.closed) return;
      this.closed = true;
      this.failure = reason;
      this.pump('error', reason);
    };

    this.handlers = { onData, onError, onClose, onTimeout };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    if (typeof socket.once === 'function') {
      socket.once('secureConnect', () => {
        this.connected = true;
        this.pump('secureConnect');
      });
      socket.once('connect', () => {
        this.connected = true;
        this.pump('secureConnect');
      });
    }

    // 读问候语：未标记的问候没有完成行，收到任意未标记行即算到齐
    const greeting = await this.receiveResponse('');
    if (greeting.error) throw greeting.error;
    const line = greeting.response.lines.find((entry) => entry.raw && entry.raw.startsWith('*'));
    const text = line ? line.raw : '';
    this.sawOk = /\b(OK|PREAUTH)\b/i.test(text);
    if (!this.sawOk) {
      throw new Error(`IMAP 问候语异常：${text || '(空)'}`);
    }
    return this.sawOk;
  }

  pump(kind, payload) {
    if (!this.waiter) return;
    const flush = this.waiter;
    this.waiter = null;
    if (kind === 'secureConnect') flush.resolve('connected');
    else flush.resolve(kind);
  }

  waitFor(events, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        resolve: (kind) => {
          if (timer) clearTimeout(timer);
          this.waiter = null;
          if (kind === 'error' && events.includes('error')) reject(this.failure || new Error('IMAP 连接错误'));
          else resolve(kind);
        },
      };
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.waiter === entry) this.waiter = null;
          reject(new Error(`IMAP 操作超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }
      this.waiter = entry;
    });
  }

  async receiveResponse(tag) {
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    for (;;) {
      if (this.buffer.length > 0) {
        const parsed = responseComplete(this.buffer, tag);
        if (parsed) {
          this.buffer = Buffer.alloc(0);
          return { response: parsed };
        }
      }
      if (this.closed) {
        if (this.failure) return { error: this.failure };
        if (this.buffer.length === 0) return { error: new Error('IMAP 连接已关闭') };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { error: new Error(`IMAP 读取超时（${this.timeoutSeconds}s）`) };
      try {
        await this.waitFor(['data', 'close', 'error'], remaining);
      } catch (error) {
        return { error };
      }
    }
  }

  async executeCommand(command) {
    this.counter += 1;
    const tag = `a${this.counter}`;
    logDebug(this.options.logger, `IMAP → ${tag} ${command}`);
    // tls.connect 会把握手完成前的写入排队，因此直接写即可（无需等 secureConnect）
    this.socket.write(`${tag} ${command}\r\n`);
    const outcome = await this.receiveResponse(tag);
    if (outcome.error) throw outcome.error;
    const { response } = outcome;
    if (!response.tagged) throw new Error(`IMAP 命令 ${tag} 未收到完成状态`);
    const status = response.tagged.status.toUpperCase();
    if (status === 'NO' || status === 'BAD') {
      const detail = response.tagged.text || response.tagged.raw || status;
      const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);
      throw new Error(`IMAP ${tag} ${command} 失败：${status} ${detailText}`);
    }
    // 一条回复里可能顺带带回服务端的 BYE 等额外数据；已取到完成行即可丢弃
    this.buffer = Buffer.alloc(0);
    return { tag, response };
  }

  async login() {
    await this.executeCommand(`LOGIN ${this.escapeString(this.username)} ${this.escapeString(this.password)}`);
  }

  async selectFolder() {
    const { response } = await this.executeCommand(`SELECT ${this.escapeString(this.folder)}`);
    return { exists: parseExistsCount(response.lines) };
  }

  async searchSince(sinceDate) {
    const { response } = await this.executeCommand(`SEARCH SINCE ${this.escapeString(sinceDate)}`);
    return { sequences: parseSearchSequences(response.lines) };
  }

  async fetchRaw(sequences) {
    if (sequences.length === 0) return [];
    const command = `FETCH ${sequences.join(',')} (${IMAP_FETCH_ITEM})`;
    const { response } = await this.executeCommand(command);
    const bySequence = new Map();
    response.lines.forEach((line, index) => {
      if (!line.raw || !line.raw.startsWith('*')) return;
      if (!line.literalCount) return;
      // 字面量在 parseImapResponse 里按出现顺序收集，这里按行内计数重新配位
      const start = response.lines
        .slice(0, index)
        .reduce((sum, item) => sum + (item.literalCount || 0), 0);
      const slice = response.literals.slice(start, start + line.literalCount);
      if (slice.length === 0) return;
      const match = /^\*\s+(\d+)\s+FETCH\b/i.exec(line.raw);
      if (!match) return;
      bySequence.set(match[1], mergeLiterals(slice));
    });
    // 按请求顺序返回，并且只返回真正拿到正文的那些序号
    return sequences
      .filter((sequence) => bySequence.has(String(sequence)))
      .map((sequence) => ({ sequence: String(sequence), raw: bySequence.get(String(sequence)) }));
  }

  async logout() {
    if (this.done) return;
    try {
      await this.executeCommand('LOGOUT');
    } finally {
      this.done = true;
      this.cleanup();
    }
  }

  close() {
    this.done = true;
    this.cleanup();
  }

  cleanup() {
    const socket = this.socket;
    if (!socket) return;
    const handlers = this.handlers;
    if (handlers && typeof socket.removeListener === 'function') {
      socket.removeListener('data', handlers.onData);
      socket.removeListener('error', handlers.onError);
      socket.removeListener('close', handlers.onClose);
      socket.removeListener('timeout', handlers.onTimeout);
    }
    if (typeof socket.end === 'function') {
      try {
        socket.end();
      } catch (error) {
        /* 收尾失败无所谓 */
      }
    }
    if (typeof socket.destroy === 'function') {
      try {
        socket.destroy();
      } catch (error) {
        /* 收尾失败无所谓 */
      }
    }
  }
}

/** 从 SELECT 回复里取 EXISTS 数量。 */
export function parseExistsCount(lines) {
  for (const line of lines) {
    const match = /^\*\s+(\d+)\s+EXISTS\b/i.exec(String(line.raw || ''));
    if (match) return Number.parseInt(match[1], 10);
  }
  return 0;
}

/** 从 SEARCH 回复里取序号集合（容忍空结果）。 */
export function parseSearchSequences(lines) {
  const sequences = [];
  for (const line of lines) {
    const raw = String(line.raw || '').trim();
    if (!/^\*\s+SEARCH\b/i.test(raw)) continue;
    const rest = raw.replace(/^\*\s+SEARCH\b/i, '').trim();
    if (!rest) continue;
    for (const token of rest.split(/\s+/)) {
      if (/^\d+$/.test(token)) sequences.push(token);
    }
  }
  return sequences;
}

/** IMAP SINCE 用的日期格式：02-Jan-2026（英文月份缩写）。 */
function formatImapDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = IMAP_DATE_FORMAT_MONTHS[date.getUTCMonth()];
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

function buildImapItem(raw, sequence) {
  const message = parseMimeMessage(raw);
  const messageId = cleanMessageId(message.headerValue('message-id'));
  const externalId = messageId ? `imap:${messageId}` : `imap:seq:${sequence}`;
  return {
    source: SOURCE_MAIL,
    external_id: externalId,
    course_id: null,
    payload: {
      subject: decodeHeaderValue(message.headerValue('subject')).text,
      from: decodeHeaderValue(message.headerValue('from')).text,
      receivedDateTime: normalizeDate(message.headerValue('date')),
      bodyPreview: extractBody(message).slice(0, BODY_PREVIEW_CHARS),
    },
  };
}

// ---------------------------------------------------------------------------
// IMAP 拉取入口
// ---------------------------------------------------------------------------

async function fetchImap(config, options) {
  const warnings = [];
  const logger = resolveLogger(options.logger);
  const section = imapSection(config);
  const lookbackDays = parsePositiveInt(section.lookbackDays, DEFAULT_LOOKBACK_DAYS);
  const rateLimitRps = Number(section.rateLimitRps) > 0
    ? Number(section.rateLimitRps)
    : DEFAULT_RATE_LIMIT_RPS;
  const sleep = resolveSleep(options);
  const bucket = createTokenBucket(rateLimitRps, 1, () => safeNow(options), sleep);

  const sinceDate = formatImapDate(new Date(safeNow(options) - lookbackDays * 86_400_000));
  const client = new ImapClient(config, options);

  // 礼貌间隔：连接前一次
  await bucket.acquire();
  try {
    await client.connect();
    await client.login();
    await client.selectFolder();
    const { sequences } = await client.searchSince(sinceDate);
    logDebug(logger, `IMAP SEARCH SINCE ${sinceDate} → ${sequences.length} 封`);

    const items = [];
    for (let offset = 0; offset < sequences.length; offset += FETCH_CHUNK_SIZE) {
      const chunk = sequences.slice(offset, offset + FETCH_CHUNK_SIZE);
      await bucket.acquire(); // 每个 FETCH 批次前再限流一次
      let fetched;
      try {
        fetched = await client.fetchRaw(chunk);
      } catch (error) {
        // 整批 FETCH 失败：退化为逐封尝试，单封失败只记警告
        logWarn(logger, `IMAP 批量 FETCH 失败，改为逐封重试：${errorMessage(error)}`);
        for (const sequence of chunk) {
          try {
            const single = await client.fetchRaw([sequence]);
            if (single.length === 0) {
              warnings.push(`邮件 ${sequence} 无正文内容，已跳过`);
              continue;
            }
            for (const entry of single) {
              pushImapItem(items, entry.raw, entry.sequence, warnings, logger);
            }
          } catch (innerError) {
            warnings.push(`邮件 ${sequence} 拉取失败：${errorMessage(innerError)}`);
            logError(logger, `解析邮件失败（序号 ${sequence}）：${errorMessage(innerError)}`);
          }
        }
        continue;
      }
      const fetchedSequences = new Set(fetched.map((entry) => entry.sequence));
      for (const sequence of chunk) {
        if (!fetchedSequences.has(sequence)) warnings.push(`邮件 ${sequence} 无正文内容，已跳过`);
      }
      for (const entry of fetched) {
        pushImapItem(items, entry.raw, entry.sequence, warnings, logger);
      }
    }

    logInfo(logger, `IMAP 拉取完成：${items.length} 封（近 ${lookbackDays} 天）`);
    return { items, warnings };
  } finally {
    try {
      await client.logout();
    } catch (error) {
      logDebug(logger, 'IMAP logout 异常，已忽略');
    }
  }
}

function pushImapItem(items, raw, sequence, warnings, logger) {
  try {
    items.push(buildImapItem(raw, sequence));
  } catch (error) {
    // 刻意宽 catch：单封邮件不能拖垮整批
    warnings.push(`解析邮件失败（序号 ${sequence}）：${errorMessage(error)}`);
    logError(logger, `解析邮件失败（序号 ${sequence}）：${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Graph 拉取入口
// ---------------------------------------------------------------------------

function readHeader(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(name);
  return value === undefined ? null : value;
}

function retryAfterSeconds(headers) {
  // 注意 Retry-After: 0 是合法值，不能用 || 短路
  const raw = readHeader(headers, 'retry-after');
  if (raw === null || raw === '') return null;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(parsed, 0);
}

function requestWithRetry(fetchImpl, url, init, context) {
  const { logger, sleep, bucket, now } = context;
  const maxAttempts = context.maxAttempts;
  const backoffBase = context.backoffBase;

  const attempt = async (number) => {
    await bucket.acquire();
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (number >= maxAttempts) {
        throw new Error(`Graph 请求异常（第 ${number}/${maxAttempts} 次）：${errorMessage(error)}`);
      }
      const waitMs = backoffBase ** number * 1000;
      logWarn(logger, `Graph 请求异常（第 ${number}/${maxAttempts} 次）：${errorMessage(error)}`);
      await sleep(waitMs);
      return attempt(number + 1);
    }
    const status = response.status;
    if (status === 429 || status >= 500) {
      const header = retryAfterSeconds(response.headers);
      const waitSeconds = header !== null ? header : backoffBase ** number;
      if (number >= maxAttempts) {
        throw new Error(
          `Graph 请求失败（HTTP ${status}），已重试 ${maxAttempts} 次：${url}`,
        );
      }
      logWarn(logger, `Graph 返回 ${status}（第 ${number}/${maxAttempts} 次），${waitSeconds}s 后重试`);
      await sleep(waitSeconds * 1000);
      return attempt(number + 1);
    }
    if (status < 200 || status >= 300) {
      // 401/403 在 Graph 上几乎总是「应用级 Mail.Read 没授给你」——学生租户自助不了，
      // 所以把「改用 IMAP」这条出路直接贴在错误里，用户不用去翻文档。
      const hint = status === 401 || status === 403 ? ` ${IMAP_HINT}` : '';
      throw new Error(`Graph 请求失败（HTTP ${status}）：${url}${hint}`);
    }
    return response;
  };

  return attempt(1);
}

/**
 * 组装一次 Graph 调用所需的共享状态（令牌桶、重试参数、限流后的取令牌）。
 *
 * 每次 fetchMail 调用各建一份，因此令牌缓存的生命周期与 Python 版"连接器实例"
 * 等价：一次拉取内只取一次令牌；下一次调用会重新取。
 */
function createGraphRuntime(config, options) {
  const logger = resolveLogger(options.logger);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境没有可用的 fetch（可注入 options.fetchImpl）');
  }
  const section = graphSection(config);
  const sleep = resolveSleep(options);
  const rateLimitRps = Number(section.rateLimitRps) > 0
    ? Number(section.rateLimitRps)
    : DEFAULT_RATE_LIMIT_RPS;
  const bucket = createTokenBucket(rateLimitRps, 1, () => safeNow(options), sleep);
  const retry = section.retry || {};
  const context = {
    logger,
    sleep,
    bucket,
    now: () => safeNow(options),
    maxAttempts: Math.max(parsePositiveInt(retry.maxAttempts, DEFAULT_MAX_ATTEMPTS), 1),
    backoffBase: Number.isFinite(Number(retry.backoffBase))
      ? Number(retry.backoffBase)
      : DEFAULT_BACKOFF_BASE,
  };

  const token = { value: '', expiresAt: 0 };

  /** 取应用令牌；未过期则直接复用（提前 60 秒视为过期）。 */
  const accessToken = async () => {
    if (token.value && safeNow(options) < token.expiresAt) return token.value;
    const tokenUrl = TOKEN_URL_TEMPLATE.replace(
      '{tenantId}',
      encodeURIComponent(String(section.tenantId ?? '')),
    );
    const response = await requestWithRetry(
      fetchImpl,
      tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: String(section.clientId ?? ''),
          client_secret: String(section.clientSecret ?? ''),
          scope: GRAPH_SCOPE,
          grant_type: 'client_credentials',
        }).toString(),
      },
      context,
    );
    const payload = await response.json().catch(() => null);
    const value = payload && payload.access_token ? String(payload.access_token) : '';
    if (!value) throw new Error('Graph 取令牌响应中缺少 access_token');
    const expiresIn = Number(payload && payload.expires_in);
    const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    token.value = value;
    token.expiresAt = safeNow(options) + Math.max(lifetimeSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS, 0);
    return value;
  };

  return { context, fetchImpl, accessToken, section };
}

function mailboxMessagesUrl(section) {
  const user = encodeURIComponent(String(section.user ?? ''));
  const folder = encodeURIComponent(String(section.mailboxFolder ?? 'Inbox') || 'Inbox');
  return `${GRAPH_BASE}/users/${user}/mailFolders/${folder}/messages`;
}

async function fetchGraph(config, options) {
  const warnings = [];
  const runtime = createGraphRuntime(config, options);
  const { context, fetchImpl, accessToken, section } = runtime;
  const logger = context.logger;
  const token = await accessToken();

  const lookbackDays = parsePositiveInt(section.lookbackDays, DEFAULT_LOOKBACK_DAYS);
  const filterDomains = Array.isArray(section.filterFromDomains) ? section.filterFromDomains : [];
  const since = formatGraphSince(new Date(safeNow(options) - lookbackDays * 86_400_000));
  let url = mailboxMessagesUrl(section);
  let params = {
    $filter: `receivedDateTime ge ${since}`,
    $select: SELECT_FIELDS,
    $top: String(PAGE_TOP),
  };

  const items = [];
  while (url) {
    const response = await requestWithRetry(
      fetchImpl,
      buildGraphUrl(url, params),
      { headers: { Authorization: `Bearer ${token}` } },
      context,
    );
    const payload = await response.json();
    const value = Array.isArray(payload && payload.value) ? payload.value : [];
    for (const message of value) {
      const item = graphMessageToItem(message, filterDomains, logger);
      if (item) items.push(item);
    }
    // @odata.nextLink 自带全部查询参数，翻页时不能再叠加 params
    const nextLink = payload && payload['@odata.nextLink'];
    url = typeof nextLink === 'string' && nextLink ? nextLink : null;
    params = null;
  }

  logInfo(
    logger,
    `Graph 拉取完成：${items.length} 封（近 ${lookbackDays} 天，发件人白名单 ${filterDomains.length} 条）`,
  );
  return { items, warnings };
}

function buildGraphUrl(url, params) {
  if (!params) return url;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `${url}?${query.toString()}`;
}

/** Graph $filter 的时间格式：2026-01-01T00:00:00Z（秒级、UTC、无毫秒）。 */
function formatGraphSince(date) {
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

/** 三态字符串：有值 → trim 后保留（截断 200）；空串/缺失 → null。 */
export function cleanOptionalStr(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, MAX_DATE_CHARS) : null;
}

function matchesSender(address, filterDomains) {
  if (!Array.isArray(filterDomains) || filterDomains.length === 0) return true;
  const lowered = String(address ?? '').toLowerCase();
  return filterDomains.some((domain) => {
    const normalized = String(domain ?? '').toLowerCase();
    return lowered.endsWith(`@${normalized}`) || lowered.endsWith(`.${normalized}`);
  });
}

function graphMessageToItem(message, filterDomains, logger) {
  const sender = ((message && message.from) || {}).emailAddress || {};
  const address = String(sender.address ?? '');
  if (!matchesSender(address, filterDomains)) return null;

  const messageId = String((message && message.internetMessageId) || '').trim().replace(/^<+/, '').replace(/>+$/, '');
  const fallbackId = String((message && message.id) || '');
  let externalId;
  if (messageId) externalId = `graph:${messageId}`;
  else if (fallbackId) externalId = `graph:${fallbackId}`;
  else {
    logWarn(logger, 'Graph 邮件缺少 id 与 internetMessageId，跳过');
    return null;
  }

  return {
    source: SOURCE_MAIL,
    external_id: externalId,
    course_id: null,
    payload: {
      subject: (message && message.subject) || '',
      from: address,
      receivedDateTime: cleanOptionalStr(message && message.receivedDateTime),
      bodyPreview: (message && message.bodyPreview) || '',
    },
  };
}

// ---------------------------------------------------------------------------
// 对外契约
// ---------------------------------------------------------------------------

/**
 * 拉取近 N 天的邮件。
 *
 * @param {object} config mail 配置段
 * @param {object} [options] { fetchImpl, now, logger, sleep, connect }
 * @returns {Promise<{items: object[], warnings: string[]}>}
 */
export async function fetchMail(config, options = {}) {
  const provider = String((config && config.provider) || 'imap').trim().toLowerCase();
  if (provider === 'imap') return fetchImap(config, options);
  if (provider === 'graph') return fetchGraph(config, options);
  throw new Error(`未知的邮箱 provider：${provider}（可选 imap / graph）`);
}

/**
 * 连通性自检：绝不抛异常。
 *
 * @param {object} config mail 配置段
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, message: string, detail?: object}>}
 */
export async function testMail(config, options = {}) {
  const provider = String((config && config.provider) || 'imap').trim().toLowerCase();
  const missing = mailMissingFields(config);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${describeMissing(missing)}（provider=${provider}）`,
      detail: { provider, missingFields: missing },
    };
  }

  try {
    if (provider === 'graph') return await testGraph(config, options);
    if (provider === 'imap') return await testImap(config, options);
    return {
      ok: false,
      message: `未知的邮箱 provider：${provider}（可选 imap / graph）`,
      detail: { provider },
    };
  } catch (error) {
    return { ok: false, message: friendlyFailure(provider, error), detail: { provider } };
  }
}

function friendlyFailure(provider, error) {
  const raw = errorMessage(error);
  if (provider === 'graph' && /\b(401|403)\b/.test(raw)) {
    return `该租户未授予应用级 Mail.Read 权限，建议改用 IMAP。原始错误：${raw}`;
  }
  return `${provider} 邮箱连接失败：${raw}`;
}

async function testImap(config, options) {
  const section = imapSection(config);
  const logger = resolveLogger(options.logger);
  const rateLimitRps = Number(section.rateLimitRps) > 0
    ? Number(section.rateLimitRps)
    : DEFAULT_RATE_LIMIT_RPS;
  const sleep = resolveSleep(options);
  const bucket = createTokenBucket(rateLimitRps, 1, () => safeNow(options), sleep);
  const client = new ImapClient(config, options);
  await bucket.acquire();
  try {
    const greeted = await client.connect();
    if (!greeted) throw new Error('IMAP 服务器未返回 OK 问候语');
    await client.login();
    const { exists } = await client.selectFolder();
    return {
      ok: true,
      message: `IMAP 连接成功：${section.host}:${client.port} 的 ${client.folder} 共 ${exists} 封邮件。`,
      detail: { provider: 'imap', host: client.host, port: client.port, folder: client.folder, exists },
    };
  } finally {
    try {
      await client.logout();
    } catch (error) {
      logDebug(logger, 'IMAP logout 异常，已忽略');
    }
  }
}

async function testGraph(config, options) {
  const runtime = createGraphRuntime(config, options);
  const { context, fetchImpl, accessToken, section } = runtime;
  const token = await accessToken();

  const response = await requestWithRetry(
    fetchImpl,
    buildGraphUrl(mailboxMessagesUrl(section), { $select: SELECT_FIELDS, $top: '1' }),
    { headers: { Authorization: `Bearer ${token}` } },
    context,
  );
  const payload = await response.json().catch(() => null);
  const value = Array.isArray(payload && payload.value) ? payload.value : [];
  return {
    ok: true,
    message: `Graph 连接成功：已读取到 ${value.length} 封邮件（仅探测首页）。`,
    detail: { provider: 'graph', sampled: value.length },
  };
}

/* ------------------------------------------------------------------ *
 * Source 工厂（宿主统一按 source 对象调用）
 * ------------------------------------------------------------------ */

/** 把 deps.logger / ctx.log 收敛成一个 logger 对象（显式 null = 静默）。 */
function mailSourceLogger(deps, ctx) {
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

/** ctx.now（契约是 Date）→ 底层需要的「返回毫秒的函数」；null = 用底层默认时钟。 */
function mailSourceNow(context, deps) {
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

/** 覆盖 lookbackDays；嵌套段（graph/imap）优先于扁平键，所以两边都要改。 */
function withLookback(config, days) {
  const next = { ...config, lookbackDays: days };
  if (config && typeof config.graph === 'object' && config.graph) {
    next.graph = { ...config.graph, lookbackDays: days };
  }
  if (config && typeof config.imap === 'object' && config.imap) {
    next.imap = { ...config.imap, lookbackDays: days };
  }
  return next;
}

/** 把配置里出现过的目录收敛成一个去重后的清单（IMAP 会逐个目录拉取）。 */
function imapFolderList(config) {
  const folders = [];
  const push = (value) => {
    const text = isBlank(value) ? '' : String(value).trim();
    if (text && !folders.includes(text)) folders.push(text);
  };
  if (config && Array.isArray(config.folders)) {
    for (const folder of config.folders) push(folder);
  }
  push(imapSection(config).folder);
  if (folders.length === 0) folders.push('INBOX');
  return folders;
}

/** 固定到某个目录：扁平形状靠 `folders`，嵌套形状靠 `imap.folder`（嵌套优先）。 */
function withImapFolder(config, folder) {
  const nested = config && typeof config.imap === 'object' && config.imap ? { ...config.imap } : {};
  nested.folder = folder;
  return { ...config, folders: [folder], imap: nested };
}

/** 同一个 external_id 只保留第一条（多目录/多页可能重复）。 */
function dedupeItems(items, logger) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const externalId = item ? item.external_id : undefined;
    if (isBlank(externalId)) {
      logWarn(logger, '邮件缺少 external_id，已跳过（契约要求派生不出 id 就不入队）');
      continue;
    }
    const key = String(externalId);
    if (seen.has(key)) {
      logDebug(logger, `邮件重复，已跳过：${key}`);
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 把密码/密钥从错误与日志文本里抹掉。
 *
 * 底层 IMAP 的错误信息带着原始命令（`IMAP a1 LOGIN "user" "password" 失败：...`），
 * 直接冒到 UI 或日志里等于把凭据写进磁盘，因此在出口处统一打码。
 */
function redactSecrets(text, config) {
  let out = String(text);
  const secrets = [imapSection(config).password, graphSection(config).clientSecret];
  for (const secret of secrets) {
    const value = isBlank(secret) ? '' : String(secret);
    if (value.length >= 3) out = out.split(value).join('***');
  }
  return out;
}

const IMAP_FAILURE_HINTS = [
  { pattern: /\ba\d+ LOGIN\b/i, prefix: 'IMAP 登录失败' },
  { pattern: /\ba\d+ SELECT\b/i, prefix: 'IMAP 打开目录失败' },
  { pattern: /\ba\d+ SEARCH\b/i, prefix: 'IMAP 搜索失败' },
  { pattern: /\ba\d+ FETCH\b/i, prefix: 'IMAP 读取邮件失败' },
];

/** 给整源失败补一句人话前缀（取 token / 登录 / 打开目录 / 搜索 / 网络不可达）。 */
function enrichMailError(error, config) {
  const text = redactSecrets(errorMessage(error), config);
  if (/oauth2\/v2\.0\/token/.test(text)) {
    const status = /HTTP\s+(\d{3})/.exec(text);
    const detail = text.replace(/^Graph 请求失败（HTTP \d{3}）：\s*/, '');
    return new Error(`Graph 取 token 失败${status ? `（HTTP ${status[1]}）` : ''}：${detail}`);
  }
  for (const hint of IMAP_FAILURE_HINTS) {
    if (hint.pattern.test(text)) return new Error(`${hint.prefix}：${text}`);
  }
  if (/HTTP 401/.test(text)) {
    return new Error(`Graph 返回 401（应用级 Mail.Read 权限可能未授予，或 client_secret 已过期）：${text}`);
  }
  if (/HTTP 403/.test(text)) {
    return new Error(`Graph 返回 403（权限不足，需要应用级 Mail.Read）：${text}`);
  }
  if (!/^(IMAP|Graph)/.test(text) && /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|socket hang up)/.test(text)) {
    return new Error(`无法连接邮箱服务器：${text}`);
  }
  return error instanceof Error ? error : new Error(text);
}

/**
 * 造一个邮箱 source 对象（新契约）。
 *
 * @param {object} config plugin config 的 mail 段。扁平形状
 *        （`{enabled, provider, host, port, user, password, folders, tenantId, clientId,
 *        clientSecret, senderDomains, lookbackDays}`）与嵌套形状
 *        （`{provider, graph: {...}, imap: {...}}`）都支持；两者同时出现时嵌套优先。
 * @param {{fetch?: Function, connect?: Function, sleep?: Function, now?: () => number,
 *          logger?: object|null}} [deps] 注入点（仅测试/宿主适配用）
 * @returns {{name: string, enabled: boolean, configured: boolean, describe: Function,
 *           fetchItems: Function, test: Function}}
 */
export function createMailSource(config = {}, deps = {}) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const injected = deps && typeof deps === 'object' ? deps : {};
  const provider = String(cfg.provider || 'imap').trim().toLowerCase();
  const configured = mailConfigured(cfg);
  const missingFields = mailMissingFields(cfg);
  const section = provider === 'graph' ? graphSection(cfg) : imapSection(cfg);
  const defaultLookbackDays = parsePositiveInt(section.lookbackDays, DEFAULT_LOOKBACK_DAYS);
  const isEnabled = () => (cfg.enabled === undefined ? true : Boolean(cfg.enabled));

  /** 邮箱侧没有 baseUrl 概念：IMAP 用 host:port，Graph 用租户无关的固定端点。 */
  const locator = () => {
    if (provider === 'graph') return `${GRAPH_BASE}/users/${String(section.user ?? '')}/mailFolders/${String(section.mailboxFolder ?? 'Inbox') || 'Inbox'}/messages`;
    return `${String(section.host ?? '')}:${parsePositiveInt(section.port, 993)}`;
  };

  const plan = (ctx) => {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    const logger = mailSourceLogger(injected, context);
    const options = { logger };
    if (typeof injected.fetch === 'function') options.fetchImpl = injected.fetch;
    if (typeof injected.sleep === 'function') options.sleep = injected.sleep;
    if (typeof injected.connect === 'function') options.connect = injected.connect;
    const now = mailSourceNow(context, injected);
    if (now) options.now = now;
    const overrideDays = Number(context.lookbackDays);
    const effective =
      context.lookbackDays === undefined || !Number.isFinite(overrideDays)
        ? cfg
        : withLookback(cfg, overrideDays);
    return { context, logger, options, effective };
  };

  return {
    name: 'mail',
    get enabled() {
      return isEnabled();
    },
    get configured() {
      return configured;
    },
    describe() {
      return {
        enabled: isEnabled(),
        configured,
        provider,
        baseUrl: locator(),
        lookbackDays: defaultLookbackDays,
        missingFields: [...missingFields],
      };
    },
    async fetchItems(ctx = {}) {
      if (provider !== 'graph' && provider !== 'imap') {
        throw new Error(`未知的邮箱 provider：${provider}（可选 imap / graph）`);
      }
      if (!configured) {
        throw new Error(`邮箱未配置完整：缺少 ${missingFields.join('、')}（provider=${provider}）`);
      }
      const { logger, options, effective } = plan(ctx);
      const folders = provider === 'imap'
        ? imapFolderList(effective)
        : [String(graphSection(effective).mailboxFolder ?? 'Inbox') || 'Inbox'];
      const collected = [];
      const warnings = [];
      let failure = null;
      let succeeded = 0;
      for (const folder of folders) {
        const scoped = provider === 'imap' ? withImapFolder(effective, folder) : effective;
        try {
          const result = await fetchMail(scoped, options);
          succeeded += 1;
          if (Array.isArray(result && result.items)) collected.push(...result.items);
          if (Array.isArray(result && result.warnings)) warnings.push(...result.warnings);
        } catch (error) {
          // 单个目录失败不能吞掉其它目录；只有所有目录都失败才算整源失败。
          if (!failure) failure = enrichMailError(error, cfg);
          warnings.push(`目录 ${folder} 拉取失败：${redactSecrets(errorMessage(error), cfg)}`);
        }
      }
      for (const warning of warnings) logWarn(logger, redactSecrets(warning, cfg));
      if (succeeded === 0 && failure) throw failure;
      return dedupeItems(collected, logger);
    },
    async test(ctx = {}) {
      const { options } = plan(ctx);
      const result = await testMail(cfg, options);
      const out = { ok: result?.ok === true, message: String(result?.message ?? '') };
      if (result && result.detail !== undefined) out.detail = result.detail;
      return out;
    },
  };
}
