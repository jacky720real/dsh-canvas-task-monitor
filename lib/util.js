/**
 * 通用小工具：时间、哈希、类型收敛。
 *
 * 全部是纯函数，宿主半区与测试夹具共用；不依赖任何服务，也不读写文件。
 */
import { createHash } from 'node:crypto';

/** UTC ISO 秒级时间戳（与旧 Python 侧 utc_now_iso() 保持同形：2026-09-30T12:00:00+00:00）。 */
export function utcNowIso(date = new Date()) {
  return `${new Date(date.getTime()).toISOString().slice(0, 19)}+00:00`;
}

/** 把任意输入收敛成字符串；null/undefined 变 ''。 */
export function asString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 把任意输入收敛成整数，越界夹到 [min, max]。 */
export function asInt(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'number' ? value : Number.parseInt(asString(value), 10);
  if (!Number.isFinite(n)) return clamp(fallback, min, max);
  return clamp(Math.trunc(n), min, max);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 字符串数组：非数组 → []，元素去空、去重、保序。 */
export function asStringArray(value, limit = 0) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const text = asString(entry).trim();
    if (text.length === 0 || out.includes(text)) continue;
    out.push(text);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

/** 用逗号（中英文）或分号切分字符串成数组。 */
export function splitList(value) {
  return asStringArray(asString(value).split(/[,，;；]/).map((part) => part.trim()));
}

/** 解析时间字符串为毫秒；不可解析返回 null。Time 无时区信息时按 UTC 处理。 */
export function parseDateMs(value) {
  const text = asString(value).trim();
  if (text.length === 0) return null;
  // 无时区偏移（且不是纯日期）时补 Z，避免被当成浏览器/进程本地时区。
  const needsZulu = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const normalized = needsZulu ? `${text.replace(' ', 'T')}Z` : text;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 变更检测用的规范化哈希。
 *
 * `fields` 是该 source 的白名单字段（与旧 Python 侧 core/hashing.py 一致），
 * 只对这些字段取值后按 key 排序序列化再 sha256 —— 因此 course_name 这类
 * 展示用字段变化不会误判成"任务被修改"。
 */
export function canonicalHash(payload, fields) {
  const subset = {};
  for (const field of [...fields].sort()) {
    const value = payload === null || typeof payload !== 'object' ? undefined : payload[field];
    subset[field] = value === undefined ? null : value;
  }
  const json = JSON.stringify(subset, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** 把毫秒差格式化成"X 天 / X 小时 / X 分钟"。 */
export function humanizeDuration(ms) {
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)} 分钟`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(abs / 86_400_000)} 天`;
}

/** 截断长文本，避免日志/提示过长。 */
export function truncate(value, max = 200) {
  const text = asString(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 把错误对象转成可读文本（不吞掉非 Error 抛出物）。 */
export function errorText(error, fallback = '未知错误') {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  const text = asString(error);
  return text.length > 0 ? text : fallback;
}
