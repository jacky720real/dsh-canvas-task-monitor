# dsh-canvas-task-monitor

把 **Canvas LMS**（可选：**邮箱**）里的作业、公告、通知抓成一份可执行的待办清单，直接显示在 **DeepSeek Harness Desktop** 的侧边栏里。

> 1.1 是**完全自包含**的插件：不依赖 Python、不依赖 sidecar 进程、不依赖任何 npm 运行时依赖（数据库用 Node 24 自带的 `node:sqlite`）。装一个包，重启 DSH Desktop，左上侧边栏「插件」下面会多一行「待办」。

```
Canvas / 邮箱 ──► 变更检测 ──► 规则评分（可选 AI 兜底）──► 完成对账 ──► SQLite ──► DSH 侧边栏「待办」
```

---

## 1. 功能

| 区域 | 说明 |
| --- | --- |
| 左上侧边栏「待办」行 | 面板的**唯一入口**：「插件」下面多一行，行的右端挂一个数量胶囊（`（图标） 待办 … 59`），点一下切到整页面板 |
| 主区域整页 | 完整任务清单：筛选条（全部 / 作业 / 活动 / 提醒）、「显示已完成」开关、手动「拉取」、统计、设置页 |
| 来源小标签 | 每条任务前标出「Canvas」或「邮箱」，一眼看出这条是从哪来的 |

> 只有两个注册点：`main`（整页面板）与 `sidebar.panellist`（左上那一行的图标）。
> `sidebar.panellist` 那一行由 shell 自己渲染（按钮、文字、点击、行高都由它管），
> 插件只往里塞图标，所以不存在和 shell 自带那几行错位的问题；行标签固定写「待办」。
> **不注册 `sidebar.footer.action`**：左下角那一行是 shell 自己的「更多」按钮，尺寸与缩进由它控制，
> 插件塞进去很难对齐（试过一版，反而更难看），所以入口就固定在左上。

- **两级排序**：有截止时间的按截止时间**从近到远**排在前面；没有截止时间的（含**已经开始过的活动**）按**重要程度**降序排在后面。
- **「截止」和「活动」分开算**：只有真正的截止时间才会标「已逾期」；讲座、比赛、招募这类**活动开始时间**只当参考，过期了也不标红，还会退到「无时间」那组按重要度排。
- **不显示裸分数**：列表只给「紧急 / 重要 / 已逾期」这类文字徽标，具体的 0–100 分值只在详情里可见，避免被数字牵着走。
- **勾选完成可撤销**：误点完成会弹 8 秒撤销条，窗口内点「撤销」即可还原；过了就真的完成。
- **每轮拉取自动对账**：Canvas 上你已经提交/已评分的作业会被自动勾掉（详情里写明「完成方式：Canvas 已提交」）；邮件里出现「报名成功 / registration confirmed」时，原来的报名提醒会升级成「参加：…」，确认信本身勾掉；**邮箱任务还会拿去 Canvas 交叉核对**——邮件提醒的那件作业如果在 Canvas 那边已提交/已评分（或那条 Canvas 作业本来就勾掉了），这条邮件任务也会自动勾掉，不再顶着「已逾期」（完成方式写「Canvas 侧已完成：<作业名>」）。
- **手动改过的状态不会再被自动改**：你自己取消勾选过的任务，后面拉取不会又把它勾回去。
- **分类按内容判**（公告与邮件）：成绩已发布/答案已上传这类信息型通知归**提醒**而不是活动；报名截止归提醒；讲座/比赛/招募归**活动**；不计入总成绩或无分值的测验不再按「考试」抬重要度。
- **无变更绝不调用 AI**：内容哈希没变就整轮跳过，省 token 也省时间（判定逻辑升级那一轮例外，见 §3）。
- **状态归你**：你的「完成/未完成」不会被下一次拉取覆盖（数据库 UPSERT 刻意不写 `status`）。

## 2. 任务从哪来

### Canvas（默认启用）
- 走官方 REST API：`/api/v1/courses`（只取 active 选课）→ 每门课的 assignments + announcements。
- 作业的 `external_id` 形如 `course:<courseId>:assignment:<id>`，公告形如 `course:<courseId>:announcement:<id>`：同一门课改了名字也不会重复建任务。
- 分页只认 `Link: rel="next"`；429/5xx 遵守 `Retry-After`（含 `0`），否则指数退避重试 3 次；令牌桶限流默认 3 req/s。
- `lookbackDays`（默认 30 天）之外的旧条目跳过；**截止时间无法解析的条目一律保留**（宁可多给一条，也不静默丢）。
- 作业请求带 `include[]=submission`，用来读你自己的提交状态（只保留 `workflow_state / submitted_at / graded_at / excused` 四个字段，避免把整个 submission 塞进快照）。这几个字段**不参与内容哈希**：它们变了不会触发 AI 重评，只会触发完成对账。

### 邮箱（默认关闭，可选）
- **IMAP**：`993` SSL + 账号密码，读 `folders`（默认 `INBOX`）中 `lookbackDays` 内的邮件。登录后会按 **RFC 2971 发一条 `ID`** 通报客户端身份——网易邮箱（163 / 126 / yeah.net）不发这条就会被 `SELECT` 拒掉（`NO SELECT Unsafe Login`），所以这是必需的；服务器不认 `ID` 回 `BAD` 时会被忽略，不影响其他邮箱。网易需要先在网页端开启 IMAP 服务，密码栏填 **16 位授权码**而不是登录密码。
- **Microsoft Graph**：仅支持 **client credentials**（应用权限），需要 `tenantId` / `clientId` / `clientSecret` / `user`；**不支持**授权码或设备码登录。
- 可选 `senderDomains` 白名单（留空表示全部收件）。
- 邮件的标题、摘要、课程、截止时间**由 AI 从主题和正文前若干字符推断**——邮箱本身没有结构化的截止时间。所以要用邮箱来源，务必先配好 AI。
- **取信失败不会拖死整轮拉取**：批量 FETCH 断连时先**重连一次**再整批重试；仍失败才退化为逐封尝试，且**连续 3 封失败**或邮箱部分累计超过 **120 秒**就提前结束邮箱来源——只在结果里留一条汇总警告（`邮箱连接不可用，本次邮箱拉取提前结束（已跳过 N 封，还剩 M 封未取）` / `邮箱响应太慢…`），Canvas 那半边照常写库。163 这类邮箱把连接掐掉时，过去会一封封各等满 30 秒超时（真机上卡了十几分钟），现在 3 封就收兵。

## 3. 评分怎么算

- **规则评分**（本地、离线、永远先跑）：从文本里提取截止时间，按锚点给紧急度，再按关键词（考试、论文、项目、演示、报名、硬性门槛…）给重要度。完全不联网。Canvas 的截止时间由源直接给出，规则评分只做规范化。
- **关键词按词边界匹配**：英文关键词不再是「包含即命中」——`latest` 不再命中 `test`、`non-final year` 不再命中 `final`；而 `exam` / `test` 这类词还要看**语境**：只有出现在**申请资格**里的（`eligibility criteria` / `requirements` / `HKDSE` / `TOEFL` / `public exams` / `at least level N`…）不算考试——学校奖学金公告里的「HKDSE English Language Exam」过去被当成「考试/测验类」抬到重要度 4，现在不会了；标题里命中一定算，正文里命中才要过语境；`final` 只在 `final exam/test/quiz/paper/project/report/presentation/assessment` 这种搭配里算考试（`final grade` 说的是成绩）。
- **AI 评分**（`ai.enabled`，默认关）：只对**发生变更**的素材调用一次；模型给出的原始 `score` 会被丢弃并由本插件按公式重算：

  ```
  score = clamp(urgency × 10 + importance × 8, 0, 100)
  ```

  紧急度锚点：`0` 无截止或 30 天以后 → `1` 14 天内 → `2` 7 天内 → `3` 3 天内 → `4` 24 小时内 → `5` 今天截止或已逾期。
  重要度锚点：`0` 纯通知 → `1` 选修低权重 → `2` 一般作业 → `3` 占比 ≥10% 或期中 → `4` 占比 ≥20% 或期末/答辩 → `5` 硬性门槛。
  分类只允许 `assignment` / `activity` / `reminder`，标签只允许 `exam, paper, project, quiz, discussion, rule, deadline_change, group, reading, admin`（最多 5 个），越界一律丢弃。
- **内容判定会覆盖来源兜底**（公告与邮件；作业类仍以 Canvas 自己的数据为准）：先看正文再定类别与上限——「成绩已发布 / grades have been released / 答案已上传 / 无需操作」这类**信息型通知** → 提醒（重要度封顶 1）；报名/登记/招募 → 提醒；（活动 + 报名）→ 活动；讲座、研讨会、工作坊、比赛、锦标赛、招募 → 活动。「报名成功 / 已为您预留 / registration confirmed」→ 活动，重要度抬 1。命中上限时会**连同按关键词堆起来的理由一起丢掉**，不会出现「信息型公告」旁边还写着「考试/测验类」这种自相矛盾。
- **不计入总成绩的测验会降权**：`omit_from_final_grade: true` 或 `grading_type: not_graded`，以及**正文里写明**「不计入总成绩 / not counted in the final grade / for practice only」→ 重要度压到 **1**，不再按关键词里的 `quiz/exam` 抬分（成绩公告里的 `quiz` 同理），而且**不会**在「信息型通知」上留下 `exam` / `paper` 这种行动标签。**「0 分」不等于「不计入总成绩」**：0 分但命中硬性要求（`required` / `必修` / `必须完成`…）的条目——学校发的 0 分奖学金申请、必修表格——仍按硬性门槛算 5，只有「0 分且不构成硬性要求」才降权，理由也会分别写成「不计入总成绩」「素材里写明不计入总成绩」「无分值（0 分且非硬性要求）」。
- **截止时间怎么判**：邮件先剥掉转发头（发件人/发送时间/收件人/主题）、`>` 引用块和签名——转发头里的「发送时间」不是截止时间；只有紧挨着「截止 / 截止时间 / 到期 / 交 / 提交 / ddl / due / deadline / by / before / no later than」这类词的日期才算 **`deadline`**，没有截止词的日期退化成 **`event`**（活动时间，不算逾期）；早于收信/发布时间 12 小时以上的日期直接丢弃（`dropped`）。
- **判定版本**：库里的 `assess_revision` 记录判定逻辑版本，本版是 **`2`**。升级后**下一轮拉取会把素材整体重算一次**——窗口里抓到的**全部**素材（即使哈希没变，这一轮才允许调用 AI）**加上**回看窗口之外的老素材（由 `snapshots` 表还原，`raw_json` 不存正文），否则像「30 天前发布的成绩公告」这种永远走不到窗口里、也就永远修不掉。之后恢复「没变更就不调 AI」。
- **AI 不许推翻内容判定**：素材里写着「成绩已发布 / 不计入总成绩」这类事实时，规则给出的分类与降级后的重要度会**上锁**——AI 可以继续往下调，但不能把它抬回「活动 / 重要 4」（真机实测：`Quiz 3 Grades` 被规则判成「提醒 / 重要 1」，模型看到标题里的 Quiz 又抬了回去，用户投诉的就是这个）。锁只在规则**确实按内容降过级**时生效，普通条目的分类与重要度照旧由 AI 定。
- **AI 输出预算**：默认 `maxOutputTokens: 8000` / `batchSize: 6`，而且**批次会自动缩**——按 `(maxOutputTokens - 1024) / 1200` 反推一个批最多塞几条。原因是 `deepseek-flash` / `deepseek-reasoner` 这类**推理模型**会先花 token 写 `reasoning_content`：给 4000 预算、塞 15 条素材时 4000 token 全被思考吃光，`finish_reason=length` 且 `content` 是空的，整批判定白跑。现在遇到这种截断会**自动对半拆批重试**（单条还失败才报错并明确提示「调大 `ai.maxOutputTokens` 或调小 `ai.batchSize`」），并且只有**真的解析出 JSON** 的素材才算处理过（写进快照）；解析失败的下轮还会再试。
- AI 与规则都可用时：AI 的返回值只在**字段非空**时覆盖规则结果，但「内容判定锁」与 `due_at` 护栏除外（`due_at` 另有一套规则：AI 说「没有截止时间」就能清掉规则从转发头里误抓的日期，反过来 AI 编的时间若早于收信时间会被丢掉，Canvas 自己给的截止时间永远不许改）。AI 挂了整轮降级为规则结果，不会因为没有 AI 就不出任务。
- **批次并发**：`ai.concurrency`（默认 **2**，可调 1–4）决定同时发几个批次。批次之间互不依赖，而推理模型单批常要几十秒——串行 3 批就是三倍等待。默认 2 是"明显更快"与"别把上游打限流"之间的折中；上游限流严格就调到 1，想再快就调到 3–4。
- **两个源并发抓取**：Canvas 与邮箱的网络阶段**同时**跑（各自带自己的限流桶），写库仍按顺序串行。过去是「Canvas 拉完再拉邮箱」，两段延迟直接相加；现在总时长≈较慢的那一个。想让 Canvas 段更快，可以把 `canvas.requestsPerSecond`（默认 3）提到 6–8。

## 4. 安装

前置：**DSH Desktop 已安装并跑过一次**（这样 `%APPDATA%\DSH Desktop\` 下已有 runtime 命令）；本插件要求 DSH `>=0.1.5-rc.1`、Node `>=22.5`（用 DSH Desktop 自带的 Node 24 即可）。

在**外部终端**（不是 DSH 内的终端）执行：

```bat
git clone https://github.com/Jacky720real/dsh-canvas-task-monitor.git
cd dsh-canvas-task-monitor\install
rollback.bat          :: 仅当该 profile 里还留着上一版插件的快照时才需要
apply.bat -DryRun     :: 只打印计划，不写任何文件
apply.bat             :: 真正安装
```

脚本里**没有任何写死的路径**：插件目录由脚本自身位置推出（`install\` 的上一级就是包根），profile 由 `%DSH_HOME%`（没设就用 `%USERPROFILE%\.dsh`）下的 `profiles\desktop` 推出 —— 没有 `desktop` 就取那个唯一的、带 `package.json` 的 profile。想手动指定就加 `-ProfileDir <路径>` / `-PluginDir <路径>`（例如 `apply.bat -DryRun -ProfileDir D:\some\.dsh\profiles\work`）。

然后**重启 DSH Desktop**。左上侧边栏「插件」下面会多一行「待办」（这一行的右端是未完成数量），点它切到整页清单。

> **从旧版（Python bridge 那一版）迁移**：两版包名相同（`dsh-canvas-task-monitor`）、loader id 也相同（`canvas-task-monitor`），所以不用手工清理——先 `rollback.bat` 把旧版从 profile 里摘掉（它会用旧版自己留下的快照还原 profile），再按上面的 `apply.bat -DryRun` → `apply.bat` 装新版即可。顺序不能反：profile 里已有旧版痕迹时，apply 会以「部分存在、拒绝猜测」或「快照已存在」为由拒绝执行。

脚本做什么（三处改动，可完整回滚）：

1. 把 `dsh-canvas-task-monitor` 以 `link:` 形式加进 profile 的 `dependencies`；
2. 把 `dsh-canvas-task-monitor` 追加到 `dsh.profile.bundles`；
3. 别的什么都不动——**loader 条目写在插件包自己的 `cordis.patch.yml` 里**（由 `dsh.bundle.patch` 声明，DSH 会为 bundle 每一层加载它），profile 的 `cordis.patch.yml` 保持逐字节不变。

安装细节：
- 必须用 **DSH 自带的 pnpm**（脚本会找到 Desktop runtime shim 并把它插到 `PATH` 最前，同时显式传 `--config.minimumReleaseAge=0`）。用别的 pnpm（例如 corepack 装的更新版本）会因为「包太新」被供应链策略拒绝，或把 lockfile 改写成其它格式。
- 执行安装前会先把 4 个 profile 文件备份到 `<profile>\.dsh-ctm-snapshot\`（含 `snapshot.json` 记录本次的依赖值 / 插件目录）。**有这个快照在时 apply 会拒绝二次安装**，这是刻意的。
- 状态是「三处全在」或「三处全不在」，**部分存在时脚本拒绝猜测**（不会糊一个半成品 profile 出来）。

### 卸载

```bat
cd <你克隆下来的仓库>\install
rollback.bat
```

逐个字节还原那 4 个文件、重新安装依赖以清掉链接，确认四处痕迹（依赖项 / bundles 条目 / `node_modules` 链接 / 快照）全部消失后才删除快照。**你的任务数据不会被删**（数据在插件数据目录里，见下）。想连数据一起清掉：关掉 DSH Desktop，直接删掉数据目录即可；宿主半区也留了 `reset_data` action 给界面调用（当前设置页还没有对应按钮）。

## 5. 配置与数据

**数据目录**（优先级从高到低）：

1. 环境变量 `CTM_DATA_DIR`
2. 配置里的 `dataDir`
3. `<DSH_HOME>\canvas-task-monitor`（即 `C:\Users\<你>\.dsh\canvas-task-monitor`）

里面有 `config.json`（配置，原子写入）和 `tasks.db`（SQLite，WAL 模式）。

**推荐用界面配**：左上侧边栏「待办」→ 设置页，四组（Canvas / 邮箱 / AI / 拉取与评分），三个「测试连接」按钮分别验 Canvas、邮箱、AI。密钥字段留空表示不修改（输入框里是占位字 `已保存（留空表示不修改）`，字段名旁边还会挂一个 `已保存` 小标）——**看起来是空的并不代表值丢了**，值仍在 `config.json` 里，保存时会原样沿用。

「测试连接」测的是**眼前表单里的值**（没保存也带上；留空的密钥字段沿用盘上的真值）——所以换了授权码可以直接点测试，不必先保存。它的日志也会**脱敏**：IMAP 的 `LOGIN` 只留命令名（`IMAP → a1 LOGIN ***`），账号与授权码不会写进宿主日志（`%APPDATA%\DSH Desktop\logs\host\*.log`）。

设置页顶部会写明「已读取配置：<路径>」（真读的是哪一份文件）以及宿主的配置体检结果；宿主万一没交出配置内容，页面会直接报出来并**禁用保存**，绝不会拿空表单把磁盘上的值覆盖掉。

也可以直接编辑 `config.json`。注意 `dataDir` 只在 loader 配置里生效（本插件默认不写 loader config），所以想换目录请用环境变量 `CTM_DATA_DIR`：

```json
{
  "version": 1,
  "canvas": {
    "enabled": true,
    "baseUrl": "https://canvas.example.edu",
    "token": "在这里填 Canvas 访问令牌",
    "lookbackDays": 30,
    "timeoutMs": 20000,
    "maxAttempts": 3,
    "requestsPerSecond": 3
  },
  "mail": {
    "enabled": false,
    "provider": "imap",
    "host": "imap.example.com",
    "port": 993,
    "user": "you@example.com",
    "password": "",
    "folders": ["INBOX"],
    "lookbackDays": 14,
    "tenantId": "",
    "clientId": "",
    "clientSecret": "",
    "senderDomains": []
  },
  "ai": {
    "enabled": false,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "",
    "model": "deepseek-chat",
    "temperature": 0.1,
    "maxOutputTokens": 8000,
    "timeoutMs": 60000,
    "batchSize": 6,
    "concurrency": 2
  },
  "poll": { "autoPull": true, "intervalSeconds": 600 },
  "scoring": { "urgencyWeight": 10, "importanceWeight": 8 }
}
```

- `ai.baseUrl` 要写到 `/v1` 这一层（插件会请求 `{baseUrl}/chat/completions`），任何 OpenAI 兼容端点都行。
- `ai.maxOutputTokens` / `ai.batchSize`：**推理模型（`deepseek-flash`、`deepseek-reasoner`）请保持默认的 8000 / 6 或更保守**——思考过程也算在 `max_tokens` 里，预算太小时会一个字都吐不出来。批次还会按预算自动再缩，配置的 `batchSize` 只是上限。
- 没配 `ai.enabled` 也能用：规则评分不需要网络。
- `poll.autoPull` + `intervalSeconds` 控制后台定时拉取（最小 30 秒）。

## 6. 界面行为

- **筛选条**：四个 chip 切换类别（全部 / 作业 / 活动 / 提醒），选中态是半透明的主题色，不抢视线；是否混入已完成任务由「显示已完成」开关单独控制。
- **来源小标签**：卡片元信息最前面是「Canvas」（绿调）或「邮箱」（金调）小标签，鼠标悬停显示「来源：…」；文字色走主题变量，深浅色主题都可读。
- **手动拉取**：右上角「拉取」按钮立刻跑一轮；正在跑时会拒绝重复触发。跑完在清单顶部留一行结果：「更新 3 条，自动完成 2 条，转为参加 1 条，AI 判定 4 次（1 条提示）」，出错时这一行是红的。
- **完成 / 撤销**：勾选立刻写库；撤销条 8 秒后消失，面板卸载时也会清理定时器。自动勾掉的任务会在详情的「完成方式：」里说明是谁勾的（`Canvas 已提交` / `邮件确认报名成功`）。
- **统计**：顶部显示总数、逾期、今日截止、最高紧急度。
- **左上「待办」导航行**：行本身（按钮、文字、行高、点击）由 shell 渲染，我们只提供图标；标签固定「待办」，**行的右端**（原来那个小圆坨的位置）挂一个数量胶囊，也就是 `（图标） 待办 … 59`：未完成数超过 99 写 `99+`，一个都没有时整个胶囊不渲染。胶囊用的是**主题中性色**（不是状态红），装了 `dsh-plugin-wallpaper-engine` 并开了「侧栏液态玻璃」时，它会读该插件的全局玻璃令牌（`--we-sidebar-color / --we-sidebar-tint / --we-sidebar-blur / --we-sidebar-saturate / --we-sidebar-sheen`）做半透明磨砂 + 一圈内描边高光，数字就在胶囊里面；没装壁纸插件时保持扁平外观。折叠态那一行只有 36×36、文字被 shell 藏起来，胶囊自动退回贴在图标右上角。
- **显示已完成**：开关切换是否把已完成任务混在列表里。

## 7. 架构

```
dsh-canvas-task-monitor/
├─ package.json          # dsh.bundle.patch / dsh.client.inject 声明
├─ cordis.patch.yml      # bundle loader 行（id: canvas-task-monitor）
├─ lib/
│  ├─ index.js           # 宿主半区：配置、SQLite、同源 HTTP 路由 /canvas-task-monitor/api
│  ├─ client.js          # 浏览器半区：整页 + 左上「待办」导航行图标（见 §1）
│  ├─ config.js          # 配置默认值 / 归一化 / 原子保存 / 密钥掩码
│  ├─ store.js           # node:sqlite 存储层（四张表，UPSERT 不碰 status）
│  ├─ canvas.js          # Canvas 连接器（分页 / 限流 / 重试 / 回看窗口）
│  ├─ mail.js            # 邮箱连接器（IMAP + Graph，MIME 解码）
│  ├─ llm.js             # OpenAI 兼容 chat/completions（重试 / 清洗 / 禁 score）
│  ├─ pipeline.js        # 一轮拉取：变更检测 → 评分 → 完成对账 → 写库 → 写快照
│  ├─ scoring.js         # 规则评分：截止/活动时间判定 + 内容分类 + 关键词重要度 + 排序
│  ├─ version.js         # 版本号的唯一来源（面板 status 与 IMAP 的 ID 命令共用）
│  └─ util.js            # 时间 / 哈希 / 字符串工具
├─ install/              # apply.bat|ps1、rollback.bat|ps1（幂等，可回滚）
└─ test/                 # 七套自测夹具（见下）
```

宿主半区在 DSH 的 `webServer` 上注册**前缀路由** `/canvas-task-monitor/api`，浏览器半区用 `POST {action, params}` 调用；action 是白名单（`status`、`summarize_pending`、`list_tasks`、`get_task`、`mark_task`、`poll_now`、`get_config`、`save_config`、`test_source`、`reset_data`），并且只接受**同源**请求。

## 8. 自测

```bat
cd <你克隆下来的仓库>
node test\manifest-check.mjs    :: 发布清单：DSH 读包的方式（dsh.client / exports["./client"] / bundle 行 / 自包含承诺）
node test\host-check.mjs       :: 宿主半区：配置 / 存储不变量 / 评分 / AI 清洗 / 路由 / 同源围栏
node test\canvas-check.mjs     :: Canvas 连接器：分页 / 限流 / 重试 / 回看窗口
node test\client-check.mjs     :: 浏览器半区：渲染与交互（react 由夹具桩接）
node test\mail-check.mjs       :: 邮箱连接器：IMAP（含 RFC 2971 ID）/ Graph / MIME
node test\sources-check.mjs    :: 来源工厂与纯函数
node test\cordis-check.mjs     :: 真 cordis 集成：注入 / 挂路由 / 同源围栏 / 拆解（找不到 DSH 自带的 cordis 就跳过）
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File test\selftest.ps1
                               :: 安装机器：快照 / 幂等 / 拒绝部分状态 / 残留链接 / 链接身份 / 空依赖表 / 默认路径 / 逐字节回滚
```

所有夹具都是**离线**的（假 HTTP 服务器、假 socket、假的 pnpm / dsh），不联网、不写真实 profile。

当前项数：`manifest-check` 48 / `host-check` 72 / `canvas-check` 77 / `client-check` 139 / `mail-check` 158 / `sources-check` 126 / `cordis-check` 21（找不到真 cordis 就 SKIP），`selftest.ps1` 129 项。全部 `failed: 0`。

本版这四条判定修正（转发头时间不是截止时间、分类按内容、不计入总成绩降权、每轮完成对账）**每条都做过伪造对照**：把修复逐项回退到旧行为后，对应断言必须变红——例如关掉「变更门禁之外的完成对账」就报 `pipeline: 只有提交状态变了（哈希不变）也会自动勾掉 → 期望 1，实际 0`；不剥转发头就报 `转发头的发送时间不得成为截止时间：2026-09-25T06:11:00.000Z`；关掉内容分类就报 `期望 "reminder"，实际 "activity"`；关掉降权就报 `期望 1，实际 4`；客户端丢掉 `due_kind` 则三条活动渲染断言一起变红。改这些逻辑前请先跑一遍这套对照。

真机 E2E 又抓到四个夹具没覆盖的坑，现在各有专属断言：**推理模型吃光输出预算**（`llm: 输出被推理吃光时自动拆小批重试，而不是整批放弃` / `llm: 单条素材也被吃光时不再无脑重试，提示怎么调` / `llm: 批次大小按输出预算反推` / `llm: 返回的不是合法 JSON 时不算 settled`）、**关键词子串误命中**（`scoring: 词边界 —— latest 不命中 test、non-final 不命中 final`、`scoring: 申请资格里的 exam/test 不算考试（奖学金公告实测）`）、**正文写明不计分**（`scoring: 素材里写明"不计入总成绩"也要降权`，且必修 + 不计分仍算硬性门槛）、**窗口外的老素材重算**（`pipeline: 判定版本升级时，已经落在窗口外的老素材也会重算`：往 `snapshots` 里塞一条 30 天前的成绩公告 + 一条升级前的旧判定，同时窗口里**还有一条新公告**，跑一轮后老素材必须变成 `reminder` / 重要度 1 / 去掉 `exam` 标签，而「更新」只算新公告那 1 条、「重算」算 2 条）。最后那条的"同时还有一条新公告"是**真机踩出来的**：重算原本写成「这一轮一条变更都没有时才做」，于是 Canvas 只要有一条新公告，窗口外那条老素材就被整个漏掉（`stats.rescored` 只报了邮件那 3 条，`Quiz 3 Grades` 一动不动）。**内容判定锁**也钉住了：`pipeline: 内容判定的降级不接受 AI 抬回去（成绩公告 / 不计分）`，AI 想把「提醒 / 1」改成「活动 / 4」必须失败，同时普通条目仍允许 AI 调整。伪造对照里 `EXAM_COLLOCATION_RE` 一度含 `grades?`，于是 `not counted in your final grade` 被判成考试——夹具当场报 `只有 final grade 不算考试 期望 false，实际 true`，这个坑已经钉住。

用**真 token + 真库副本**（绝不碰真库）跑完整两轮 E2E 后，四条修正在真数据上确认：`Quiz 3 Grades`（30 天前发布、早已滑出回看窗口）从「活动 / 重要 4 / `exam`」变成「提醒 / 重要 0」，模型想抬回去时被内容判定锁挡住；转发过来的篮球招募邮件 `due_at` 从转发头的 `2026-09-25T06:11:00.000Z` 变成 `null`，不再标「已逾期」；`WebWork_1` 与 `Preliminary (for practice only)` 正文里的「Not counted in the final grade」把它们压到重要度 1；两条奖学金公告（`HKDSE English Language Exam` / `public exams`）从重要度 4 掉到 1；8 条已提交作业被自动勾掉（`完成方式: Canvas 已提交`），第二轮状态保持稳定、不重复勾。整体重算一轮 63 条素材约 199 秒、32 次 AI 请求。

`test\client-check.mjs` 的假宿主**照抄真宿主的载荷形状**（`get_config` 回的是 `{ config, dataDir, configPath, configExists, problems }` 这个包装对象），`test\host-check.mjs` 那边还有一条断言把包装对象的键钉死。两边都钉住是有原因的：设置页曾经把包装对象当成配置本身，于是所有字段（学校地址、邮箱账号、模型名…）都渲染成空，看着就像"配置丢了"——而假夹具当时回的是裸配置，所以夹具全绿、真机全空。改夹具之前先改契约，别让夹具比真宿主更宽松。

`test\mail-check.mjs` 里同一个教训的第二次现身：夹具过去总是自己传一个 `logger`，而宿主点「测试连接」走的是 `testSource(config, source)` → `testMail(config)`，**根本不传 options**，少传的 `logger` 让一句调试日志把整次 IMAP 连接打崩成 `Cannot read properties of undefined (reading 'debug')`。现在既有"不传 logger 也能连上"、也有"`logger=null` / 字符串降级成静默"、"函数型 logger 的 `.debug` 仍被调用"这几条，保证不是靠整体静音换来的不崩。

`test\selftest.ps1` 还额外覆盖三件真机上踩过的事：包装完之后 pnpm **不会**替你删掉 `node_modules\<包名>` 里指向旧目录的符号链接（rollback 自己摘）、`node_modules` 里的条目**必须**解析到本包（指向别的包时 apply 拒绝而不是静默放行）、以及 `"dependencies": {}` 这种全新 profile 的空属性表不会把脚本打崩（`Set-StrictMode -Version Latest` 下的成员枚举会抛 `PropertyNotFoundStrict`）。

安装机器夹具是**可移植**的：仓库根由脚本自身位置推出，临时目录取系统 `TEMP`，找不到真实 profile（`$env:DSH_HOME`，否则 `~\.dsh`）时就**合成**一份最小 profile（`dependencies` 为空、`cordis.patch.yml` 带一条 `modlens`），所以在没装 DSH 的机器上跑同一份脚本结果一致（129 项）。其中 T20 专门盯**别人的机器**：不传 `-ProfileDir`，只给一个 `DSH_HOME`，验证默认解析到 `profiles\desktop`（没有就退化为唯一的那个 profile），并且不留下任何快照；T21 则走**真实入口** `apply.bat` / `rollback.bat`（不传 `-PluginDir`），因为 Windows PowerShell 在**参数默认值**求值时还没有自动变量（`$PSScriptRoot` 此刻为空）——这个坑只有从 `.bat` 进来才会踩到，直接调 `.ps1` 且显式传 `-PluginDir` 的所有用例都发现不了。

`cordis-check.mjs` 是唯一会用真实依赖的夹具：它加载 DSH 自带的 `@deepseek-ai/cordis`，起一个真插件宿主并把宿主半区装进去，然后用真 `http.Server` 打一遍同源围栏与 action 白名单。cordis 的查找顺序是：环境变量 `CTM_CORDIS`（指向它的 `lib/index.js`）→ `<DSH_HOME>\profiles\node_modules\@deepseek-ai\cordis\lib\index.js` → 常见的 `DSH Desktop\resources\app\node_modules\...`；都没有就打印 `SKIP` 并以 0 退出。

## 9. 已知限制

- **邮箱来源依赖 AI**：没有确定性的截止时间解析；同一个邮箱换 `provider`（imap ↔ graph）会重新建一遍任务，因为 `external_id` 前缀不同。
- **Graph 只支持应用权限**（client credentials），不支持用户登录授权。
- **IMAP 是明文 `LOGIN` + 993 SSL**，没有 XOAUTH2（登录后按 RFC 2971 发一条 `ID`，网易系必需）。
- **不会自动清理消失的条目**：Canvas 上被删掉的作业/公告不会从列表里消失。**但会做完成对账**：作业/测验只要 Canvas 那边显示你已提交（或已评分、或该作业本就不需要提交）就保持勾掉，你自己手动取消过的不会被再勾回去。
- **完成对账是单向的**：插件只会因为你「交了」而勾掉任务，不会因为你「没交」而替你取消勾选（取消由你自己做，且手动取消会被尊重——`status_source='user'` 之后自动对账不再动它）。
- **邮箱任务 ↔ Canvas 的配对是保守的**：拿标题算字符二元组相似度（Dice），**≥ 0.5** 才当作同一条，两边都有截止时间且相似度不到 0.72 时还要求日期差 ≤ 3 天；而且**只有 Canvas 侧确实是"已完成"（已提交/已评分，或库里那条 Canvas 作业本来就是 done）才会勾**——没交、配不上、你自己取消过的，一个字都不动。证据不足时宁可留着（哪怕顶着"逾期"），也不乱勾。
- **`omit_from_final_grade` / `grading_type` / `submission` 不在内容哈希白名单里**：老师事后改「是否计入总成绩」不会触发 AI 重评（提交状态会触发完成对账，改分值不会）。想立刻整体重算，删掉库里 `meta` 表的 `assess_revision` 那一行（下一轮会连快照里的窗口外老素材一起重算），或等下一个判定版本升级。
- **邮箱卡住时只拉一部分**：批量取信断连会先重连一次，仍失败则逐封回退，**连续 3 封失败或邮箱部分超过 120 秒就提前结束邮箱来源**（结果里只有一条汇总警告，剩下的邮件等下一次拉取）。这是刻意取舍——坏邮箱不能把整轮拉取挟持住；真机上它曾让一次拉取卡十几分钟。
- **公告按课程逐门请求**：`N` 门课会产生 `2N+1` 条请求链，课程多时首轮会慢一些。
- **不剥 HTML**：公告正文原样保存（只在给 AI 之前做最小清理）；**邮件**正文在判定前会剥掉转发头、`>` 引用块与签名。
- **报名确认的配对是启发式的**：用确认信与旧任务的共享词（≥2 个，或一个 ≥4 字母的英文强词出现在旧任务标题里）锁定要升级的那条报名提醒，配不上就不动——宁可不动，也不乱改。
- **AI 失败即降级**：整批 AI 失败时该轮不写快照，下一轮自动重试（不会丢素材，但也不会硬失败）。被推理截断的批会先自动拆小重试，只有连单条都失败才整批放弃；拆批会让请求次数变多（面板上的「AI 判定 N 次」是**实际请求次数**，不是素材条数）。

## 10. 许可

MIT，见 `LICENSE`。
