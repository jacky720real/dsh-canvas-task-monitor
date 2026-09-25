/**
 * 离线 fixture：node test/mail-check.mjs（在插件目录下运行）。
 *
 * 零依赖、不碰网络：
 * - Graph 侧注入 fetchImpl；
 * - IMAP 侧注入 connect，用假 socket 回放一段录音（greeting / LOGIN / SELECT /
 *   SEARCH / FETCH 字面量 / LOGOUT），并把回复切成小块逐块投放，
 *   以验证跨块缓冲与字面量字节精确消费；
 * - 同进程内把 globalThis.fetch 与 tls.connect 换成会抛错的绊线，再在注入实现的
 *   前提下跑通全流程，末尾断言绊线一次都没被触发（trips.length === 0），
 *   以此证明模块不会偷偷走真实网络连接。
 *   （原先是另起子进程 test/offline-child.mjs 做这件事，但 DSH 沙箱禁止管道式
 *   spawnSync，子进程 stdout 恒为空，反而制造了假绿，故改为进程内绊线。）
 *
 * 录音里的字面量长度（{274} / {27}）是数出来的真实字节数：
 * 字面量之后多一个字节、少一个字节都会让协议错位，所以不能随手改字符串。
 */

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import tls from 'node:tls';

import {
  SOURCE_MAIL,
  fetchMail,
  mailConfigured,
  mailMissingFields,
  testMail,
  parseImapResponse,
  parseHeaderParams,
  parseMimeMessage,
  decodeHeaderValue,
  normalizeDate,
  stripHtml,
} from '../lib/mail.js';

// ---------------------------------------------------------------------------
// 断言小工具
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`ok   - ${name}`);
  } else {
    failed += 1;
    const detail = extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`;
    failures.push(`${name}${detail}`);
    console.log(`FAIL - ${name}${detail}`);
  }
}

function equal(actual, expected, name) {
  check(name, actual === expected, { actual, expected });
}

// ---------------------------------------------------------------------------
// IMAP 录音（字节精确）
// ---------------------------------------------------------------------------

/**
 * 录音的字节账本：本文件里所有 `{n}` 都由下面的常量算出，绝不手写。
 * 一封邮件 = 一个字面量，字面量内容 = 整封邮件（MIME 头 + 空行 + 分体正文）——
 * 这才是真实的 `BODY[]`；只把「头」当字面量会让解析器吃错字节数。
 * 录音刻意做成纯 ASCII（中文只出现在 encoded-word 与 base64 里），
 * 于是 socket 用 latin1 读、字节数用 utf8 算，两边必然一致（末尾有断言兜底）。
 */
const MESSAGE_1_HEADERS = 'Message-ID: <WEEKLY-1@school.example.edu>\r\n'
  + 'Subject: =?UTF-8?B?5L2c5Lia5oiq5q2i5pe26Ze05o+Q6YaS?=\r\n'
  + 'From: =?UTF-8?B?5p2O6ICB5biI?= <teacher@school.example.edu>\r\n'
  + 'Date: Wed, 07 Jan 2026 08:30:00 +0800\r\n'
  + 'Content-Type: multipart/alternative; boundary="b1"\r\n'
  + '\r\n';

/** 第一封：multipart/alternative，plain 用 base64，html 只是退路（不会被选中）。 */
const MESSAGE_1_BODY = [
  '--b1',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  '5L2c5Lia5oiq5q2i5pe26Ze05o+Q6YaS77ya5pys5ZGo5LqU',
  '--b1',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<html><body><p>fallback <strong>html</strong> body</p></body></html>',
  '--b1--',
  '',
].join('\r\n');

const MESSAGE_1_PAYLOAD = MESSAGE_1_HEADERS + MESSAGE_1_BODY;
const MESSAGE_1_BYTES = Buffer.byteLength(MESSAGE_1_PAYLOAD, 'utf8');

/** 一个字面量片段：`* n FETCH (BODY[] {n}` 标记行 + 恰好 n 字节 + 收尾 `)`。 */
const MESSAGE_1_FRAGMENT = `* 1 FETCH (BODY[] {${MESSAGE_1_BYTES}}\r\n`
  + MESSAGE_1_PAYLOAD
  + ')\r\n';

const MESSAGE_2_HEADERS = 'Message-ID: <CRLF-2@school.example.edu>\r\n'
  + 'Subject: =?UTF-8?Q?=E5=B8=A6=E5=AD=97=E9=9D=A2=E9=87=8F=E7=9A=84=E6=AD=A3=E6=96=87?=\r\n'
  + 'From: =?UTF-8?B?546L6ICB5biI?= <wang@school.example.edu>\r\n'
  + 'Date: Mon, 32 Sep 2025 99:99:99 +0000\r\n'
  + 'Content-Type: multipart/mixed; boundary="m2"\r\n'
  + '\r\n';

/** 第二封首选正文：base64 后的中文，用来验证「字面量里的 base64 无损解码」。 */
const MESSAGE_2_PLAIN = '带字面量的正文：CRLF、大括号、行尾 } 都只是字节';
const MESSAGE_2_PLAIN_BASE64 = Buffer.from(MESSAGE_2_PLAIN, 'utf8').toString('base64');

/**
 * 第二封是压测字面量解析的：整个字面量内部塞满 `\r\n`、`{1}`、`{2}`，
 * 以及行尾形状的 `}`（下面那两行原样留在字面量里）。
 * 解析器只有严格按 `{n}` 吃 n 字节才可能解析正确；一旦把正文里的 `{2}` 当成新标记，
 * 字面量个数就会变成 2、字节比对也会失败。
 * 首选的 text/plain 是 base64（解码后是中文），所以正文预览取的是它。
 */
const MESSAGE_2_BODY = [
  '--m2',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  MESSAGE_2_PLAIN_BASE64,
  '--m2',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'CRLFXOK{1}{2}',
  'BODY-CR-LF-OK',
  '--m2',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<html><body>html  fallback   body</body></html>',
  '--m2--',
  '',
].join('\r\n');

const MESSAGE_2_PAYLOAD = MESSAGE_2_HEADERS + MESSAGE_2_BODY;
const MESSAGE_2_BYTES = Buffer.byteLength(MESSAGE_2_PAYLOAD, 'utf8');

const MESSAGE_2_FRAGMENT = `* 2 FETCH (BODY[] {${MESSAGE_2_BYTES}}\r\n`
  + MESSAGE_2_PAYLOAD
  + ')\r\n';

/** 单封邮件的完整响应：只给纯函数级用例使用（transcript 里不出现）。 */
const MESSAGE_1_RESPONSE = MESSAGE_1_FRAGMENT + 'a3 OK FETCH completed\r\n';
const MESSAGE_2_RESPONSE = MESSAGE_2_FRAGMENT + 'a4 OK FETCH completed\r\n';

/**
 * 一次 FETCH 命令的完整响应：两封邮件一个字面量一个，**整段只有一条完成行**
 * （就是最后的 `a5 OK`）。中间不许再夹带任何带标记的 OK/NO/BAD。
 */
const FETCH_RESPONSE = MESSAGE_1_FRAGMENT + MESSAGE_2_FRAGMENT + 'a5 OK FETCH completed\r\n';

/** 单封失败用例用的载荷：只有头、没有空行也没有正文 → 该序号应被跳过（警告）。 */
const BODYLESS_MESSAGE = 'Message-ID: <BODYLESS-1@school.example.edu>\r\nSubject: no body\r\n';

/**
 * 真实录音（Dovecot 风格）：a1 LOGIN → a2 ID（RFC 2971，网易系必须）→ a3 SELECT
 * → a4 SEARCH → a5 FETCH → a6 LOGOUT。ID 的回复里额外带一句未标记数据。
 */
const IMAP_ROUTES = [
  { test: /^a1 LOGIN /, reply: 'a1 OK LOGIN completed\r\n' },
  { test: /^a2 ID /, reply: '* ID ("name" "Dovecot")\r\na2 OK ID completed\r\n' },
  { test: /^a3 SELECT /, reply: '* 2 EXISTS\r\na3 OK [READ-ONLY] SELECT completed\r\n' },
  { test: /^a4 SEARCH /, reply: '* SEARCH 1 2\r\na4 OK SEARCH completed\r\n' },
  { test: /^a5 FETCH /, reply: FETCH_RESPONSE },
  { test: /^a6 LOGOUT/, reply: '* BYE Logging out\r\na6 OK LOGOUT completed\r\n' },
];

/** 问候语由服务端主动推送，不依赖客户端写入。 */
const GREETING = '* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR] Dovecot ready.\r\n';

/**
 * 假 TLS socket：握手完成后主动推问候语，之后按写入的命令回放录音，
 * 并把回复切成小块逐块 emit('data')。
 * chunkSize 用质数，能让"字面量长度数字 + 字面量本体"被切在任意位置。
 */
class FakeSocket extends EventEmitter {
  constructor(routes, chunkSize = 7, greeting = GREETING) {
    super();
    this.routes = routes;
    this.chunkSize = chunkSize;
    this.greeting = greeting;
    this.writes = [];
    this.destroyed = false;
    this.setEncodingCalls = [];
    this.timeouts = [];
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit('connect');
      this.emit('secureConnect');
      if (this.greeting) this.deliver(this.greeting);
    });
  }

  setEncoding(encoding) {
    this.setEncodingCalls.push(encoding);
    return this;
  }

  setTimeout(ms) {
    this.timeouts.push(ms);
    return this;
  }

  setNoDelay() {
    return this;
  }

  write(line) {
    if (this.destroyed) throw new Error('socket 已销毁');
    this.writes.push(line);
    const route = this.routes.find((entry) => entry.test.test(line));
    if (!route) {
      throw new Error(`假 socket 没有这条命令的录像：${line.trim()}`);
    }
    this.deliver(route.reply);
    return true;
  }

  deliver(response) {
    const bytes = Buffer.from(response, 'latin1');
    for (let offset = 0; offset < bytes.length; offset += this.chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + this.chunkSize, bytes.length));
      setImmediate(() => {
        if (this.destroyed) return;
        this.emit('data', chunk);
      });
    }
  }

  end() {
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit('end');
      this.emit('close', false);
    });
    return this;
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    setImmediate(() => this.emit('close', true));
    return this;
  }
}

function createSocketFactory(sockets, routes, chunkSize = 7, greeting = GREETING) {
  return function connect(options) {
    const socket = new FakeSocket(routes, chunkSize, greeting);
    socket.options = options;
    sockets.push(socket);
    return socket;
  };
}

// ---------------------------------------------------------------------------
// 固定的假时钟 / 假日志
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2026, 0, 7, 12, 0, 0); // 2026-01-07T12:00:00Z

/**
 * 假时钟 + 假 sleep：sleep 必须把虚拟时间往前推。
 * 真实 setTimeout 会让时钟自然前进；如果只冻结 now 又立刻 resolve，
 * 令牌桶永远补不满 1 个令牌，acquire 会死循环。
 */
function createClock(startAt = FIXED_NOW) {
  let current = startAt;
  const sleeps = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms) => { current += ms; },
  };
}

const clock = createClock();

function debugLogger() {
  return {
    debug: (...args) => console.error('[dbg]', ...args),
    info: (...args) => console.error('[info]', ...args),
    warn: (...args) => console.error('[warn]', ...args),
    error: (...args) => console.error('[err]', ...args),
  };
}

function silentLogger() {
  const lines = [];
  return {
    lines,
    debug: (...args) => lines.push(['debug', ...args]),
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
    error: (...args) => lines.push(['error', ...args]),
  };
}

// ---------------------------------------------------------------------------
// Graph fixtures
// ---------------------------------------------------------------------------

const GRAPH_CONFIG = {
  provider: 'graph',
  graph: {
    tenantId: 'contoso.onmicrosoft.com',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    user: 'student@school.example.edu',
    mailboxFolder: 'Inbox',
    filterFromDomains: ['school.example.edu'],
    lookbackDays: 7,
    timeoutSeconds: 30,
    rateLimitRps: 1000,
    retry: { maxAttempts: 3, backoffBase: 1.5 },
  },
};

const GRAPH_MESSAGES = [
  {
    id: 'AAA-1',
    internetMessageId: '<WEEKLY-1@school.example.edu>',
    subject: '作业截止时间提醒',
    from: { emailAddress: { address: 'teacher@School.Example.Edu' } },
    receivedDateTime: '2026-01-07T08:30:00Z',
    bodyPreview: '本周五 23:59 截止，请尽快提交。',
  },
  {
    id: 'AAA-2',
    internetMessageId: '<PROMO-9@news.other.com>',
    subject: '限时优惠',
    from: { emailAddress: { address: 'noreply@news.other.com' } },
    receivedDateTime: '2026-01-06T09:00:00Z',
    bodyPreview: '促销',
  },
  {
    id: 'AAA-3',
    internetMessageId: '',
    subject: '缺 internetMessageId，退回用 id',
    from: { emailAddress: { address: 'ta@cs.school.example.edu' } },
    receivedDateTime: '  2026-01-05T01:02:03Z  ',
    bodyPreview: '',
  },
];

function makeGraphTransport(options = {}) {
  const state = {
    calls: [],
    tokenCalls: 0,
    sleeps: [],
    listCalls: 0,
    retryFired: false,
    failTokenWith: options.failTokenWith || null,
    failListWith: options.failListWith || null,
  };
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    state.calls.push({ url, method, headers: init.headers || {}, body: init.body, search: parsed.search });
    if (parsed.hostname === 'login.microsoftonline.com') {
      state.tokenCalls += 1;
      if (state.failTokenWith) {
        return {
          status: state.failTokenWith,
          headers: new Map(),
          json: async () => ({ error: 'invalid_client' }),
        };
      }
      return {
        status: 200,
        headers: new Map(),
        json: async () => ({ access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }),
      };
    }
    if (parsed.hostname !== 'graph.microsoft.com') throw new Error(`意外的出站地址：${url}`);
    state.listCalls += 1;
    if (state.failListWith) {
      return {
        status: state.failListWith,
        headers: new Map(),
        json: async () => ({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }),
      };
    }
    if (options.retryOnce && !state.retryFired) {
      state.retryFired = true;
      return { status: 429, headers: new Map([['retry-after', '0']]), json: async () => ({}) };
    }
    if (!parsed.search) {
      // 第二页来自 @odata.nextLink：客户端补参数会变成空 query，这里直接判错
      return { status: 400, headers: new Map(), json: async () => ({ error: 'nextLink 不应再带参数' }) };
    }
    if (parsed.searchParams.get('$skiptoken') === 'page2') {
      return { status: 200, headers: new Map(), json: async () => ({ value: [GRAPH_MESSAGES[2]] }) };
    }
    return {
      status: 200,
      headers: new Map(),
      json: async () => ({
        value: [GRAPH_MESSAGES[0], GRAPH_MESSAGES[1]],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2',
      }),
    };
  };
  return { fetchImpl, state };
}

async function graphTests() {
  console.log('\n# Graph');
  const transport = makeGraphTransport();
  const logger = silentLogger();
  const result = await fetchMail(GRAPH_CONFIG, {
    fetchImpl: transport.fetchImpl,
    now: clock.now,
    logger,
    sleep: clock.sleep,
  });

  check('fetchMail 返回 { items, warnings } 结构', Array.isArray(result.items) && Array.isArray(result.warnings));
  equal(result.warnings.length, 0, 'Graph 正常路径无警告');
  equal(result.items.length, 2, 'Graph 命中白名单 2 封（1 封被发件人白名单拒掉）');

  const [first, second] = result.items;
  equal(first.source, SOURCE_MAIL, 'source = mail');
  equal(first.external_id, 'graph:WEEKLY-1@school.example.edu', 'external_id 去掉尖括号并加 graph: 前缀');
  equal(Object.keys(first.payload).join(','), 'subject,from,receivedDateTime,bodyPreview', 'payload 恰好四个键且顺序固定');
  equal(first.payload.from, 'teacher@School.Example.Edu', 'from = 发件人地址（原样大小写）');
  equal(first.payload.receivedDateTime, '2026-01-07T08:30:00Z', 'receivedDateTime 原样保留');
  equal(first.payload.bodyPreview, '本周五 23:59 截止，请尽快提交。', 'bodyPreview 保留 Graph 原文');
  equal(first.course_id, null, 'course_id = null');
  equal(second.external_id, 'graph:AAA-3', '缺 internetMessageId 时退回 message.id');
  equal(second.payload.receivedDateTime, '2026-01-05T01:02:03Z', 'receivedDateTime trim 后保留');
  equal(second.payload.bodyPreview, '', '缺 bodyPreview 时补空串');
  check(
    '发件人不匹配 filterFromDomains 的邮件被跳过',
    !result.items.some((item) => item.payload.from === 'noreply@news.other.com'),
  );

  equal(transport.state.tokenCalls, 1, '令牌只取一次（整段拉取内缓存）');
  const tokenCall = transport.state.calls.find((call) => call.url.includes('login.microsoftonline.com'));
  check(
    '令牌端点 URL',
    tokenCall.url === 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    tokenCall.url,
  );
  equal(tokenCall.method, 'POST', '令牌用 POST');
  const form = new URLSearchParams(tokenCall.body);
  equal(form.get('grant_type'), 'client_credentials', 'grant_type = client_credentials');
  equal(form.get('scope'), 'https://graph.microsoft.com/.default', 'scope = .default');
  equal(form.get('client_id'), 'client-abc', 'client_id');
  equal(form.get('client_secret'), 'secret-xyz', 'client_secret');

  const listCalls = transport.state.calls.filter((call) => call.url.startsWith('https://graph.microsoft.com'));
  equal(listCalls.length, 2, '翻页共两次列表请求');
  const firstList = new URL(listCalls[0].url);
  equal(
    firstList.pathname,
    '/v1.0/users/student%40school.example.edu/mailFolders/Inbox/messages',
    '列表路径（user 做 encodeURIComponent）',
  );
  equal(firstList.searchParams.get('$filter'), 'receivedDateTime ge 2025-12-31T12:00:00Z', '$filter 的 since = now − lookbackDays');
  equal(firstList.searchParams.get('$select'), 'subject,from,receivedDateTime,bodyPreview,internetMessageId', '$select 字段集');
  equal(firstList.searchParams.get('$top'), '50', '$top = 50');
  equal(listCalls[0].headers.Authorization, 'Bearer tok-1', '列表请求带 Bearer 令牌');
  equal(listCalls[1].search, '?$skiptoken=page2', '翻页请求沿用 nextLink，不叠加参数');

  // 429 + Retry-After: 0（用全新时钟，保证 sleeps[0] 就是这个重试的等待）
  const retryClock = createClock();
  const retryTransport = makeGraphTransport({ retryOnce: true });
  const retryResult = await fetchMail(GRAPH_CONFIG, {
    fetchImpl: retryTransport.fetchImpl,
    now: retryClock.now,
    logger: silentLogger(),
    sleep: retryClock.sleep,
  });
  equal(retryResult.items.length, 2, '429 重试后仍拿到数据');
  equal(retryTransport.state.tokenCalls, 1, '429 重试不会重复取令牌');
  check('重试后列表请求次数增加', retryTransport.state.listCalls >= 2, retryTransport.state.listCalls);
  // sleeps 里除了这次重试，还会有令牌桶自己的最小等待（限流），
  // 所以断言"出现过 0"而不是"第一个就是 0"。
  check('Retry-After: 0 就是等 0 秒（未被 || 短路成退避）', retryClock.sleeps.includes(0), retryClock.sleeps);

  // 非 2xx 的 4xx 不重试
  const badRequestTransport = makeGraphTransport();
  const failingFetch = async (url, init) => {
    const response = await badRequestTransport.fetchImpl(url, init);
    if (url.startsWith('https://graph.microsoft.com')) {
      return { status: 400, headers: new Map(), json: async () => ({ error: 'bad request' }) };
    }
    return response;
  };
  let badError = null;
  try {
    await fetchMail(GRAPH_CONFIG, { fetchImpl: failingFetch, now: clock.now, logger: silentLogger(), sleep: clock.sleep });
  } catch (error) {
    badError = error;
  }
  check('其它 4xx 直接抛出且带状态码', badError !== null && badError.message.includes('400'), badError && badError.message);
  equal(badRequestTransport.state.listCalls, 1, '其它 4xx 不重试（只请求一次）');

  // 令牌端点 403 → 错误信息必须自带「改用 IMAP」这条出路（lib/mail.js 的
  // requestWithRetry 对 401/403 追加 IMAP_HINT，token 与数据两条路径都覆盖）。
  const denied = makeGraphTransport({ failTokenWith: 403 });
  let deniedError = null;
  try {
    await fetchMail(GRAPH_CONFIG, { fetchImpl: denied.fetchImpl, now: clock.now, logger: silentLogger(), sleep: clock.sleep });
  } catch (error) {
    deniedError = error;
  }
  check('Graph 403 会抛错', deniedError !== null, deniedError && deniedError.message);
  check(
    'Graph 403 的错误信息带状态码、端点与改用 IMAP 的提示',
    deniedError !== null
      && deniedError.message.includes('403')
      && deniedError.message.includes('login.microsoftonline.com')
      && deniedError.message.includes('改用 IMAP'),
    deniedError && deniedError.message,
  );
  // 数据端点 403（令牌 200 但没授 Mail.Read —— 学生租户最常见的失败）同样要给提示。
  const dataDenied = makeGraphTransport({ failListWith: 403 });
  let dataDeniedError = null;
  try {
    await fetchMail(GRAPH_CONFIG, { fetchImpl: dataDenied.fetchImpl, now: clock.now, logger: silentLogger(), sleep: clock.sleep });
  } catch (error) {
    dataDeniedError = error;
  }
  check(
    'Graph 数据端点 403 也给改用 IMAP 的提示',
    dataDeniedError !== null && dataDeniedError.message.includes('改用 IMAP'),
    dataDeniedError && dataDeniedError.message,
  );

  // 配置缺失
  equal(mailConfigured(GRAPH_CONFIG), true, 'Graph 配置齐全 → mailConfigured = true');
  equal(mailConfigured({ provider: 'graph', graph: { tenantId: 't' } }), false, 'Graph 缺字段 → mailConfigured = false');
  equal(
    mailMissingFields({ provider: 'graph', graph: { tenantId: 't' } }).join('、'),
    'clientId、clientSecret、user',
    'mailMissingFields 返回 Graph 缺失字段名',
  );
  equal(
    mailMissingFields({ provider: 'imap', imap: { host: 'h', port: 993 } }).join('、'),
    'username、password',
    'mailMissingFields 返回 IMAP 缺失字段名',
  );
  const incomplete = await testMail({ provider: 'imap', imap: { username: 'u' } }, { now: clock.now });
  equal(incomplete.ok, false, 'testMail 配置不全 → ok=false');
  check('testMail 的中文提示点名缺失字段', incomplete.message.includes('缺少配置：host、password'), incomplete.message);

  const graphDeniedTest = await testMail(GRAPH_CONFIG, {
    fetchImpl: makeGraphTransport({ failTokenWith: 401 }).fetchImpl,
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(graphDeniedTest.ok, false, 'testMail 遇到 401 → ok=false（不抛异常）');
  check(
    'testMail 的 Graph 401 提示改用 IMAP',
    graphDeniedTest.message.includes('该租户未授予应用级 Mail.Read 权限，建议改用 IMAP'),
    graphDeniedTest.message,
  );

  const graphOkTest = await testMail(GRAPH_CONFIG, {
    fetchImpl: makeGraphTransport().fetchImpl,
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(graphOkTest.ok, true, 'testMail Graph 成功路径 ok=true');
  // testMail 只探测首页、按服务端返回的条数报告（域名过滤是 fetchMail 阶段的事），
  // 首页两条里有一条属于别的域名，所以这里是 2 封。
  check('testMail Graph 成功路径报告邮件条数', graphOkTest.message.includes('2 封'), graphOkTest.message);
}

// ---------------------------------------------------------------------------
// IMAP fixtures
// ---------------------------------------------------------------------------

const IMAP_CONFIG = {
  provider: 'imap',
  imap: {
    host: 'imap.school.example.edu',
    port: 993,
    username: 'stu"dent\\x',
    password: 'p@ss\\word"1',
    folder: 'INBOX',
    lookbackDays: 7,
    timeoutSeconds: 5,
    rateLimitRps: 1000,
  },
};

async function imapTests() {
  console.log('\n# IMAP');
  const sockets = [];
  const result = await fetchMail(IMAP_CONFIG, {
    connect: createSocketFactory(sockets, IMAP_ROUTES, 7),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });

  equal(sockets.length, 1, 'IMAP 走注入的 connect（只建一个连接）');
  equal(result.items.length, 2, '解析出 2 封邮件');
  equal(result.warnings.length, 0, '两封都能解析，无警告');

  // 录音字节账本：{n} 一律由 MESSAGE_*_BYTES 算出，这里核对它与实际载荷一致。
  equal(
    MESSAGE_1_FRAGMENT.includes(`{${MESSAGE_1_BYTES}}\r\n`),
    true,
    `录音声明 {${MESSAGE_1_BYTES}} 恰好是整封邮件字节数（MESSAGE_1）`,
  );
  equal(
    MESSAGE_2_FRAGMENT.includes(`{${MESSAGE_2_BYTES}}\r\n`),
    true,
    `录音声明 {${MESSAGE_2_BYTES}} 恰好是整封邮件字节数（MESSAGE_2）`,
  );
  equal(
    /^[\x00-\x7f]*$/.test(MESSAGE_1_FRAGMENT + MESSAGE_2_FRAGMENT),
    true,
    '录音是纯 ASCII，于是 latin1 与 utf8 的字节数一致（中文只在 base64/encoded-word 里）',
  );
  equal(
    Buffer.byteLength(MESSAGE_2_FRAGMENT, 'latin1'),
    Buffer.byteLength(MESSAGE_2_FRAGMENT, 'utf8'),
    '第二封录音按 latin1 读与按 utf8 数完全等长',
  );

  const [m1, m2] = result.items;
  equal(m1.source, SOURCE_MAIL, 'IMAP source = mail');
  equal(m1.external_id, 'imap:WEEKLY-1@school.example.edu', 'external_id 用 Message-ID');
  equal(Object.keys(m1.payload).join(','), 'subject,from,receivedDateTime,bodyPreview', 'payload 恰好四个键且顺序固定');
  equal(m1.payload.subject, '作业截止时间提醒', 'RFC2047 B 编码主题');
  equal(m1.payload.from, '李老师 <teacher@school.example.edu>', 'From 整段解码并保留显示名');
  equal(m1.payload.receivedDateTime, '2026-01-07T08:30:00+08:00', 'Date 头 +0800 → 墙上时间照抄、偏移保留 +08:00');
  equal(m1.payload.bodyPreview, '作业截止时间提醒：本周五', 'multipart/alternative 优先 text/plain（base64 解码）');

  equal(m2.payload.subject, '带字面量的正文', 'RFC2047 Q 编码主题（含 =E5 转义）');
  equal(m2.payload.from, '王老师 <wang@school.example.edu>', '第二封 From');
  equal(m2.payload.receivedDateTime, 'Mon, 32 Sep 2025 99:99:99 +0000', '畸形 Date 保留原文（截断 200 字符内）');
  equal(
    m2.payload.bodyPreview,
    MESSAGE_2_PLAIN,
    '字面量里的 \\r\\n/{1}/{2}/行尾 } 被字节精确跳过，base64 正文无损解码',
  );

  const socket = sockets[0];
  const writes = socket.writes.map((line) => line.trim());
  // 与 Python 的 imaplib 不同：本实现不发 CAPABILITY，但按 RFC 2971 发一条 ID
  // （网易系 163/126/yeah.net 不发就会被 SELECT 拒掉：Unsafe Login）。
  equal(writes.length, 6, '一共发出 6 条命令（LOGIN/ID/SELECT/SEARCH/FETCH/LOGOUT）', writes);
  check('LOGIN 的引号与反斜杠都做了转义', /^a1 LOGIN "stu\\"dent\\\\x" "p@ss\\\\word\\"1"$/.test(writes[0]), writes[0]);
  check(
    'ID 命令按 RFC 2971 通报客户端身份（名称/版本/厂商/支持地址）',
    /^a2 ID \("name" "dsh-canvas-task-monitor" "version" "\d+\.\d+\.\d+" "vendor" "jacky720real" "support-url" "https?:\/\/\S+"\)$/.test(writes[1]),
    writes[1],
  );
  equal(writes[2], 'a3 SELECT "INBOX"', 'SELECT 用引用字符串');
  const searchDate = /^a4 SEARCH SINCE "(\d{2}-[A-Za-z]{3}-\d{4})"$/.exec(writes[3]);
  equal(searchDate && searchDate[1], '31-Dec-2025', 'SEARCH SINCE 日期 = now − 7 天（UTC，dd-Mon-yyyy）');
  check('FETCH 按块提交序号集合', writes[4].startsWith('a5 FETCH 1,2 '), writes[4]);
  check('FETCH 用 BODY.PEEK[]（不改变已读状态）', writes[4].includes('BODY.PEEK[]'), writes[4]);
  equal(writes[5], 'a6 LOGOUT', 'finally 里发 LOGOUT');
  equal(socket.setEncodingCalls[0], 'latin1', 'socket 以 latin1 读取，保证逐字节保真');
  equal(socket.options.servername, 'imap.school.example.edu', 'tls 选项带 servername');
  equal(socket.options.rejectUnauthorized, true, 'tls 校验证书');

  // 分块边界：同样的录音用 1 字节一块再跑一次
  const tinySockets = [];
  const tinyResult = await fetchMail(IMAP_CONFIG, {
    connect: createSocketFactory(tinySockets, IMAP_ROUTES, 1),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(tinyResult.items.length, 2, '逐字节投递（1 字节/块）仍能解析出 2 封');
  equal(
    tinyResult.items[1].payload.bodyPreview,
    result.items[1].payload.bodyPreview,
    '逐字节投递与 7 字节分块的第二封预览一致',
  );
  equal(
    tinyResult.items[0].payload.from,
    result.items[0].payload.from,
    '逐字节投递与 7 字节分块的第一封 from 一致',
  );

  // 单封失败只警告，不中断整批
  const failingRoutes = [
    IMAP_ROUTES[0],
    IMAP_ROUTES[1],
    IMAP_ROUTES[2],
    IMAP_ROUTES[3],
    {
      test: /^a5 FETCH /,
      reply: `* 1 FETCH (BODY[] {${Buffer.byteLength(BODYLESS_MESSAGE, 'latin1')}}\r\n`
        + BODYLESS_MESSAGE
        + ')\r\n'
        + 'a5 OK FETCH completed\r\n',
    },
    IMAP_ROUTES[5],
  ];
  const failResult = await fetchMail(IMAP_CONFIG, {
    connect: createSocketFactory([], failingRoutes, 11),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(failResult.items.length, 0, '没有可解析正文时不产出条目');
  equal(failResult.warnings.length, 2, '无正文的那封与服务器没回的那封各转成一条警告');
  check('警告里带序号 1', failResult.warnings.some((w) => w.includes('1')), failResult.warnings);
  check('警告里带序号 2', failResult.warnings.some((w) => w.includes('2')), failResult.warnings);

  // 服务器 NO → 抛出并带服务器原文
  const noRoutes = [
    { test: /^a1 LOGIN /, reply: 'a1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n' },
  ];
  let authError = null;
  try {
    await fetchMail(IMAP_CONFIG, {
      connect: createSocketFactory([], noRoutes, 9),
      now: clock.now,
      logger: silentLogger(),
      sleep: clock.sleep,
    });
  } catch (error) {
    authError = error;
  }
  check('LOGIN NO 会从 fetchMail 抛出（连接级失败）', authError !== null, authError && authError.message);
  // 服务端原文是 `a1 NO [AUTHENTICATIONFAILED] Invalid credentials`；实现会把
  // `[...]` 响应码拆出去，只把人类可读部分带进错误信息。
  check(
    '抛出的错误带服务器原文',
    authError !== null && authError.message.includes('Invalid credentials') && authError.message.includes('NO'),
    authError && authError.message,
  );

  // RFC 2971：服务器不认识 ID 会回 BAD —— 必须当没发生，后续命令照常
  const idRejectedRoutes = [
    IMAP_ROUTES[0],
    { test: /^a2 ID /, reply: 'a2 BAD Unknown command\r\n' },
    IMAP_ROUTES[2],
    IMAP_ROUTES[3],
    IMAP_ROUTES[4],
    IMAP_ROUTES[5],
  ];
  const idRejectedSockets = [];
  const idRejected = await fetchMail(IMAP_CONFIG, {
    connect: createSocketFactory(idRejectedSockets, idRejectedRoutes, 7),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(idRejected.items.length, 2, 'ID 被回 BAD 时照常取回 2 封邮件（ID 是可选命令）');
  equal(idRejected.warnings.length, 0, 'ID 被拒不算警告');
  check(
    'ID 被拒后仍走完 SELECT/SEARCH/FETCH/LOGOUT',
    idRejectedSockets[0].writes.some((line) => line.includes('LOGOUT')),
    idRejectedSockets[0].writes,
  );
  const idRejectedTest = await testMail(IMAP_CONFIG, {
    connect: createSocketFactory([], idRejectedRoutes, 7),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(idRejectedTest.ok, true, 'testMail 在 ID 被拒时仍报成功');

  // 宿主点「测试连接」时走的是 pipeline.testSource → testMail(config)，**不传任何 options**：
  // 少传 logger 曾经让一句调试日志（`logger.debug`）把整次连接打崩。夹具必须照抄这个入口。
  const noLoggerTest = await testMail(IMAP_CONFIG, { connect: createSocketFactory([], IMAP_ROUTES, 7), now: clock.now });
  equal(noLoggerTest.ok, true, '不传 logger（宿主 test_source 的真实调用方式）也能连上');
  check('不传 logger 时报出邮件条数', noLoggerTest.message.includes('2 封'), noLoggerTest.message);

  const noLoggerFetch = await fetchMail(IMAP_CONFIG, { connect: createSocketFactory([], IMAP_ROUTES, 7), now: clock.now, sleep: clock.sleep });
  equal(noLoggerFetch.items.length, 2, '不传 logger 时照常取回 2 封邮件');
  equal(noLoggerFetch.warnings.length, 0, '不传 logger 不产生警告');

  for (const [label, logger] of [['null', null], ['undefined', undefined], ['字符串', 'not-a-logger']]) {
    const odd = await testMail(IMAP_CONFIG, { connect: createSocketFactory([], IMAP_ROUTES, 7), now: clock.now, logger });
    equal(odd.ok, true, `logger=${label} 时降级成静默而不是崩掉`);
  }

  const debugLines = [];
  const collectingLogger = { debug: (...args) => debugLines.push(args.join(' ')), info: () => {}, warn: () => {}, error: () => {} };
  await testMail(IMAP_CONFIG, { connect: createSocketFactory([], IMAP_ROUTES, 7), now: clock.now, logger: collectingLogger });
  check(
    '给了 logger 时日志照样发出去（不是把日志整体静音换来的不崩）',
    debugLines.some((line) => line.includes('IMAP → a1 LOGIN')),
    debugLines.join(' | '),
  );

  // 有些宿主把 logger 做成「带 .debug 的函数」——不能被当成非对象静音掉
  const functionDebugLines = [];
  const functionLogger = Object.assign(() => {}, {
    debug: (...args) => functionDebugLines.push(args.join(' ')),
  });
  const functionLoggerTest = await testMail(IMAP_CONFIG, { connect: createSocketFactory([], IMAP_ROUTES, 7), now: clock.now, logger: functionLogger });
  equal(functionLoggerTest.ok, true, '函数型 logger 也能连上');
  check(
    '函数型 logger 的 .debug 仍被调用',
    functionDebugLines.some((line) => line.includes('IMAP → a1 LOGIN')),
    functionDebugLines.join(' | '),
  );

  // 网易系（163/126/yeah.net）：登录后不发 ID，SELECT 会被拒成 Unsafe Login
  const unsafeLoginRoutes = [
    IMAP_ROUTES[0],
    IMAP_ROUTES[1],
    { test: /^a3 SELECT /, reply: 'a3 NO SELECT Unsafe Login. Please contact kefu@188.com for help\r\n' },
  ];
  let unsafeError = null;
  try {
    await fetchMail(IMAP_CONFIG, {
      connect: createSocketFactory([], unsafeLoginRoutes, 9),
      now: clock.now,
      logger: silentLogger(),
      sleep: clock.sleep,
    });
  } catch (error) {
    unsafeError = error;
  }
  check('SELECT 回 Unsafe Login 时抛出', unsafeError !== null, unsafeError && unsafeError.message);
  check(
    'Unsafe Login 的错误带"开启 IMAP 服务 + 授权码"提示与服务器原文',
    unsafeError !== null
      && unsafeError.message.includes('Unsafe Login')
      && unsafeError.message.includes('授权码'),
    unsafeError && unsafeError.message,
  );

  // testMail：成功路径报告条数
  const imapTest = await testMail(IMAP_CONFIG, {
    connect: createSocketFactory([], IMAP_ROUTES, 5),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(imapTest.ok, true, 'testMail IMAP 成功路径 ok=true');
  check('testMail IMAP 报告邮件条数', imapTest.message.includes('2 封'), imapTest.message);

  const failingTest = await testMail(IMAP_CONFIG, {
    connect: createSocketFactory([], noRoutes, 9),
    now: clock.now,
    logger: silentLogger(),
    sleep: clock.sleep,
  });
  equal(failingTest.ok, false, 'testMail IMAP 失败路径 ok=false（不抛异常）');
  check('testMail 失败信息带原因', failingTest.message.includes('Invalid credentials'), failingTest.message);
}

// ---------------------------------------------------------------------------
// 纯函数级检查（字面量解析 / MIME / 日期）
// ---------------------------------------------------------------------------

function pureFunctionTests() {
  console.log('\n# 纯函数');

  const parsed = parseImapResponse(MESSAGE_1_RESPONSE, { tag: 'a3' });
  equal(parsed.tagged.status, 'OK', '解析出带标记的 OK 完成行');
  equal(parsed.literals.length, 1, '第一封恰好一个字面量');
  equal(
    Buffer.compare(parsed.literals[0], Buffer.from(MESSAGE_1_PAYLOAD, 'utf8')),
    0,
    '字面量按字节精确取出（不多不少，整封邮件）',
  );

  const crlfParsed = parseImapResponse(MESSAGE_2_RESPONSE, { tag: 'a4' });
  equal(crlfParsed.literals.length, 1, '第二封也只识别出一个字面量（正文里的 {2} 不是新标记）');
  equal(
    Buffer.compare(crlfParsed.literals[0], Buffer.from(MESSAGE_2_PAYLOAD, 'utf8')),
    0,
    '字面量里的 \\r\\n、{1}、{2}、行尾 } 都不影响字节边界',
  );
  equal(crlfParsed.tagged.status, 'OK', '第二封的完成行仍被正确识别');

  // 整段 FETCH 响应里只许有一条完成行（a5），且两个字面量都完好
  const combined = parseImapResponse(FETCH_RESPONSE, { tag: 'a5' });
  equal(combined.literals.length, 2, '一次 FETCH 返回两个字面量');
  equal(combined.tagged.status, 'OK', 'FETCH 响应以唯一的 a5 OK 收尾');
  equal(combined.tagged.tag, 'a5', '完成行的标记是 a5');
  equal(
    combined.lines.filter((line) => line.status !== undefined).length,
    1,
    '整段 FETCH 响应只有一条带标记的完成行',
  );

  // 字面量未到齐时不误判
  const partial = parseImapResponse('* 1 FETCH (BODY[] {100}\r\nshort', { tag: 'a1' });
  equal(partial.tagged, null, '字面量未到齐时不算完成');
  equal(partial.literals.length, 0, '字面量未到齐时不产出半个字面量');

  // 裸 LF
  const lf = parseImapResponse('* 1 EXISTS\na1 OK done\n', { tag: 'a1' });
  equal(lf.tagged.status, 'OK', '裸 LF 的完成行被识别');
  equal(lf.lines.filter((line) => line.raw.startsWith('*')).length, 1, '裸 LF 的未标记行被识别');

  // 参数解析
  const params = parseHeaderParams('multipart/mixed; boundary="b1"; charset=utf-8');
  equal(params.type, 'multipart/mixed', '解析 Content-Type 主类型');
  equal(params.params.boundary, 'b1', '解析 boundary（去引号）');
  equal(params.params.charset, 'utf-8', '解析 charset');
  const rfc2231 = parseHeaderParams("text/plain; charset*=utf-8''%E4%BD%9C%E4%B8%9A; name*0*=a; name*1*=b");
  equal(rfc2231.params.charset, '作业', 'RFC2231 扩展参数解码');
  equal(rfc2231.params['name*0'], 'a', 'RFC2231 段参数按原键名保留（本实现不拼接续行；我们只用到 charset）');
  equal(rfc2231.params['name*1'], 'b', 'RFC2231 第二段参数同样保留');

  // 头解码
  equal(decodeHeaderValue('=?UTF-8?B?5L2c5Lia?=').text, '作业', 'B 编码字');
  equal(decodeHeaderValue('=?utf-8?Q?=E4=BD=9C=E4=B8=9A?=').text, '作业', 'Q 编码字');
  equal(decodeHeaderValue('plain text').text, 'plain text', '非编码原文');
  equal(decodeHeaderValue(null).text, '', '缺失头 → 空串');

  // 日期：墙上时间照抄原文，时区用原文偏移（不换算成另一个瞬间）
  equal(
    normalizeDate('Wed, 07 Jan 2026 08:30:00 +0800'),
    '2026-01-07T08:30:00+08:00',
    '带偏移的 Date → 墙上时间 + 原文偏移',
  );
  equal(normalizeDate('Wed, 07 Jan 2026 08:30:00 -0530'), '2026-01-07T08:30:00-05:30', '半时区偏移 -0530 → -05:30');
  equal(normalizeDate('Wed, 07 Jan 2026 08:30:00 +08:00'), '2026-01-07T08:30:00+08:00', '带冒号的偏移原样保留');
  equal(normalizeDate('Wed, 07 Jan 2026 08:30:00 GMT'), '2026-01-07T08:30:00+00:00', 'GMT 归一为 +00:00');
  equal(normalizeDate('Wed, 07 Jan 2026 08:30:00 UTC'), '2026-01-07T08:30:00+00:00', 'UTC 归一为 +00:00');
  equal(normalizeDate('07 Jan 2026 08:30:00'), '2026-01-07T08:30:00+00:00', '朴素日期按 UTC 处理');
  equal(normalizeDate('Mon, 32 Sep 2025 09:00:00 +0000'), 'Mon, 32 Sep 2025 09:00:00 +0000', '畸形日期保留原文');
  equal(normalizeDate('   '), null, '空 Date → null');
  equal(normalizeDate(null), null, '缺失 Date → null');

  // 去标签
  equal(stripHtml('<p>a  <b>b</b></p>\n<i>c</i>'), 'a b c', '去标签并压缩空白');
  equal(stripHtml('a&nbsp;b'), 'a b', 'HTML 实体折叠成一个空格（本实现的有意选择）');

  // MIME 结构
  const mime = parseMimeMessage(MESSAGE_1_PAYLOAD);
  equal(mime.headerValue('subject'), '=?UTF-8?B?5L2c5Lia5oiq5q2i5pe26Ze05o+Q6YaS?=', '原始 Subject 头（未解码）');
  equal(mime.headerValue('message-id'), '<WEEKLY-1@school.example.edu>', 'Message-ID 原文');
  check('正文从 boundary 开始', mime.contentLines[0].startsWith('--b1'), mime.contentLines[0]);
  equal(
    Buffer.byteLength(MESSAGE_1_PAYLOAD, 'utf8'),
    MESSAGE_1_BYTES,
    `MESSAGE_1 载荷字节数与录音声明一致（{${MESSAGE_1_BYTES}}）`,
  );
  equal(
    Buffer.byteLength(MESSAGE_2_PAYLOAD, 'utf8'),
    MESSAGE_2_BYTES,
    `MESSAGE_2 载荷字节数与录音声明一致（{${MESSAGE_2_BYTES}}）`,
  );
}

// ---------------------------------------------------------------------------
// 断网保证（进程内绊线）
// ---------------------------------------------------------------------------
// 把"真实网络"的两个入口都换成绊线：globalThis.fetch 与 tls.connect。
// 注入 fetchImpl / connect 后仍然能跑完整流程，就说明模块一次都没碰过真实网络。
// （mail.js 在调用点解析这两个入口，所以进程内替换同样有效；子进程 + pipe 会被
//  harness 的沙箱拦掉，因此这里不另起进程。）
async function offlineGuaranteeTests() {
  console.log('\n# 不碰网络');

  const realFetch = globalThis.fetch;
  const realConnect = tls.connect;
  const trips = [];
  const tripwire = (stage) => {
    const error = new Error(`试图建立真实网络连接（${stage}）`);
    error.isTripwire = true;
    return error;
  };

  try {
    globalThis.fetch = async (url) => {
      trips.push(`fetch ${String(url)}`);
      throw tripwire(`fetch ${String(url)}`);
    };
    tls.connect = () => {
      trips.push('tls.connect');
      throw tripwire('tls.connect');
    };

    const graphResult = await fetchMail(GRAPH_CONFIG, {
      fetchImpl: makeGraphTransport().fetchImpl,
      now: clock.now,
      logger: silentLogger(),
      sleep: clock.sleep,
    });
    equal(
      graphResult.items.length,
      2,
      '把 globalThis.fetch 换成绊线后，注入 fetchImpl 仍能完成 Graph 拉取',
    );

    const imapResult = await fetchMail(IMAP_CONFIG, {
      connect: createSocketFactory([], IMAP_ROUTES, 7),
      now: clock.now,
      logger: silentLogger(),
      sleep: clock.sleep,
    });
    equal(
      imapResult.items.length,
      2,
      '把 tls.connect 换成绊线后，注入 connect 仍能完成 IMAP 拉取',
    );

    equal(trips.length, 0, 'Graph 与 IMAP 两条路径都没有触碰到真实网络', trips);
  } finally {
    globalThis.fetch = realFetch;
    tls.connect = realConnect;
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  console.log('# mail.js 离线 fixture');
  await graphTests();
  await imapTests();
  pureFunctionTests();
  await offlineGuaranteeTests();

  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const line of failures) console.log(`  - ${line}`);
  }
  console.log(`\npassed: ${passed}  failed: ${failed}`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('fixture 自身异常：', error);
    console.log(`\npassed: ${passed}  failed: ${failed + 1}`);
    process.exitCode = 1;
  });
