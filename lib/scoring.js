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
  exam: ['考试', '期末', '期中', '测验', '小测', 'quiz', 'exam', 'examination', 'final', 'midterm', 'test'],
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

/* ------------------------------------------------ 信息型 / 动作型 判定 */

/**
 * 信息型通知（"成绩已发布""解答已上传"）——看过了就没用了，不该占 importance。
 * 只在公告与邮件上生效；作业永远按作业算。
 */
const INFO_PATTERNS = [
  /成绩[^\n]{0,8}(已|已经)?(发布|公布|出来|可查|可查詢|可查询)/,
  /(发布|公布|上传|发放)了?[^\n]{0,8}(成绩|答案|解答|参考|解答|評語|评语)/,
  /grades?[^\n]{0,40}?(have been|has been|are|were|is)\s+(now\s+)?(released|posted|published|available|out)\b/i,
  /(release|post|publish|upload)\w*[^\n]{0,20}grades?\b/i,
  /(solution|answer key|reference answer)s?[^\n]{0,30}?(is|are)\s+(now\s+)?(available|posted|uploaded|in the files)/i,
  /(解答|参考答案|答案)[^\n]{0,10}(已)?(上传|发布|放到|在)/,
  /(已)?批改(完毕|完成)/,
  /no\s+action\s+(is\s+)?(required|needed)\b/i,
  /(仅|只)作为?通知/,
];

/** 活动/讲座/比赛类（"活动"分类）。 */
const EVENT_PATTERNS = [
  /讲座|研討會|研讨会|工作坊|座談會|座谈会|分享会|分享會|宣講|宣讲|论坛|論壇/,
  /\b(seminar|workshop|webinar|lecture|talk|forum|symposium|info(rmation)? session)\b/i,
  /比赛|比賽|球赛|球賽|赛事|賽事|锦标赛|錦標賽|联赛|聯賽|运动会|運動會/,
  /\b(tournament|match|game day|tryout|practice session|training session|orientation|briefing|gathering|event)\b/i,
  /招募|招新|迎新|社团|社團|\brecruit(ment|ing)?\b|\btry-?outs?\b/i,
];

/** 报名/登记类（"提醒"分类，通常带截止）。 */
const SIGNUP_PATTERNS = [
  /报名|報名|登记|登記|註冊|注册|申请参加|申請參加|報名表|报名表|招募|招新/,
  /\b(sign[\s-]?up|signup|register|registration|enrol{1,2}|rsvp|apply|recruit(ment|ing)?)\b/i,
];

/** 报名成功 / 确认（→ 应转成"参加"）。 */
const CONFIRM_PATTERNS = [
  /报名成功|報名成功|注册成功|註冊成功|登记成功|登記成功|报名已确认|報名已確認|确认成功|確認成功|已为您预留|已為您預留|预约成功|預約成功/,
  /registration\s+(is\s+|has\s+been\s+)?(confirmed|complete|successful|received)\b/i,
  /you\s+(are|have been)\s+(now\s+)?(successfully\s+)?registered\b/i,
  /(successfully|successful)\s+registered\b/i,
  /confirm(ed|ation of)?\s+your\s+(registration|enrol{1,2}ment|booking|rsvp)\b/i,
];

/** 系统/安全类通知（跟学业无关，压到最低）。 */
const NOISE_PATTERNS = [
  /安全提醒|安全预警|登录提醒|登入提醒|异地登录|異地登入|新设备登录|验证码|驗證碼/,
  /\b(security alert|new sign-?in|verify your|verification code|one-?time (password|code))\b/i,
  /\b(password|credential)s?\s+(has|have)\s+been\s+(changed|reset)\b/i,
  /退订|取消订阅|\bunsubscribe\b|\bnewsletter\b/i,
];

/** "不计入总成绩"类（没分值的测验/练习不该按考试算重要）。 */
const UNGRADED_PATTERNS = [
  /不计入|不計入|不计分|不計分|不影响总评|不影響總評|不纳入总评|不算分/,
  /\b(not|does\s?n[o']t)\s+(count|counted|included)\b/i,
  /\bnot\s+part\s+of\s+(your\s+)?(final\s+)?grade\b/i,
  /\b(ungraded|no\s+grade|no\s+points|not\s+graded|for\s+practice\s+only|optional)\b/i,
  /\bdoes\s?n[o']t\s+affect\s+your\s+grade\b/i,
];

function matchesPatterns(haystack, patterns) {
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * 按**内容**判定分类与重要度上下限。
 *
 * 背景（用户实测反馈）：分类过去完全由数据来源决定 —— Canvas 公告一律"活动"，
 * 所以「Quiz 3 Grades」（成绩发布通知）也被塞进"活动"；邮件一律"提醒"。
 * 现在改成：来源只决定兜底，内容决定最终分类。
 *
 * @returns {{ category: string|null, ceiling: number|null, floor: number|null, notes: string[] }}
 */
export function classifyByContent(source, haystack) {
  const text = asString(haystack);
  const result = { category: null, ceiling: null, floor: null, notes: [] };
  if (text.length === 0) return result;

  const isConfirm = matchesPatterns(text, CONFIRM_PATTERNS);
  const isEvent = matchesPatterns(text, EVENT_PATTERNS);
  const isSignup = matchesPatterns(text, SIGNUP_PATTERNS);
  const isInfo = matchesPatterns(text, INFO_PATTERNS);
  const isNoise = matchesPatterns(text, NOISE_PATTERNS);

  if (isNoise && !isConfirm) {
    result.category = 'reminder';
    result.ceiling = 1;
    result.notes.push('系统通知（无需动作）');
    return result;
  }

  if (source === 'canvas_announcement') {
    if (isInfo && !isSignup) {
      result.category = 'reminder';
      result.ceiling = 1;
      result.notes.push('信息型公告（无需动作）');
      return result;
    }
    if (isSignup && !isEvent) {
      result.category = 'reminder';
      result.notes.push('报名类通知');
      return result;
    }
    // 其余公告沿用兜底分类（活动）——讲座、比赛、招募都算活动。
    return result;
  }

  if (source === 'mail') {
    if (isConfirm) {
      result.category = 'activity';
      result.floor = 2;
      result.notes.push('报名/登记已确认');
      return result;
    }
    if (isInfo) {
      result.category = 'reminder';
      result.ceiling = 1;
      result.notes.push('信息型邮件（无需动作）');
      return result;
    }
    if (isEvent && isSignup) {
      // 活动/比赛 + 要报名：是活动，但至少要动一下手（报名），不能压到 0。
      result.category = 'activity';
      result.floor = 1;
      result.notes.push('活动类（需报名）');
      return result;
    }
    if (isSignup && !isEvent) {
      result.category = 'reminder';
      result.floor = 1;
      result.notes.push('报名类通知');
      return result;
    }
    if (isEvent) {
      result.category = 'activity';
      return result;
    }
    return result;
  }

  return result;
}

/** 这条素材是不是"报名成功/确认"邮件（管线据此把旧的报名提醒改成参加提醒）。 */
export function isRegistrationConfirmation(text) {
  const value = asString(text);
  return value.length > 0 && matchesPatterns(value, CONFIRM_PATTERNS);
}

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

/** 邮件头行（转发头里的"发送时间"曾经被当成截止时间 —— 用户实测踩到的 bug）。 */
const MAIL_HEADER_RE =
  /^\s*(发件人|發件人|发送时间|發送時間|发送日期|收件人|收件者|抄送|密送|主题|主題|日期|时间|時間|from|sent|to|cc|bcc|subject|date|reply-?to|importance)\s*[:：]/i;
/** "在 … 写道：" / "On … wrote:" 这类引用引导行。 */
const QUOTE_LEAD_RE = /^\s*(在.{0,60}(写道|寫道)|on\s.{0,80}\bwrote)\s*[:：]?\s*$/i;
/** 分隔线（转发/原始邮件分隔）。 */
const QUOTE_SEPARATOR_RE = /^\s*(-{3,}|_{3,}|={3,}|\*{3,})\s*(原始邮件|原始郵件|转发邮件|轉發郵件|original message|forwarded message)?\s*(-{0,}|_{0,})?\s*$/i;
/** 签名块起始。 */
const SIGNATURE_RE = /^\s*(--\s*$|此致|敬礼|敬禮|best regards|kind regards|regards,|sent from my|发自我的)/i;

/**
 * 剥掉转发头、引用行与签名块，只留下**本次邮件真正的内容**。
 *
 * 为什么需要它：`extractDueDate` 曾经在"找不到截止词"时退回"第一个像日期的字符串"，
 * 于是 `转发: [HALL 10] ICFD BASKETBALL RECRUITMENT` 里转发头的
 * 「发送时间: 2026年9月25日 6:11」被当成了截止时间 —— 一封今天刚收到的邮件
 * 立刻显示"已逾期"。头部行本来就不该参与任何时间/关键词判定。
 */
export function stripQuotedText(value) {
  const raw = asString(value);
  if (raw.length === 0) return '';
  const lines = raw.split(/\r?\n/);
  const kept = [];
  let stopped = false;
  for (const line of lines) {
    // 引用块（`>` 开头）之后的整段都算历史内容
    if (/^\s*>/.test(line)) {
      stopped = true;
      continue;
    }
    if (QUOTE_SEPARATOR_RE.test(line) || QUOTE_LEAD_RE.test(line)) {
      stopped = true;
      continue;
    }
    if (SIGNATURE_RE.test(line)) {
      stopped = true;
      continue;
    }
    if (stopped) continue;
    if (MAIL_HEADER_RE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 关键词匹配。
 *
 * 真机教训：老的 `text.includes(word)` 让奖学金公告里的
 * "HKDSE English Language Exam - Level 4"、"English tests"、"non-final year undergraduates"
 * 全部命中 exam 关键词，于是一封"申请须知"被当成考试抬到 importance 4。
 * 现在纯 ASCII 单词按**词边界**匹配（`latest` 不再命中 `test`、`non-final` 不再命中 `final`），
 * 中文关键词仍用子串匹配。
 */
const WORD_RE_CACHE = new Map();

function isSingleAsciiWord(word) {
  return /^[a-z][a-z0-9'-]*$/.test(word);
}

function wordRegex(word) {
  let compiled = WORD_RE_CACHE.get(word);
  if (compiled === undefined) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 允许常见的屈折后缀（tests / chapters / released），边界里把连字符也算作词内字符，
    // 这样 "non-final" 不会命中 "final"、"try-outs" 不会命中 "outs"。
    compiled = new RegExp(`(?<![a-z0-9-])${escaped}(?:s|es|ing|ed)?(?![a-z0-9-])`, 'i');
    WORD_RE_CACHE.set(word, compiled);
  }
  return compiled;
}

export function matchesAny(haystack, words) {
  const text = asString(haystack);
  if (text.length === 0) return false;
  return words.some((raw) => {
    const word = asString(raw).toLowerCase();
    if (word.length === 0) return false;
    if (isSingleAsciiWord(word)) return wordRegex(word).test(text);
    return text.toLowerCase().includes(word);
  });
}

/* ------------------------------------------------- 考试类证据（防误判） */

/** 中文考试词：命中即算。 */
const EXAM_CJK = ['考试', '期末', '期中', '测验', '小测'];
/** 英文里歧义很小的考试词：命中即算。 */
const EXAM_SAFE = ['quiz', 'midterm', 'examination'];
/** 歧义大的词："exam/test" 可能出现在申请资格里；`final` 多数时候指"最后一年"。 */
const EXAM_CONTEXTUAL = ['exam', 'test'];
const EXAM_PLAIN = ['exam', 'test', 'finals'];

/** 申请资格/入学要求语境：这里的 exam/test 说的不是"我要考的试"。 */
const ELIGIBILITY_CONTEXT_RE = /\b(eligib\w*|criteria|criterion|requirements?|required|qualifications?|admission|applicants?|candidates?|hkds[ei]|toefl|ielts|jupas|gpa|public\s+exams?|certificates?|proficiency|at\s+least|level\s+\d)\b/i;

/** `final` 只有和这些词连用才算考试（final exam / final project …）；"final grade" 说的是成绩，不算。 */
const EXAM_COLLOCATION_RE = /\bfinal\s+(exam|test|quiz|paper|project|report|presentation|assessment)\b/i;

/**
 * 这条素材是不是"考试/测验"类。
 *
 * 标题里命中即算（标题基本没有资格语境的噪音）；正文里逐句判断，落在
 * "申请资格/入学要求"句子里的 exam/test 一律不算，单独的 final 也只在
 * `final exam/project/...` 搭配里才算。
 *
 * @returns {{ hit: boolean, where: 'title'|'body'|'' }}
 */
export function examEvidence(title, body) {
  const head = asString(title);
  if (matchesAny(head, EXAM_CJK) || matchesAny(head, EXAM_SAFE) || matchesAny(head, EXAM_PLAIN)) {
    return { hit: true, where: 'title' };
  }
  if (EXAM_COLLOCATION_RE.test(head) || /考试|测验|期末|期中/.test(head)) return { hit: true, where: 'title' };

  const bodyText = asString(body);
  if (bodyText.length === 0) return { hit: false, where: '' };
  for (const rawLine of bodyText.split(/[\n。；;!?]+|\.\s+/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (matchesAny(line, EXAM_CJK) || matchesAny(line, EXAM_SAFE)) return { hit: true, where: 'body' };
    const contextual = matchesAny(line, EXAM_CONTEXTUAL) || EXAM_COLLOCATION_RE.test(line);
    if (contextual && !ELIGIBILITY_CONTEXT_RE.test(line)) return { hit: true, where: 'body' };
  }
  return { hit: false, where: '' };
}

/* ----------------------------------------------------------- 截止时间 */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * 从自由文本里推断时间，并区分**截止时间**与**活动时间**。
 *
 * 三种结果（due_kind）：
 *   - `'deadline'`：日期紧邻"截止/due/deadline/提交"这类词（60 字以内）→ 可以显示"已逾期"；
 *   - `'event'`：只有一个像日期的字符串（讲座时间、比赛日期、转发头里的发送时间……）
 *     → 只当"活动时间"，**永远不算逾期**（用户实测的篮球招募邮件就是这一类）；
 *   - `''`：什么都没有 → due_at = null。
 *
 * 两个防呆（都来自实测 bug）：
 *   - `options.notBeforeMs`（邮件收信时间 / 公告发布时间）：早于它 12 小时以上的日期一律丢弃，
 *     引用历史里的旧日期不该变成"已截止"；
 *   - 调用方应先用 stripQuotedText 剥掉转发头（转发头里的"发送时间"曾直接被当成截止时间）。
 *
 * 只给日期不给时间按当天 23:59 处理；年份缺失时取"最接近未来的那一年"。
 */
export function analyzeDueDate(text, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const notBeforeMs = Number.isFinite(options.notBeforeMs) ? options.notBeforeMs : null;
  const empty = { due_at: null, due_kind: '', basis: 'none', dropped: false };
  const source = asString(text);
  if (source.length === 0) return empty;
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

  if (candidates.length === 0) return empty;

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
  if (valid.length === 0) return empty;

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

  /** 收口：把候选变成结果，并施加"不得早于收信时间"的防呆。 */
  const pick = (candidate, basis) => {
    if (notBeforeMs !== null && candidate.ms < notBeforeMs - 12 * 3_600_000) {
      return { ...empty, dropped: true };
    }
    return {
      due_at: new Date(candidate.ms).toISOString(),
      due_kind: basis === 'marker' ? 'deadline' : 'event',
      basis,
      dropped: false,
    };
  };

  // 一个截止词都没有 → 退回"第一个像日期的"，但只当**活动时间**（不算逾期）
  if (!Number.isFinite(marked[0].distance)) {
    const first = [...valid].sort((a, b) => a.index - b.index)[0];
    return pick(first, 'first');
  }
  return pick(marked[0], 'marker');
}

/** 兼容旧调用：只要截止时间字符串（不区分 kind）。 */
export function extractDueDate(text, nowMs = Date.now()) {
  return analyzeDueDate(text, { nowMs }).due_at;
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
 *
 * 判定顺序（三条修正来自用户实测反馈）：
 *   1. 时间：先剥转发头/引用（stripQuotedText），只把"紧邻截止词"的日期当 deadline，
 *      其余像日期的当 event（显示活动时间，**不算逾期**）；
 *   2. 分类：来源只做兜底，内容说了算（classifyByContent）——
 *      成绩发布类公告是"提醒"而不是"活动"；
 *   3. 重要度：不计入总成绩 / 没分值的测验练习压到 1，不再套"看到 exam 就给 4"。
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
  let dueKind = '';
  let dueBasis = 'none';
  let dueDropped = false;
  let points = null;
  let submissionTypes = [];
  let gradingType = '';
  let notGraded = false;
  let explicitNotGraded = false;
  let zeroPoints = false;

  if (source === 'canvas_assignment') {
    category = 'assignment';
    title = asString(payload.name).trim();
    summary = stripHtml(payload.description);
    // 作业的截止时间是 Canvas 的结构化字段，权威，不做文本推断。
    dueAt = asString(payload.due_at).trim() || null;
    if (dueAt !== null) {
      dueKind = 'deadline';
      dueBasis = 'field';
    }
    points = payload.points_possible === null || payload.points_possible === undefined ? null : Number(payload.points_possible);
    submissionTypes = asStringArray(payload.submission_types);
    gradingType = asString(payload.grading_type);
    // 「显式标明不计入总成绩」与「只是 0 分」是两回事：后者要等拿到关键词
    // 才知道该不该降权（0 分的奖学金申请往往正是硬性要求），所以延到下面再定。
    explicitNotGraded = payload.omit_from_final_grade === true || gradingType === 'not_graded';
    zeroPoints = Number.isFinite(points) && points === 0;
  } else if (source === 'canvas_announcement') {
    category = 'activity';
    title = asString(payload.title).trim();
    summary = stripHtml(payload.message);
    const analyzed = analyzeDueDate(stripQuotedText(`${title}\n${summary}`), {
      nowMs,
      notBeforeMs: parseDateMs(payload.posted_at),
    });
    dueAt = analyzed.due_at;
    dueKind = analyzed.due_kind;
    dueBasis = analyzed.basis;
    dueDropped = analyzed.dropped;
  } else if (source === 'mail') {
    category = 'reminder';
    title = asString(payload.subject).trim();
    // 正文（bodyPreview）通常是转发头 + 原正文：先剥头，再找时间。
    const body = stripQuotedText(stripHtml(payload.bodyPreview));
    summary = body;
    const analyzed = analyzeDueDate(`${title}\n${body}`, {
      nowMs,
      notBeforeMs: parseDateMs(payload.receivedDateTime),
    });
    dueAt = analyzed.due_at;
    dueKind = analyzed.due_kind;
    dueBasis = analyzed.basis;
    dueDropped = analyzed.dropped;
  } else {
    title = asString(payload.title ?? payload.name ?? payload.subject).trim();
    summary = stripHtml(payload.summary ?? payload.message ?? payload.description ?? payload.bodyPreview);
  }

  if (title.length === 0) title = asString(item?.external_id);
  const haystack = `${title}\n${summary}`;
  const hardGateHit = matchesAny(haystack, KEYWORDS.hardGate);
  // 文本证据也算"不计入总成绩"（用户实测：WebWork 作业正文里就写着 "Not counted in the final grade"）。
  // 但硬性要求（必修/门槛）里的这类措辞不降权，避免把必做项压掉。
  const textNotGraded = !hardGateHit && matchesPatterns(haystack, UNGRADED_PATTERNS);
  const fieldNotGraded = explicitNotGraded;
  explicitNotGraded = explicitNotGraded || textNotGraded;
  // 「0 分」不等于「不计入总成绩」：奖学金/申请/必修类 0 分作业往往正是硬性要求，
  // 这类仍按硬性门槛计。只有显式标记，或既无分值又不构成硬性要求的条目才降权。
  notGraded = explicitNotGraded || (zeroPoints && !hardGateHit);
  const exam = examEvidence(title, summary);
  // 标签同样按证据给：没有考试证据时不许挂 exam 标签（老代码会把 "non-final year" 算成考试）。
  const tags = tagListOf(haystack).filter((tag) => tag !== 'exam' || exam.hit);
  const isRule = source !== 'canvas_assignment' && matchesAny(haystack, KEYWORDS.rule);
  const importanceNotes = [];
  // 被内容判定降过级的证据（见下方 lock_* 三兄弟的说明）
  let importanceBeforeCap = null;

  // 内容决定分类（来源只兜底）：成绩发布 → 提醒；讲座/比赛/招募 → 活动。
  // 说明文字统一在 important 计算完之后再拼（见下方 content.notes 的处理）。
  const content = classifyByContent(source, haystack);
  if (content.category !== null && source !== 'canvas_assignment') category = content.category;

  // importance：分值 + 关键词
  let importance = category === 'assignment' ? 2 : category === 'activity' ? 0 : 1;
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
  if (tags.length > 0 && content.ceiling !== null && content.ceiling <= 1) {
    // 信息型/系统通知不该再挂着 exam、paper 这类"要动手"的标签。
    tags.length = 0;
  }
  if (matchesAny(haystack, KEYWORDS.hardGate) && !notGraded) {
    importance = 5;
    importanceNotes.unshift('硬性要求');
  }
  // "测验"这两个字不再自动等于重要：只有真的构成考试/测验（examEvidence）才抬分，
  // 不计入总成绩的练习测验压到 1。
  if (exam.hit && !notGraded) {
    importance = Math.max(importance, 4);
    importanceNotes.push(exam.where === 'title' ? '考试/测验类' : '正文提到考试/测验');
  }
  if (notGraded) {
    importance = Math.min(importance, 1);
    importanceNotes.push(
      fieldNotGraded ? '不计入总成绩' : textNotGraded ? '素材里写明不计入总成绩' : '无分值（0 分且非硬性要求）',
    );
  } else if (matchesAny(haystack, KEYWORDS.paper) || matchesAny(haystack, KEYWORDS.project)) {
    importance += 1;
    importanceNotes.push('论文/项目类');
  }
  if (isRule && !notGraded) {
    importance = Math.max(importance, 3);
    importanceNotes.push('规则/政策类通知');
  }
  if (matchesAny(haystack, KEYWORDS.reading) && importance < 1) {
    importance = 1;
    importanceNotes.push('阅读类');
  }
  if (content.ceiling !== null && content.ceiling < importance) {
    // 内容明确是"信息型/系统通知"：把之前按关键词堆上去的高分理由一并丢掉，
    // 免得出现"成绩已发布"却写着"考试/测验类"这种自相矛盾的说明。
    importanceBeforeCap = importance;
    importance = content.ceiling;
    importanceNotes.length = 0;
  }
  if (content.floor !== null) importance = Math.max(importance, content.floor);
  importance = clamp(importance, 0, 5);

  // 内容判定是"素材里的事实"，不许 AI 推翻（真机实测：规则把成绩发布类公告压成"提醒/1"，
  // 模型看到标题里的 Quiz 又把它抬回"活动/重要 4"）。只在规则**确实按内容降过级**时才上锁，
  // 而且锁的是上限——AI 还能继续往下调，但不能抬回去。
  const contentCapped = content.ceiling !== null && content.ceiling < importanceBeforeCap;
  const lockImportance = notGraded ? 1 : contentCapped ? importance : null;

  for (const note of content.notes) importanceNotes.push(note);

  if (submissionTypes.length > 0) {
    const labels = submissionTypes.map((type) => SUBMISSION_TYPE_LABEL[type] ?? type).join('、');
    importanceNotes.push(`提交方式：${labels}`);
  }

  const dueMs = parseDateMs(dueAt);
  let { urgency, reason: urgencyReason } = urgencyFromDue(dueMs, nowMs);
  if (dueKind === 'event') {
    // 活动/讲座的举行时间不是截止时间：过去就过去，未来也不是"紧急"。
    if (dueMs !== null && dueMs < nowMs) {
      urgency = 0;
      urgencyReason = '活动时间已过（不是截止时间）';
    } else {
      urgency = Math.min(urgency, 2);
      urgencyReason = '活动时间（非截止时间）';
    }
  }
  if (dueDropped) {
    urgency = 0;
    urgencyReason = '素材里的日期早于收信/发布时间，已忽略';
  }

  const notes = importanceNotes.filter((note) => asString(note).length > 0);

  return {
    source,
    external_id: asString(item?.external_id),
    course_id: item?.course_id ?? null,
    category,
    title,
    summary: truncate(summary, 1200),
    course,
    due_at: dueMs === null ? null : new Date(dueMs).toISOString(),
    due_kind: dueMs === null ? '' : dueKind,
    urgency,
    importance,
    score: computeScore(urgency, importance, weights),
    is_rule: isRule,
    urgency_reason: urgencyReason,
    importance_reason: notes.length > 0 ? notes.join('；') : '普通任务',
    tags,
    // `lock_*` 是给 `mergeDraft` 看的（不落库，`upsertTask` 只写它认识的列）：
    // 内容识别出的分类、以及被内容降级后的重要度上限，AI 不许推翻。
    lock_category: content.category !== null && source !== 'canvas_assignment' ? category : null,
    lock_importance: lockImportance,
    lock_tags: lockImportance === null ? null : [...tags],
    raw_json: JSON.stringify({ source, external_id: item?.external_id, payload }, null, 0),
  };
}

/* --------------------------------------------------------------- 排序 */

/**
 * 面板排序规则（用户明确要求）：**先按时间先后，时间排完的再按重要程度**。
 *   - 有截止时间：升序（最紧急/逾期最久的在最前）；同一时间按 importance、urgency、id。
 *   - 无截止时间：排在所有有时间之后，按 importance、urgency、score、id 降序。
 *   - `due_kind === 'event'`（活动/讲座举行时间）**已经过去**的也归到后面那组：
 *     活动时间不是截止，否则一场已经结束的球赛会永远钉在列表最顶上；
 *     还没到时间的活动仍按时间排（明天有讲座就该排在两周后的作业前面）。
 * 纯函数，不改动入参（除了用当前时间判断"活动是否已过去"，这个判断本身与入参无关）。
 */
export function sortTasks(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const dated = [];
  const undated = [];
  const now = Date.now();
  for (const task of list) {
    const dueMs = parseDateMs(task?.due_at);
    const event = asString(task?.due_kind) === 'event';
    if (dueMs === null || (event && dueMs < now)) undated.push(task);
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
