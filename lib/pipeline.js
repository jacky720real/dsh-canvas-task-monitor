/**
 * 拉取管线：拉取 → 变更检测 → 打分（规则 / AI）→ 落库 → 记录快照。
 *
 * 顺序即不变量（沿用旧项目，改动前先读这段）：
 *   1. 逐源隔离：一个源抛错只记进 errors，不影响另一个源；
 *   2. **没有变更就绝不调用 AI**（省钱、省时间）；
 *   3. 先算草稿、写任务，**最后才写快照** —— 快照写早了，崩溃或 AI 失败会让这批素材永远丢失；
 *   4. AI 全部批次失败时：规则草稿照写，但该源不写快照，下一轮自动重试；
 *   5. 单条任务写库失败只记日志，不影响同一批的其它任务；
 *   6. 没有"removed"：素材消失既不删任务也不改状态（旧项目的已知取舍，这里保持一致）。
 */
import { asInt, asString, canonicalHash, errorText, utcNowIso } from './util.js';
import { dbPathIn } from './config.js';
import { fetchCanvas, canvasConfigured, testCanvas } from './canvas.js';
import { fetchMail, mailConfigured, testMail } from './mail.js';
import { ruleAssess, computeScore } from './scoring.js';
import { aiConfigured, scoreItems, testAi } from './llm.js';
import { isAvailable as sqliteAvailable, openStore } from './store.js';

/** 每个 source 参与哈希的字段（与旧项目 core/hashing.py:13-17 完全一致）。 */
export const HASH_FIELDS = {
  canvas_assignment: ['name', 'description', 'due_at', 'points_possible', 'submission_types'],
  canvas_announcement: ['title', 'message', 'posted_at'],
  mail: ['subject', 'from', 'receivedDateTime', 'bodyPreview'],
};

/** 同形状（数字抹平后）的告警最多原样留几条，其余折成一行计数。 */
export const WARNING_KIND_LIMIT = 2;

/** 未知 source 必须抛错，绝不回退成"整份 payload 全量哈希"。 */
export function hashItem(item) {
  const source = asString(item?.source);
  const fields = HASH_FIELDS[source];
  if (fields === undefined) {
    throw new Error(`未登记哈希字段的 source：${source}（请在 pipeline.HASH_FIELDS 里补上白名单）`);
  }
  return canonicalHash(item?.payload ?? {}, fields);
}

/**
 * 变更检测（只读快照，不产生 removed）。
 * @returns {Array<{item: object, change_type: 'new'|'updated', content_hash: string, previous_hash: string|null, changed_fields: string[]}>}
 */
export function detectChanges(items, hashes) {
  const changes = [];
  for (const item of items) {
    const key = asString(item?.external_id);
    const contentHash = hashItem(item);
    const previous = hashes instanceof Map ? hashes.get(key) : undefined;
    if (previous === undefined || previous === null) {
      changes.push({
        item,
        change_type: 'new',
        content_hash: contentHash,
        previous_hash: null,
        changed_fields: [...HASH_FIELDS[asString(item?.source)]],
      });
      continue;
    }
    if (previous !== contentHash) {
      changes.push({
        item,
        change_type: 'updated',
        content_hash: contentHash,
        previous_hash: previous,
        changed_fields: [...HASH_FIELDS[asString(item?.source)]],
      });
    }
  }
  return changes;
}

/** Canvas 的 due_at 直接来自 LMS 的权威字段：规则草稿已有值时，不接受 AI 覆盖。 */
const AUTHORITATIVE_DUE_AT = new Set(['canvas_assignment']);

/** 把 AI 结果覆盖到规则草稿上（AI 没给的字段保留规则值）。 */
export function mergeDraft(ruleDraft, aiDraft) {
  if (aiDraft === null || aiDraft === undefined) return { ...ruleDraft, ai_scored: false };
  const merged = { ...ruleDraft };
  const dueLocked = AUTHORITATIVE_DUE_AT.has(asString(ruleDraft.source)) && asString(ruleDraft.due_at).trim().length > 0;
  for (const key of ['category', 'title', 'summary', 'course', 'due_at', 'urgency', 'importance', 'is_rule', 'urgency_reason', 'importance_reason']) {
    // 权威截止时间只由源决定：模型写错一个日期，用户就会漏交作业
    if (key === 'due_at' && dueLocked) continue;
    const value = aiDraft[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    merged[key] = value;
  }
  if (Array.isArray(aiDraft.tags) && aiDraft.tags.length > 0) merged.tags = aiDraft.tags;
  merged.ai_scored = true;
  return merged;
}

/** 从 RawItem 起一条完整的"待写库"任务（含 status/raw_json）。 */
export function finishDraft(draft, weights) {
  return {
    ...draft,
    status: 'pending',
    score: computeScore(draft.urgency, draft.importance, weights),
    raw_json: draft.raw_json ?? '',
  };
}

function canvasFetchConfig(canvas) {
  return {
    baseUrl: asString(canvas.baseUrl),
    token: asString(canvas.token),
    lookbackDays: asInt(canvas.lookbackDays, 30, 1, 3650),
    timeoutSeconds: Math.max(asInt(canvas.timeoutMs, 20_000, 1000, 300_000) / 1000, 1),
    rateLimitRps: Number(canvas.requestsPerSecond) > 0 ? Number(canvas.requestsPerSecond) : 3,
    retry: { maxAttempts: asInt(canvas.maxAttempts, 3, 1, 10), backoffBase: 1.5 },
  };
}

/**
 * 跑一轮拉取。
 *
 * @param {{dataDir: string, config: object, logger?: object, store?: object, nowMs?: number,
 *          fetchImpl?: Function, sleep?: Function, sources?: string[]}} params
 * @returns {Promise<object>} stats
 */
export async function pollOnce(params) {
  const dataDir = asString(params?.dataDir);
  const config = params?.config ?? {};
  const logger = params?.logger ?? null;
  const store = params?.store ?? openStore(dbPathIn(dataDir));
  const nowMs = Number.isFinite(params?.nowMs) ? params.nowMs : Date.now();
  const weights = { urgencyWeight: config?.scoring?.urgencyWeight, importanceWeight: config?.scoring?.importanceWeight };
  const wanted = Array.isArray(params?.sources) && params.sources.length > 0 ? params.sources : ['canvas', 'mail'];

  const stats = {
    started_at: new Date(nowMs).toISOString(),
    finished_at: null,
    duration_ms: 0,
    sources: 0,
    changes: 0,
    tasks: 0,
    llm_calls: 0,
    ai_used: false,
    errors: [],
    warnings: [],
    per_source: {},
  };

  const plans = {
    canvas: {
      enabled: config?.canvas?.enabled === true,
      configured: canvasConfigured(config?.canvas),
      label: 'Canvas',
      fetch: () => fetchCanvas(canvasFetchConfig(config.canvas), params),
    },
    mail: {
      enabled: config?.mail?.enabled === true,
      configured: mailConfigured(config?.mail),
      label: '邮箱',
      fetch: () => fetchMail(config.mail, params),
    },
  };

  const aiOn = aiConfigured(config?.ai);

  for (const name of wanted) {
    const plan = plans[name];
    if (plan === undefined) {
      stats.errors.push(`未知的数据源：${name}`);
      continue;
    }
    if (!plan.enabled) continue;
    if (!plan.configured) {
      stats.errors.push(`${plan.label} 已启用但配置不完整，已跳过`);
      continue;
    }
    stats.sources += 1;
    const sourceStat = { items: 0, changes: 0, tasks: 0, llm_calls: 0, ai_scored: 0, skipped: 0, warnings: [] };

    let fetched = null;
    try {
      fetched = await plan.fetch();
    } catch (error) {
      // 逐源隔离：一个源挂掉不影响另一个源
      stats.errors.push(`${plan.label} 拉取失败：${errorText(error)}`);
      stats.per_source[name] = sourceStat;
      continue;
    }

    const items = Array.isArray(fetched?.items) ? fetched.items : [];
    // 同一轮里重复的 (source, external_id) 只保留第一条（tasks 上是 UNIQUE）
    const seen = new Set();
    const unique = [];
    for (const item of items) {
      const key = asString(item?.external_id);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    sourceStat.items = unique.length;
    if (Array.isArray(fetched?.warnings)) {
      // 真机上一门课就能刷出几十条「早于回溯窗口已跳过」；按"把数字抹平后的形状"
      // 归并，同一形状最多留 2 条，其余折成一行计数，避免面板被刷屏。
      const kept = [];
      const kindCounts = new Map();
      for (const text of fetched.warnings) {
        const kind = asString(text).replace(/\d+/g, '#');
        const seen = (kindCounts.get(kind) ?? 0) + 1;
        kindCounts.set(kind, seen);
        if (seen <= WARNING_KIND_LIMIT) kept.push(text);
      }
      sourceStat.warning_count = fetched.warnings.length;
      sourceStat.warnings = kept.slice(0, 50);
      stats.warnings.push(...kept.slice(0, 20).map((text) => `${plan.label}：${text}`));
      if (kept.length < fetched.warnings.length) {
        stats.warnings.push(`${plan.label}：另有 ${fetched.warnings.length - kept.length} 条同类提示已省略`);
      }
    }

    let changes = [];
    try {
      changes = detectChanges(unique, store.getSnapshotHashes(name));
    } catch (error) {
      stats.errors.push(`${plan.label} 变更检测失败：${errorText(error)}`);
      stats.per_source[name] = sourceStat;
      continue;
    }
    sourceStat.changes = changes.length;
    stats.changes += changes.length;
    if (changes.length === 0) {
      // 不变式 2：没变更就不调用 AI
      stats.per_source[name] = sourceStat;
      continue;
    }

    const ruleDrafts = changes.map((change) => ({
      ...ruleAssess(change.item, { nowMs, weights: config?.scoring }),
      change_type: change.change_type,
      content_hash: change.content_hash,
    }));

    let drafts = ruleDrafts;
    let settled = new Set(changes.map((change) => `${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`));
    if (aiOn) {
      stats.ai_used = true;
      const aiResult = await scoreItems(
        changes.map((change) => ({ ...change.item, change_type: change.change_type })),
        config.ai,
        { weights, nowIso: utcNowIso(), fetchImpl: params?.fetchImpl, sleep: params?.sleep, logger },
      );
      stats.llm_calls += aiResult.calls;
      sourceStat.llm_calls = aiResult.calls;
      settled = aiResult.settled;
      stats.warnings.push(...aiResult.errors.slice(0, 10).map((text) => `${plan.label}：${text}`));
      drafts = changes.map((change, index) => {
        const key = `${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`;
        const merged = mergeDraft(ruleDrafts[index], aiResult.drafts.get(key) ?? null);
        return { ...merged, change_type: change.change_type, content_hash: change.content_hash };
      });
      sourceStat.ai_scored = drafts.filter((draft) => draft.ai_scored === true).length;
      if (settled.size === 0) {
        stats.errors.push(`${plan.label} 的 AI 评分全部失败，本轮不写快照，任务使用规则分`);
      }
    }

    // 写任务（逐条隔离）
    for (const draft of drafts) {
      try {
        store.upsertTask(finishDraft(draft, weights));
        stats.tasks += 1;
        sourceStat.tasks += 1;
      } catch (error) {
        stats.errors.push(`写入任务失败（${asString(draft.external_id)}）：${errorText(error)}`);
      }
    }

    // 写快照：只写"这一轮已经有明确结论"的素材
    const snapshotEntries = changes
      .filter((change) => settled.has(`${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`))
      .map((change) => ({
        external_id: change.item.external_id,
        course_id: change.item.course_id ?? null,
        content_hash: change.content_hash,
        payload: change.item.payload ?? {},
      }));
    if (snapshotEntries.length > 0) store.upsertSnapshots(name, snapshotEntries);

    store.recordChanges(
      changes.map((change) => ({
        source: name,
        external_id: change.item.external_id,
        change_type: change.change_type,
        diff: { hash: { from: change.previous_hash, to: change.content_hash } },
        processed: settled.has(`${asString(change.item?.source)}\u0000${asString(change.item?.external_id)}`),
      })),
      new Date(nowMs).toISOString(),
    );

    sourceStat.skipped = changes.length - snapshotEntries.length;
    stats.per_source[name] = sourceStat;
  }

  const finishedMs = Date.now();
  stats.finished_at = new Date(finishedMs).toISOString();
  stats.duration_ms = finishedMs - nowMs;
  try {
    store.setMeta('last_poll_at', stats.finished_at);
    store.setMeta('last_poll_stats', JSON.stringify(stats));
  } catch (error) {
    stats.errors.push(`写入拉取状态失败：${errorText(error)}`);
  }
  return stats;
}

/** 设置页的"测试连接"。绝不抛异常。 */
export async function testSource(config, source, options = {}) {
  const name = asString(source);
  if (name === 'canvas') {
    if (!sqliteAvailable() && options.requireStore === true) return { ok: false, message: '当前运行时不支持 node:sqlite' };
    return testCanvas(canvasFetchConfig(config?.canvas ?? {}), options);
  }
  if (name === 'mail') return testMail(config?.mail ?? {}, options);
  if (name === 'ai') return testAi(config?.ai ?? {}, options);
  return { ok: false, message: `未知的数据源：${name}` };
}

/** 诊断用：当前数据源状态（不触发任何网络调用）。 */
export function describeSources(config) {
  const canvas = config?.canvas ?? {};
  const mail = config?.mail ?? {};
  return {
    canvas: { enabled: canvas.enabled === true, configured: canvasConfigured(canvas) },
    mail: { enabled: mail.enabled === true, configured: mailConfigured(mail), provider: asString(mail.provider) || 'imap' },
    ai: { enabled: config?.ai?.enabled === true, configured: aiConfigured(config?.ai) },
    sqlite: sqliteAvailable(),
  };
}
