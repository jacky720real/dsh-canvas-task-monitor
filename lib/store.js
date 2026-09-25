/**
 * 存储层：node:sqlite（DSH 的 Electron 运行时自带，Node 24 / modules 148 实测可用）。
 *
 * 语义照搬旧 Python 侧的 storage/task_repo.py，因为它编码了两条硬约束：
 *   1. **status 归用户所有**：UPSERT 的 DO UPDATE SET 里绝不能出现 status，
 *      否则用户刚勾的"完成"会在下一次拉取时被打回 pending；
 *   2. created_at 只在 INSERT 时写死，之后永不改动。
 *
 * 与旧实现的差异（有意为之）：
 *   - 多了 meta 表（存 last_poll_at），不再依赖 data/state.json；
 *   - 列表排序改由 scoring.sortTasks 在 JS 侧完成（按截止时间，再按重要程度），
 *     不再用 `ORDER BY score DESC`（旧排序把无时间的任务排在最前面）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { asInt, asString, asStringArray, parseDateMs, utcNowIso } from './util.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export const SQLITE_MISSING_MESSAGE =
  '当前运行时没有 node:sqlite（需要 Node 22.5+ / DSH Desktop 自带的 Electron 运行时），无法打开任务数据库。';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  course_id TEXT,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  urgency INTEGER NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_rule INTEGER NOT NULL DEFAULT 0,
  urgency_reason TEXT NOT NULL DEFAULT '',
  importance_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  raw_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  diff_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** node:sqlite 不接受 undefined / boolean，统一收敛。 */
function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value;
  return asString(value);
}

function rowToTask(row) {
  if (row === null || row === undefined) return null;
  let tags = [];
  try {
    tags = asStringArray(JSON.parse(asString(row.tags_json) || '[]'));
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id),
    source: asString(row.source),
    external_id: asString(row.external_id),
    category: asString(row.category),
    title: asString(row.title),
    summary: asString(row.summary),
    course: asString(row.course),
    due_at: row.due_at === null || row.due_at === undefined || asString(row.due_at).length === 0 ? null : asString(row.due_at),
    urgency: asInt(row.urgency, 0, 0, 5),
    importance: asInt(row.importance, 0, 0, 5),
    score: asInt(row.score, 0, 0, 100),
    is_rule: row.is_rule === 1 || row.is_rule === true,
    urgency_reason: asString(row.urgency_reason),
    importance_reason: asString(row.importance_reason),
    tags,
    status: asString(row.status) === 'done' ? 'done' : 'pending',
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

export function isAvailable() {
  return DatabaseSync !== null;
}

/** 打开（必要时创建）数据库。 */
export function openStore(dbPath) {
  if (DatabaseSync === null) throw new Error(SQLITE_MISSING_MESSAGE);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return new Store(dbPath, db);
}

class Store {
  constructor(path, db) {
    this.path = path;
    this.db = db;
    this.closed = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* 关闭失败无需处理 */
    }
  }

  /* ------------------------------------------------------------ 快照 */

  /** source → (external_id → content_hash)。 */
  getSnapshotHashes(source) {
    const rows = this.db.prepare('SELECT external_id, content_hash FROM snapshots WHERE source = ?').all(bind(source));
    const map = new Map();
    for (const row of rows) map.set(asString(row.external_id), asString(row.content_hash));
    return map;
  }

  /** 写入快照；first_seen_at 保持不变。 */
  upsertSnapshots(source, entries, nowIso = utcNowIso()) {
    const stmt = this.db.prepare(
      `INSERT INTO snapshots (source, external_id, course_id, content_hash, payload_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET
         course_id = excluded.course_id,
         content_hash = excluded.content_hash,
         payload_json = excluded.payload_json,
         last_seen_at = excluded.last_seen_at`,
    );
    let count = 0;
    for (const entry of entries) {
      stmt.run(
        bind(source),
        bind(entry.external_id),
        bind(entry.course_id ?? null),
        bind(entry.content_hash),
        bind(JSON.stringify(entry.payload ?? {}, Object.keys(entry.payload ?? {}).sort())),
        bind(entry.first_seen_at ?? nowIso),
        bind(nowIso),
      );
      count += 1;
    }
    return count;
  }

  /* ------------------------------------------------------------ 任务 */

  /** 已有的 (source, external_id) 集合，用于区分 created / updated。 */
  existingKeys() {
    const rows = this.db.prepare('SELECT source, external_id FROM tasks').all();
    const set = new Set();
    for (const row of rows) set.add(`${asString(row.source)}\u0000${asString(row.external_id)}`);
    return set;
  }

  /**
   * 写入/更新一条任务。
   * title 为空时用 external_id 兜底（tasks.title NOT NULL）。
   * 返回任务 id；写后回读失败抛错（与旧实现一致，避免"写了但拿不到主键"的静默错误）。
   */
  upsertTask(task, nowIso = utcNowIso()) {
    const now = asString(task.updated_at).length > 0 ? asString(task.updated_at) : nowIso;
    const createdAt = asString(task.created_at).length > 0 ? asString(task.created_at) : now;
    const title = asString(task.title).trim().length > 0 ? asString(task.title) : asString(task.external_id);
    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         source, external_id, category, title, summary, course, due_at,
         urgency, importance, score, tags_json, is_rule,
         urgency_reason, importance_reason, status, raw_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET
         category = excluded.category,
         title = excluded.title,
         summary = excluded.summary,
         course = excluded.course,
         due_at = excluded.due_at,
         urgency = excluded.urgency,
         importance = excluded.importance,
         score = excluded.score,
         tags_json = excluded.tags_json,
         is_rule = excluded.is_rule,
         urgency_reason = excluded.urgency_reason,
         importance_reason = excluded.importance_reason,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    );
    stmt.run(
      bind(task.source),
      bind(task.external_id),
      bind(task.category),
      bind(title),
      bind(asString(task.summary)),
      bind(asString(task.course)),
      bind(asString(task.due_at).length > 0 ? asString(task.due_at) : null),
      bind(asInt(task.urgency, 0, 0, 5)),
      bind(asInt(task.importance, 0, 0, 5)),
      bind(asInt(task.score, 0, 0, 100)),
      bind(JSON.stringify(asStringArray(task.tags).slice(0, 12))),
      bind(task.is_rule === true ? 1 : 0),
      bind(asString(task.urgency_reason)),
      bind(asString(task.importance_reason)),
      bind(asString(task.status) === 'done' ? 'done' : 'pending'),
      bind(asString(task.raw_json)),
      bind(createdAt),
      bind(now),
    );
    const row = this.db.prepare('SELECT id FROM tasks WHERE source = ? AND external_id = ?').get(bind(task.source), bind(task.external_id));
    if (row === undefined || row === null) {
      throw new Error(`任务写入后未能读回主键：${task.source}/${task.external_id}`);
    }
    return Number(row.id);
  }

  /** status 的唯一写者（用户勾选走这里）。 */
  setStatus(id, status) {
    const value = asString(status);
    if (value !== 'pending' && value !== 'done') throw new Error(`非法的任务状态：${value}`);
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(bind(value), bind(utcNowIso()), bind(asInt(id, 0)));
    return this.getTask(id);
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(bind(asInt(id, 0)));
    return rowToTask(row);
  }

  /** 原始行列表（不做排序，排序由 scoring.sortTasks 负责）。 */
  listTasks({ category = '', status = '', limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (asString(category).length > 0) {
      where.push('category = ?');
      params.push(bind(category));
    }
    if (asString(status).length > 0) {
      where.push('status = ?');
      params.push(bind(status));
    }
    const sql = `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} LIMIT ?`;
    params.push(bind(asInt(limit, 1000, 1, 100_000)));
    return this.db.prepare(sql).all(...params).map(rowToTask).filter((task) => task !== null);
  }

  /** 待办汇总（overdue / dueToday / max_urgency 在 JS 侧算，避免时区与字符串比较的坑）。 */
  summarize(nowMs = Date.now()) {
    const counts = { assignment: 0, activity: 0, reminder: 0 };
    const rows = this.db.prepare('SELECT category, due_at, urgency FROM tasks WHERE status = ?').all(bind('pending'));
    const today = new Date(nowMs);
    let overdue = 0;
    let dueToday = 0;
    let maxUrgency = 0;
    for (const row of rows) {
      const category = asString(row.category);
      if (Object.prototype.hasOwnProperty.call(counts, category)) counts[category] += 1;
      const dueMs = parseDateMs(row.due_at);
      if (dueMs !== null) {
        if (dueMs < nowMs) overdue += 1;
        const due = new Date(dueMs);
        if (
          due.getFullYear() === today.getFullYear() &&
          due.getMonth() === today.getMonth() &&
          due.getDate() === today.getDate()
        ) {
          dueToday += 1;
        }
      }
      maxUrgency = Math.max(maxUrgency, asInt(row.urgency, 0, 0, 5));
    }
    const total = counts.assignment + counts.activity + counts.reminder;
    return {
      total,
      assignment: counts.assignment,
      activity: counts.activity,
      reminder: counts.reminder,
      overdue,
      dueToday,
      max_urgency: maxUrgency,
    };
  }

  counts() {
    const row = this.db
      .prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, COUNT(*) AS total FROM tasks")
      .get();
    return {
      pending: Number(row?.pending ?? 0),
      done: Number(row?.done ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  /* -------------------------------------------------------- 变更日志 */

  recordChanges(rows, nowIso = utcNowIso()) {
    const stmt = this.db.prepare(
      `INSERT INTO change_log (source, external_id, change_type, diff_json, detected_at, processed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let count = 0;
    for (const row of rows) {
      stmt.run(
        bind(row.source),
        bind(row.external_id),
        bind(row.change_type),
        bind(JSON.stringify(row.diff ?? {})),
        bind(nowIso),
        bind(row.processed === true ? 1 : 0),
      );
      count += 1;
    }
    return count;
  }

  /* ------------------------------------------------------------- meta */

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(bind(key), bind(value));
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(bind(key));
    return row === undefined || row === null ? null : asString(row.value);
  }

  /** 清空任务/快照/日志（设置页的"重置本地数据"用）。 */
  reset() {
    this.db.exec('DELETE FROM tasks; DELETE FROM snapshots; DELETE FROM change_log;');
  }
}
