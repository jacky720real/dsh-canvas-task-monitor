/**
 * AI 评分（可选增强）。
 *
 * 定位：这是"锦上添花"的一层。插件不配 AI key 也能用 —— 那种情况下 pipeline.js 直接用
 * scoring.js 的规则打分。配了 key 时，这里的结果**覆盖**规则结果里对应字段。
 *
 * 与旧 Python 项目的差异（重要，写在这里免得以后误改）：
 *   - 旧项目**没有规则打分**，LLM 是唯一打分路径，key 一坏就一条任务都不出；
 *   - 旧项目 llm_ok=false 时"不写快照也不写任务"，下轮整批重试（会一直卡住）；
 *     这里保留"LLM 失败不写快照"的不变性，但**规则草稿仍然落库**，只是标记为未经 AI 评分，
 *     这样面板永远有内容，AI 恢复后下一轮再覆盖。
 *
 * 不变式（沿用旧项目）：
 *   - 模型给的 score 一律丢弃（`禁止输出 score`），score 只由 scoring.computeScore 计算；
 *   - urgency / importance 是 0–5 整数，超出范围的值整条丢弃（宁可回退规则分，不用脏分）；
 *   - tags 只保留白名单内的，最多 5 个；category 只能是 assignment/activity/reminder；
 *   - 只接受"请求里确实出现过"的 external_id，模型凭空编造的条目直接无视；
 *   - 重试只针对网络异常 / 超时 / 429 / 5xx / 空 content；其它错误（400、JSON 解析失败）不重试。
 */
import { asInt, asString, asStringArray, clamp, errorText, parseDateMs, truncate, utcNowIso } from './util.js';
import { TAG_WHITELIST, computeScore } from './scoring.js';

/** 与旧项目一致的分类白名单。 */
export const ALLOWED_CATEGORIES = ['assignment', 'activity', 'reminder'];

/** 禁止模型输出的键（分数必须由代码算）。 */
const FORBIDDEN_KEYS = ['score'];

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 20_000;

/** AI 配置是否齐全。 */
export function aiConfigured(ai) {
  if (ai === null || typeof ai !== 'object' || ai.enabled !== true) return false;
  return asString(ai.baseUrl).length > 0 && asString(ai.apiKey).length > 0 && asString(ai.model).length > 0;
}

/** 系统提示词（旧项目 config/templates/task_extract_template.yaml 的等价重写）。 */
export function buildSystemPrompt() {
  return [
    '你是一个学习任务整理助手。你会收到一批原始素材（Canvas 作业、Canvas 公告、邮件），',
    '请判断每条素材是否构成一个需要跟进的待办任务，并给出紧急度与重要度。',
    '',
    '输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释文字。',
    '2. 顶层结构必须是 {"tasks": [ ... ]}。',
    '3. 每个元素必须且只能包含这些键：source, external_id, category, title, summary, course,',
    '   due_at, urgency, importance, urgency_reason, importance_reason, tags, is_rule。',
    '4. 每条素材最多产出一条任务；不构成任务的素材直接跳过，不要为它编造任务。',
    '   source 与 external_id 必须原样抄回该素材的值，绝不修改。',
    '5. category 只能是 assignment、activity、reminder 之一。',
    '6. urgency 与 importance 都是 0–5 的整数；urgency_reason / importance_reason 是各不超过 200 字的说明。',
    `7. tags 最多 5 个，只能从这个列表里选：${TAG_WHITELIST.join(', ')}。`,
    '8. 禁止输出 score 字段，分数由系统计算。',
    '9. title 简短明确（不超过 60 字）；summary 用一两句话概括，不要抄整段原文。',
    '10. due_at 必须是 ISO 8601 字符串（例如 2026-09-30T23:59:00+08:00）或 null。',
    '    素材里没有明确截止时间就填 null，绝不凭猜测编造时间。',
    '11. is_rule 表示"这是规则/政策类通知而不是要做的事"，是布尔值。',
    '',
    '紧急度（urgency）锚点：',
    '  0 = 没有截止时间，或截止时间在 30 天以后',
    '  1 = 14 天内截止',
    '  2 = 7 天内截止',
    '  3 = 3 天内截止',
    '  4 = 24 小时内截止',
    '  5 = 已逾期，或今天截止',
    '',
    '重要度（importance）锚点：',
    '  0 = 纯通知，不需要动作',
    '  1 = 选修、低权重内容',
    '  2 = 一般作业',
    '  3 = 占总评 10% 以上，或期中考试',
    '  4 = 占总评 20% 以上，或期末考试/答辩',
    '  5 = 硬性门槛（不通过就会挂科、必须完成的先修条件）',
  ].join('\n');
}

/** 用户提示词：只暴露"当前时间"和素材数组。 */
export function buildUserPrompt(items, nowIso = utcNowIso()) {
  const payload = items.map((item) => ({
    source: item.source,
    external_id: item.external_id,
    change_type: item.change_type,
    course_id: item.course_id ?? null,
    data: item.payload ?? {},
  }));
  return [
    `当前时间：${nowIso}`,
    `以下 ${payload.length} 条素材（JSON 数组）：`,
    JSON.stringify(payload, null, 2),
    '',
    '请按系统提示词的格式返回 {"tasks": [...]}。',
  ].join('\n');
}

/** 去掉 ```json 围栏（模型偶尔还是会加）。 */
export function stripCodeFence(text) {
  const raw = asString(text).trim();
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(raw);
  if (match !== null) return match[1].trim();
  return raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * 发一次 chat/completions，带与旧项目一致的重试策略。
 * 返回 { ok, content } 或 { ok:false, error, retryable }。
 */
export async function callChat(ai, messages, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : (url, init) => globalThis.fetch(url, init);
  const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
  const url = `${asString(ai.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = asInt(ai.timeoutMs, 60_000, 1000, 300_000);
  const body = {
    model: asString(ai.model),
    messages,
    temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.1,
    max_tokens: asInt(ai.maxOutputTokens, 4000, 16, 32_000),
    response_format: { type: 'json_object' },
  };
  let lastError = '未知错误';

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    let response = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${asString(ai.apiKey)}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = `网络请求失败：${errorText(error)}`;
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await wait(Math.min(RETRY_BASE_MS * 1.5 ** attempt, RETRY_MAX_MS));
        continue;
      }
      return { ok: false, error: lastError };
    } finally {
      clearTimeout(timer);
    }

    if (isRetryableStatus(response.status)) {
      const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : null;
      const seconds = header === null || header === undefined ? Number.NaN : Number(header);
      lastError = `HTTP ${response.status}`;
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = Number.isFinite(seconds) ? Math.max(seconds * 1000, 500) : Math.min(RETRY_BASE_MS * 1.5 ** attempt, RETRY_MAX_MS);
        await wait(delay);
        continue;
      }
      return { ok: false, error: lastError };
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = truncate(await response.text(), 300);
      } catch {
        detail = '';
      }
      return { ok: false, error: `HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}` };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      return { ok: false, error: `响应不是合法 JSON：${errorText(error)}` };
    }

    const choices = payload && Array.isArray(payload.choices) ? payload.choices : [];
    if (choices.length === 0) return { ok: false, error: '响应里没有 choices' };
    const content = choices[0] && choices[0].message ? choices[0].message.content : '';
    if (asString(content).trim().length === 0) {
      // 空 content 是旧项目里明确要重试的情况之一
      lastError = '响应 content 为空';
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await wait(Math.min(RETRY_BASE_MS * 1.5 ** attempt, RETRY_MAX_MS));
        continue;
      }
      return { ok: false, error: lastError };
    }
    return { ok: true, content: asString(content) };
  }
  return { ok: false, error: lastError };
}

/** 挑出模型返回的 tasks 数组（容忍裸数组 / 包在别的键里）。 */
export function extractTasks(json) {
  if (Array.isArray(json)) return json;
  if (json !== null && typeof json === 'object') {
    for (const key of ['tasks', 'items', 'data', 'result', 'results']) {
      if (Array.isArray(json[key])) return json[key];
    }
    // 单个任务对象
    if (typeof json.source === 'string' && typeof json.external_id === 'string') return [json];
    const values = Object.values(json);
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
  }
  return [];
}

/**
 * 清洗一条模型返回的任务：不合规就返回 null（调用方保留规则草稿）。
 * 注意：`score` 在这里被丢弃 —— 分数永远由 computeScore 算。
 */
export function sanitizeDraft(raw, allowedKeys, weights) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const key of FORBIDDEN_KEYS) delete raw[key];
  const source = asString(raw.source);
  const externalId = asString(raw.external_id);
  if (source.length === 0 || externalId.length === 0) return null;
  if (!allowedKeys.has(`${source}\u0000${externalId}`)) return null;

  const category = asString(raw.category);
  if (!ALLOWED_CATEGORIES.includes(category)) return null;

  const urgency = Number(raw.urgency);
  const importance = Number(raw.importance);
  if (!Number.isInteger(urgency) || !Number.isInteger(importance)) return null;
  if (urgency < 0 || urgency > 5 || importance < 0 || importance > 5) return null;

  const dueDay = asString(raw.due_at).trim();
  const dueMs = dueDay.length > 0 ? parseDateMs(dueDay) : null;

  const tags = asStringArray(raw.tags).filter((tag) => TAG_WHITELIST.includes(tag)).slice(0, 5);

  return {
    source,
    external_id: externalId,
    category,
    title: truncate(asString(raw.title).trim(), 200),
    summary: truncate(asString(raw.summary), 1200),
    course: truncate(asString(raw.course), 120),
    due_at: dueMs === null ? null : new Date(dueMs).toISOString(),
    urgency,
    importance,
    score: computeScore(urgency, importance, weights),
    is_rule: raw.is_rule === true,
    urgency_reason: truncate(asString(raw.urgency_reason), 200),
    importance_reason: truncate(asString(raw.importance_reason), 200),
    tags,
    ai_scored: true,
  };
}

/**
 * 给一批素材打分。
 *
 * @param {Array<{source: string, external_id: string, change_type: string, course_id: string|null, payload: object}>} items
 * @param {object} ai      规范化后的 ai 配置段
 * @param {{ weights?: object, nowIso?: string, fetchImpl?: Function, sleep?: Function, logger?: object }} [options]
 * @returns {Promise<{ok: boolean, drafts: Map<string, object>, errors: string[], calls: number,
 *                    settled: Set<string>}>}
 *          ok=false 表示**全部批次都失败**（网络/凭据问题），调用方应保留规则草稿并且不写快照；
 *          settled 是"这一轮已经有明确结论"的素材 key（成功批次里的全部素材），
 *          调用方只对 settled 的素材写快照，失败批次下轮重试；
 *          个别条目清洗失败只进 errors，不影响该批已 settled 的判定。
 */
export async function scoreItems(items, ai, options = {}) {
  const weights = options.weights ?? {};
  const logger = options.logger ?? null;
  const nowIso = asString(options.nowIso).length > 0 ? asString(options.nowIso) : utcNowIso();
  const drafts = new Map();
  const settled = new Set();
  const errors = [];
  let calls = 0;

  if (!aiConfigured(ai)) return { ok: false, drafts, errors: ['AI 未启用或配置不完整'], calls, settled };
  if (items.length === 0) return { ok: true, drafts, errors, calls, settled };

  const allowedKeys = new Set(items.map((item) => `${item.source}\u0000${item.external_id}`));
  const batchSize = asInt(ai.batchSize, 15, 1, 50);
  let failedBatches = 0;
  let totalBatches = 0;

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    totalBatches += 1;
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(batch, nowIso) },
    ];
    calls += 1;
    const result = await callChat(ai, messages, options);
    if (!result.ok) {
      // 注意：不整体放弃。旧项目是"整轮作废"，那样一个坏批次会让所有源都卡住。
      failedBatches += 1;
      errors.push(`第 ${Math.floor(start / batchSize) + 1} 批评分失败（该批保留规则分）：${result.error}`);
      if (logger !== null && typeof logger.warn === 'function') {
        logger.warn(`AI 评分失败（第 ${Math.floor(start / batchSize) + 1} 批）：${result.error}`);
      }
      continue;
    }

    // 这一批拿到了明确答复（哪怕内容不合规）：标记 settled，避免下轮反复调用。
    for (const item of batch) settled.add(`${item.source}\u0000${item.external_id}`);

    let parsed = null;
    try {
      parsed = JSON.parse(stripCodeFence(result.content));
    } catch (error) {
      errors.push(`第 ${Math.floor(start / batchSize) + 1} 批返回的不是合法 JSON：${errorText(error)}`);
      continue;
    }

    let accepted = 0;
    for (const raw of extractTasks(parsed)) {
      const draft = sanitizeDraft(raw, allowedKeys, weights);
      if (draft === null) {
        errors.push('丢弃了一条不合规的 AI 结果（缺少字段或取值越界）');
        continue;
      }
      drafts.set(`${draft.source}\u0000${draft.external_id}`, draft);
      accepted += 1;
    }
    if (accepted === 0 && batch.length > 0) {
      errors.push(`第 ${Math.floor(start / batchSize) + 1} 批没有返回可用的任务`);
    }
  }

  const ok = totalBatches > 0 && failedBatches < totalBatches;
  return { ok, drafts, errors, calls, settled };
}

/** AI 连接自检：发一次最小请求（沿用旧项目 setup_config.test_ai 的形状）。绝不抛异常。 */
export async function testAi(ai, options = {}) {
  if (ai === null || typeof ai !== 'object') return { ok: false, message: 'AI 配置缺失' };
  if (asString(ai.baseUrl).length === 0) return { ok: false, message: '未填写 API 地址' };
  if (asString(ai.apiKey).length === 0) return { ok: false, message: '未填写 API Key' };
  if (asString(ai.model).length === 0) return { ok: false, message: '未填写模型名' };

  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : (url, init) => globalThis.fetch(url, init);
  const url = `${asString(ai.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${asString(ai.apiKey)}` },
      body: JSON.stringify({
        model: asString(ai.model),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });
    if (response.status === 401) return { ok: false, message: 'API Key 无效（401）', detail: url };
    if (response.status === 402 || response.status === 403) {
      return { ok: false, message: '余额不足，或当前 Key 没有该模型的权限', detail: url };
    }
    if (response.status === 404) return { ok: false, message: '接口地址或模型名不存在（404）', detail: url };
    if (!response.ok) return { ok: false, message: `AI 接口返回 HTTP ${response.status}`, detail: url };
    return { ok: true, message: `连接成功（模型 ${asString(ai.model)} 可用）`, detail: url };
  } catch (error) {
    return { ok: false, message: `连接失败：${errorText(error)}`, detail: url };
  } finally {
    clearTimeout(timer);
  }
}

/** 暴露给测试/诊断：当前生效的重试参数。 */
export const RETRY_POLICY = { attempts: RETRY_MAX_ATTEMPTS, baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, forbiddenKeys: FORBIDDEN_KEYS };

/** clamp 再导出一份，方便外部（如 pipeline 合并时）复用。 */
export { clamp };
