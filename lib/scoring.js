/**
 * 评分与排序（宿主半区唯一的"打分"实现）。
 *
 * 与旧 Python 项目的差异（我方的改进，已在交付说明里写明）：
 *   - 旧项目**没有规则打分**，urgency/importance 完全来自 LLM，没有 key 就一条任务都不出；
 *   - 这里是"规则优先、AI 可选增强"：规则按 Canvas 自带的截止时间/分值/关键词给分，
 *     配了 AI 时再用 LLM 结果覆盖（见 llm.js）。因此没配 key 也能用。
 *
 * 分数公式与旧项目一致：score = clamp(urgency*Wu + importance*Wi, 0, 100)，
 * 默认 Wu=10、Wi=8（(5,3)=74、(5,5)=90 两个锚点保持不变）。
 */
import { asInt, asString, asStringArray, clamp, parseDateMs, truncate } from './util.js';

/** UI 判定"紧急/重要"的阈值（客户端半区用的是同一组数字）。 */
export const HIGH_URGENCY = 4;
export const HIGH_IMPORTANCE = 4;

/** 标签白名单（沿用旧项目的 allow_tags）。 */
export const TAG_WHITELIST = ['exam', 'paper', 'project', 'quiz', 'discussion', 'rule', 'deadline_change', 'group', 'reading', 'admin'];

const KEYWORDS = {
  exam: ['考试', '期末', '期中', '测验', '小测', 'quiz', 'exam', 'final', 'midterm', 'test'],
  paper: ['论文', '报告', '写作', 'essay', 'paper', 'report', 'thesis'],
  project: ['项目', '大作业', '课程设计', '实验', 'project', 'assignment sheet', 'coursework'],
  group: ['小组', '团队', '组队', 'group', 'team'],
  discussion: ['讨论', '论坛', '发帖', '回帖', 'discussion', 'forum', 'post'],
  reading: ['阅读', '预习', '章节', 'reading', 'read chapter', 'chapter'],
  admin: ['注册', '选课', '缴费', '报名', 'enroll', 'registration', 'tuition', 'admin'],
  rule: ['规则', '政策', '规定', '须知', '学术诚信', '诚信', '大纲', 'policy', 'syllabus', 'plagiarism', 'academic integrity'],
  deadline_change: ['改期', '延期', '截止时间变更', 'deadline change', 'extension', 'rescheduled', 'postponed'],
  hardGate: ['必修', '必须完成', '硬性', '门槛', '不通过', '不及格', '挂科', 'mandatory', 'required', 'must pass', 'gate'],
};

/** 截止时间关键词：出现在这些词附近的时间才当成"截止时间"。 */
const DUE_MARKERS = ['截止', '截止时间', '到期', '交', '提交', '前完成', 'ddl', 'due', 'deadline', 'by ', 'before ', 'no later than'];

const SUBMISSION_TYPE_LABEL = {
  online_quiz: '测验',
  online_text_entry: '文字提交',
  online_upload: '上传文件',
  online_url: '提交链接',
  discussion_topic: '讨论',
  media_recording: '录制',
  external_tool: '外部工具',
  none: '无需提交',
  on_paper: '纸质提交',
};

/* --------------------------------------------------------------- 文本 */

/** 去 HTML 标签（与旧项目一致：不解 HTML 实体，只把 &nbsp; 当空格）。 */
export function stripHtml(value) {
  return asString(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function matchesAny(haystack, words) {
  const text = haystack.toLowerCase();
  return words.some((word) => text.includes(word.toLowerCase()));
}

/* ----------------------------------------------------------- 截止时间 */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * 从自由文本里推断截止时间（公告与邮件没有结构化 due 字段时使用）。
 *
 * 顺序：优先取"截止/due/deadline"这类关键词附近的日期；找不到就取第一个像日期的；
 * 完全没有 → null（调用方保留 due_at 为空，排序时归到"无时间"那一组）。
 * 只给日期不给时间时按当天 23:59 处理；年份缺失时取"最接近未来的那一年"。
 */
export function extractDueDate(text, nowMs = Date.now()) {
  const source = asString(text);
  if (source.length === 0) return null;
  const candidates = [];
  const push = (index, year, month, day, hour = 23, minute = 59) => {
    candidates.push({ index, year, month, day, hour, minute });
  };

  // 1) 2026-09-30 / 2026/09/30（可带时间）
  const isoRe = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/g;
  for (let m = isoRe.exec(source); m !== null; m = isoRe.exec(source)) {
    push(m.index, Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] === undefined ? 23 : Number(m[4]), m[5] === undefined ? 59 : Number(m[5]));
  }

  // 2) 9月30日 / 9月30号（可带时间）
  const cnRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号](?:\s*(\d{1,2})[:：](\d{2}))?/g;
  for (let m = cnRe.exec(source); m !== null; m = cnRe.exec(source)) {
    push(m.index, null, Number(m[1]) - 1, Number(m[2]), m[3] === undefined ? 23 : Number(m[3]), m[4] === undefined ? 59 : Number(m[4]));
  }

  // 3) Sep 30 / September 30, 2026 / 30 Sep 2026
  const enRe = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?|\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s*(\d{4}))?/g;
  for (let m = enRe.exec(source); m !== null; m = enRe.exec(source)) {
    const monthName = (m[1] ?? m[5] ?? '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MONTHS, monthName)) continue;
    const day = Number(m[2] ?? m[4]);
    const year = m[3] ?? m[6] ?? null;
    push(m.index, year === null ? null : Number(year), MONTHS[monthName], day);
  }

  if (candidates.length === 0) return null;

  const now = new Date(nowMs);
  const pickYear = (year, month, day) => {
    if (year !== null && year !== undefined) return year;
    const thisYear = now.getUTCFullYear();
    const trial = Date.UTC(thisYear, month, day, 23, 59);
    // 已经过去 45 天以上 → 认为说的是明年
    return trial < nowMs - 45 * 86_400_000 ? thisYear + 1 : thisYear;
  };

  const materialize = (candidate) => {
    const year = pickYear(candidate.year, candidate.month, candidate.day);
    return {
      ms: Date.UTC(year, candidate.month, candidate.day, candidate.hour, candidate.minute),
      index: candidate.index,
      valid: candidate.month >= 0 && candidate.month <= 11 && candidate.day >= 1 && candidate.day <= 31,
    };
  };

  const lower = source.toLowerCase();
  const valid = candidates.map(materialize).filter((item) => item.valid);
  if (valid.length === 0) return null;

  // 关键词出现的位置：取"离得最近的截止词"，而不是"前后 40 字里出现过截止词"——
  // 后者会让「发布于 2026-09-01，截止 2026-09-30」里的发布日也拿满分，然后因为位置靠前被选中。
  const markerPositions = [];
  for (const marker of DUE_MARKERS) {
    for (let at = lower.indexOf(marker); at !== -1; at = lower.indexOf(marker, at + 1)) markerPositions.push(at);
  }
  const distanceToMarker = (index) => {
    let best = Number.POSITIVE_INFINITY;
    for (const position of markerPositions) {
      const distance = Math.abs(position - index);
      if (distance < best) best = distance;
    }
    return best <= 60 ? best : Number.POSITIVE_INFINITY;
  };

  const marked = valid
    .map((item) => ({ ...item, distance: distanceToMarker(item.index) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);

  // 一个截止词都没有 → 退回"第一个像日期的"
  if (!Number.isFinite(marked[0].distance)) {
    const first = [...valid].sort((a, b) => a.index - b.index)[0];
    return new Date(first.ms).toISOString();
  }
  return new Date(marked[0].ms).toISOString();
}

/* --------------------------------------------------------------- 打分 */

export function computeScore(urgency, importance, weights = {}) {
  const wu = asInt(weights.urgencyWeight, 10, 0, 100);
  const wi = asInt(weights.importanceWeight, 8, 0, 100);
  return clamp(asInt(urgency, 0, 0, 5) * wu + asInt(importance, 0, 0, 5) * wi, 0, 100);
}

/** 按旧项目的锚点表把"距离截止还有多久"换算成 urgency 0–5。 */
export function urgencyFromDue(dueMs, nowMs) {
  if (dueMs === null) return { urgency: 0, reason: '没有明确截止时间' };
  const deltaDays = (dueMs - nowMs) / 86_400_000;
  if (deltaDays < 0) {
    const days = Math.max(1, Math.round(-deltaDays));
    return { urgency: 5, reason: `已逾期 ${days} 天` };
  }
  if (deltaDays <= 1) {
    const hours = Math.max(1, Math.round(deltaDays * 24));
    return deltaDays === 0 ? { urgency: 5, reason: '今天截止' } : { urgency: 4, reason: `${hours} 小时内截止` };
  }
  if (deltaDays <= 3) return { urgency: 3, reason: `${Math.ceil(deltaDays)} 天内截止` };
  if (deltaDays <= 7) return { urgency: 2, reason: `${Math.ceil(deltaDays)} 天内截止` };
  if (deltaDays <= 14) return { urgency: 1, reason: `${Math.ceil(deltaDays)} 天内截止` };
  return { urgency: 0, reason: '截止时间还很远（14 天以上）' };
}

function tagListOf(text) {
  const tags = [];
  for (const tag of TAG_WHITELIST) {
    const words = KEYWORDS[tag];
    if (words === undefined) continue;
    if (matchesAny(text, words)) tags.push(tag);
  }
  return tags.slice(0, 5);
}

/**
 * 规则打分：把一个 RawItem 变成"任务草稿"。
 * 返回对象里没有 status（status 归用户），也没有 raw_json（由管线补）。
 */
export function ruleAssess(item, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const weights = options.weights ?? {};
  const payload = item?.payload !== null && typeof item?.payload === 'object' ? item.payload : {};
  const source = asString(item?.source);

  let category = 'assignment';
  let title = '';
  let summary = '';
  let course = asString(payload.course_name);
  let dueAt = null;
  let points = null;
  let submissionTypes = [];

  if (source === 'canvas_assignment') {
    category = 'assignment';
    title = asString(payload.name).trim();
    summary = stripHtml(payload.description);
    dueAt = asString(payload.due_at).trim() || null;
    points = payload.points_possible === null || payload.points_possible === undefined ? null : Number(payload.points_possible);
    submissionTypes = asStringArray(payload.submission_types);
  } else if (source === 'canvas_announcement') {
    category = 'activity';
    title = asString(payload.title).trim();
    summary = stripHtml(payload.message);
    // 公告没有 due 字段：从正文里找"截止/due"附近的日期。
    dueAt = extractDueDate(`${title}\n${summary}`, nowMs);
  } else if (source === 'mail') {
    category = 'reminder';
    title = asString(payload.subject).trim();
    summary = stripHtml(payload.bodyPreview);
    dueAt = extractDueDate(`${title}\n${summary}`, nowMs);
  } else {
    title = asString(payload.title ?? payload.name ?? payload.subject).trim();
    summary = stripHtml(payload.summary ?? payload.message ?? payload.description ?? payload.bodyPreview);
  }

  if (title.length === 0) title = asString(item?.external_id);
  const haystack = `${title}\n${summary}`;
  const tags = tagListOf(haystack);
  const isRule = source !== 'canvas_assignment' && matchesAny(haystack, KEYWORDS.rule);

  // importance：分值 + 关键词
  let importance = category === 'assignment' ? 2 : category === 'activity' ? 0 : 1;
  const importanceNotes = [];
  if (Number.isFinite(points) && points !== null) {
    if (points >= 100) {
      importance += 2;
      importanceNotes.push(`${points} 分`);
    } else if (points >= 50) {
      importance += 1;
      importanceNotes.push(`${points} 分`);
    } else if (points >= 20) {
      importanceNotes.push(`${points} 分`);
    }
  }
  if (matchesAny(haystack, KEYWORDS.hardGate)) {
    importance = 5;
    importanceNotes.unshift('硬性要求');
  }
  if (matchesAny(haystack, KEYWORDS.exam)) {
    importance = Math.max(importance, 4);
    importanceNotes.push('考试/测验类');
  }
  if (matchesAny(haystack, KEYWORDS.paper) || matchesAny(haystack, KEYWORDS.project)) {
    importance += 1;
    importanceNotes.push('论文/项目类');
  }
  if (isRule) {
    importance = Math.max(importance, 3);
    importanceNotes.push('规则/政策类通知');
  }
  if (matchesAny(haystack, KEYWORDS.reading) && importance < 1) {
    importance = 1;
    importanceNotes.push('阅读类');
  }
  importance = clamp(importance, 0, 5);

  if (submissionTypes.length > 0) {
    const labels = submissionTypes.map((type) => SUBMISSION_TYPE_LABEL[type] ?? type).join('、');
    importanceNotes.push(`提交方式：${labels}`);
  }

  const dueMs = parseDateMs(dueAt);
  const { urgency, reason: urgencyReason } = urgencyFromDue(dueMs, nowMs);

  return {
    source,
    external_id: asString(item?.external_id),
    course_id: item?.course_id ?? null,
    category,
    title,
    summary: truncate(summary, 1200),
    course,
    due_at: dueMs === null ? null : new Date(dueMs).toISOString(),
    urgency,
    importance,
    score: computeScore(urgency, importance, weights),
    is_rule: isRule,
    urgency_reason: urgencyReason,
    importance_reason: importanceNotes.length > 0 ? importanceNotes.join('；') : '普通任务',
    tags,
    raw_json: JSON.stringify({ source, external_id: item?.external_id, payload }, null, 0),
  };
}

/* --------------------------------------------------------------- 排序 */

/**
 * 面板排序规则（用户明确要求）：**先按时间先后，时间排完的再按重要程度**。
 *   - 有截止时间：升序（最紧急/逾期最久的在最前）；同一时间按 importance、urgency、id。
 *   - 无截止时间：排在所有有时间之后，按 importance、urgency、score、id 降序。
 * 纯函数，不改动入参。
 */
export function sortTasks(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const dated = [];
  const undated = [];
  for (const task of list) {
    if (parseDateMs(task?.due_at) === null) undated.push(task);
    else dated.push(task);
  }
  const byImportance = (a, b) =>
    asInt(b?.importance, 0, 0, 5) - asInt(a?.importance, 0, 0, 5) ||
    asInt(b?.urgency, 0, 0, 5) - asInt(a?.urgency, 0, 0, 5) ||
    asInt(b?.score, 0, 0, 100) - asInt(a?.score, 0, 0, 100) ||
    asInt(a?.id, 0) - asInt(b?.id, 0);
  dated.sort((a, b) => (parseDateMs(a.due_at) ?? 0) - (parseDateMs(b.due_at) ?? 0) || byImportance(a, b));
  undated.sort(byImportance);
  return [...dated, ...undated];
}
