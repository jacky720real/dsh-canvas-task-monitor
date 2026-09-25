# dsh-canvas-task-monitor

把 **Canvas LMS**（可选：**邮箱**）里的作业、公告、通知抓成一份可执行的待办清单，直接显示在 **DeepSeek Harness Desktop** 的侧边栏里。

> 1.0 是**完全自包含**的插件：不依赖 Python、不依赖 sidecar 进程、不依赖任何 npm 运行时依赖（数据库用 Node 24 自带的 `node:sqlite`）。装一个包，重启 DSH Desktop，侧边栏就多一行「任务」。

```
Canvas / 邮箱 ──► 变更检测 ──► 规则评分（可选 AI 兜底）──► SQLite ──► DSH 侧边栏「任务」
```

---

## 1. 功能

| 区域 | 说明 |
| --- | --- |
| 侧边栏导航行 | 左侧栏新增一行「任务」，带未完成数量角标 |
| 主区域整页 | 完整任务清单：筛选条（全部 / 作业 / 活动 / 提醒）、「显示已完成」开关、手动「拉取」、统计、设置页 |
| 左下角快捷角标 | 常驻小按钮，点开即看最近任务，不必切页面 |

- **两级排序**：有截止时间的按截止时间**从近到远**排在前面；没有截止时间的按**重要程度**降序排在后面。
- **不显示裸分数**：列表只给「紧急 / 重要 / 已逾期」这类文字徽标，具体的 0–100 分值只在详情里可见，避免被数字牵着走。
- **勾选完成可撤销**：误点完成会弹 8 秒撤销条，窗口内点「撤销」即可还原；过了就真的完成。
- **无变更绝不调用 AI**：内容哈希没变就整轮跳过，省 token 也省时间。
- **状态归你**：你的「完成/未完成」不会被下一次拉取覆盖（数据库 UPSERT 刻意不写 `status`）。

## 2. 任务从哪来

### Canvas（默认启用）
- 走官方 REST API：`/api/v1/courses`（只取 active 选课）→ 每门课的 assignments + announcements。
- 作业的 `external_id` 形如 `course:<courseId>:assignment:<id>`，公告形如 `course:<courseId>:announcement:<id>`：同一门课改了名字也不会重复建任务。
- 分页只认 `Link: rel="next"`；429/5xx 遵守 `Retry-After`（含 `0`），否则指数退避重试 3 次；令牌桶限流默认 3 req/s。
- `lookbackDays`（默认 30 天）之外的旧条目跳过；**截止时间无法解析的条目一律保留**（宁可多给一条，也不静默丢）。

### 邮箱（默认关闭，可选）
- **IMAP**：`993` SSL + 账号密码，读 `folders`（默认 `INBOX`）中 `lookbackDays` 内的邮件。
- **Microsoft Graph**：仅支持 **client credentials**（应用权限），需要 `tenantId` / `clientId` / `clientSecret` / `user`；**不支持**授权码或设备码登录。
- 可选 `senderDomains` 白名单（留空表示全部收件）。
- 邮件的标题、摘要、课程、截止时间**由 AI 从主题和正文前若干字符推断**——邮箱本身没有结构化的截止时间。所以要用邮箱来源，务必先配好 AI。

## 3. 评分怎么算

- **规则评分**（本地、离线、永远先跑）：从文本里提取截止时间，按锚点给紧急度，再按关键词（考试、论文、项目、演示、报名、硬性门槛…）给重要度。完全不联网。Canvas 的截止时间由源直接给出，规则评分只做规范化。
- **AI 评分**（`ai.enabled`，默认关）：只对**发生变更**的素材调用一次；模型给出的原始 `score` 会被丢弃并由本插件按公式重算：

  ```
  score = clamp(urgency × 10 + importance × 8, 0, 100)
  ```

  紧急度锚点：`0` 无截止或 30 天以后 → `1` 14 天内 → `2` 7 天内 → `3` 3 天内 → `4` 24 小时内 → `5` 今天截止或已逾期。
  重要度锚点：`0` 纯通知 → `1` 选修低权重 → `2` 一般作业 → `3` 占比 ≥10% 或期中 → `4` 占比 ≥20% 或期末/答辩 → `5` 硬性门槛。
  分类只允许 `assignment` / `activity` / `reminder`，标签只允许 `exam, paper, project, quiz, discussion, rule, deadline_change, group, reading, admin`（最多 5 个），越界一律丢弃。
- AI 与规则都可用时：AI 的返回值只在**字段非空**时覆盖规则结果，AI 挂了整轮降级为规则结果，不会因为没有 AI 就不出任务。

## 4. 安装

前置：**DSH Desktop 已安装并跑过一次**（这样 `%APPDATA%\DSH Desktop\` 下已有 runtime 命令）；本插件要求 DSH `>=0.1.5-rc.1`、Node `>=22.5`（用 DSH Desktop 自带的 Node 24 即可）。

在**外部终端**（不是 DSH 内的终端）执行：

```bat
cd <你克隆下来的仓库>\install
rollback.bat          :: 仅当该 profile 里还留着上一版插件的快照时才需要
apply.bat -DryRun     :: 只打印计划，不写任何文件
apply.bat             :: 真正安装
```

脚本里**没有任何写死的路径**：插件目录由脚本自身位置推出（`install\` 的上一级就是包根），profile 由 `%DSH_HOME%`（没设就用 `%USERPROFILE%\.dsh`）下的 `profiles\desktop` 推出 —— 没有 `desktop` 就取那个唯一的、带 `package.json` 的 profile。想手动指定就加 `-ProfileDir <路径>` / `-PluginDir <路径>`（例如 `apply.bat -DryRun -ProfileDir D:\some\.dsh\profiles\work`）。

然后**重启 DSH Desktop**。左侧栏应出现「任务」一行，左下角出现角标。

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

**推荐用界面配**：侧边栏「任务」→ 设置页，四组（Canvas / 邮箱 / AI / 拉取与评分），三个「测试连接」按钮分别验 Canvas、邮箱、AI。密钥字段留空表示不修改（回显 `已保存（留空表示不修改）`）。

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
    "maxOutputTokens": 4000,
    "timeoutMs": 60000,
    "batchSize": 15
  },
  "poll": { "autoPull": true, "intervalSeconds": 600 },
  "scoring": { "urgencyWeight": 10, "importanceWeight": 8 }
}
```

- `ai.baseUrl` 要写到 `/v1` 这一层（插件会请求 `{baseUrl}/chat/completions`），任何 OpenAI 兼容端点都行。
- 没配 `ai.enabled` 也能用：规则评分不需要网络。
- `poll.autoPull` + `intervalSeconds` 控制后台定时拉取（最小 30 秒）。

## 6. 界面行为

- **筛选条**：四个 chip 切换类别（全部 / 作业 / 活动 / 提醒），选中态是半透明的主题色，不抢视线；是否混入已完成任务由「显示已完成」开关单独控制。
- **手动拉取**：右上角「拉取」按钮立刻跑一轮；正在跑时会拒绝重复触发。
- **完成 / 撤销**：勾选立刻写库；撤销条 8 秒后消失，面板卸载时也会清理定时器。
- **统计**：顶部显示总数、逾期、今日截止、最高紧急度。
- **显示已完成**：开关切换是否把已完成任务混在列表里。

## 7. 架构

```
dsh-canvas-task-monitor/
├─ package.json          # dsh.bundle.patch / dsh.client.inject 声明
├─ cordis.patch.yml      # bundle loader 行（id: canvas-task-monitor）
├─ lib/
│  ├─ index.js           # 宿主半区：配置、SQLite、同源 HTTP 路由 /canvas-task-monitor/api
│  ├─ client.js          # 浏览器半区：侧边栏行 + 整页 + 左下角角标
│  ├─ config.js          # 配置默认值 / 归一化 / 原子保存 / 密钥掩码
│  ├─ store.js           # node:sqlite 存储层（四张表，UPSERT 不碰 status）
│  ├─ canvas.js          # Canvas 连接器（分页 / 限流 / 重试 / 回看窗口）
│  ├─ mail.js            # 邮箱连接器（IMAP + Graph，MIME 解码）
│  ├─ llm.js             # OpenAI 兼容 chat/completions（重试 / 清洗 / 禁 score）
│  ├─ pipeline.js        # 一轮拉取：变更检测 → 评分 → 写库 → 写快照
│  ├─ scoring.js         # 规则评分：截止时间提取 + 关键词重要度 + 排序
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
node test\mail-check.mjs       :: 邮箱连接器：IMAP / Graph / MIME
node test\sources-check.mjs    :: 来源工厂与纯函数
node test\cordis-check.mjs     :: 真 cordis 集成：注入 / 挂路由 / 同源围栏 / 拆解（找不到 DSH 自带的 cordis 就跳过）
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File test\selftest.ps1
                               :: 安装机器：快照 / 幂等 / 拒绝部分状态 / 残留链接 / 链接身份 / 空依赖表 / 默认路径 / 逐字节回滚
```

所有夹具都是**离线**的（假 HTTP 服务器、假 socket、假的 pnpm / dsh），不联网、不写真实 profile。

`test\selftest.ps1` 还额外覆盖三件真机上踩过的事：包装完之后 pnpm **不会**替你删掉 `node_modules\<包名>` 里指向旧目录的符号链接（rollback 自己摘）、`node_modules` 里的条目**必须**解析到本包（指向别的包时 apply 拒绝而不是静默放行）、以及 `"dependencies": {}` 这种全新 profile 的空属性表不会把脚本打崩（`Set-StrictMode -Version Latest` 下的成员枚举会抛 `PropertyNotFoundStrict`）。

安装机器夹具是**可移植**的：仓库根由 `$PSScriptRoot` 推出，临时目录取系统 `TEMP`，找不到真实 profile（`$env:DSH_HOME`，否则 `~\.dsh`）时就**合成**一份最小 profile（`dependencies` 为空、`cordis.patch.yml` 带一条 `modlens`），所以在没装 DSH 的机器上跑同一份脚本结果一致（122 项）。其中 T20 专门盯**别人的机器**：不传 `-ProfileDir`，只给一个 `DSH_HOME`，验证默认解析到 `profiles\desktop`（没有就退化为唯一的那个 profile），并且不留下任何快照。

`cordis-check.mjs` 是唯一会用真实依赖的夹具：它加载 DSH 自带的 `@deepseek-ai/cordis`，起一个真插件宿主并把宿主半区装进去，然后用真 `http.Server` 打一遍同源围栏与 action 白名单。cordis 的查找顺序是：环境变量 `CTM_CORDIS`（指向它的 `lib/index.js`）→ `<DSH_HOME>\profiles\node_modules\@deepseek-ai\cordis\lib\index.js` → 常见的 `DSH Desktop\resources\app\node_modules\...`；都没有就打印 `SKIP` 并以 0 退出。

## 9. 已知限制

- **邮箱来源依赖 AI**：没有确定性的截止时间解析；同一个邮箱换 `provider`（imap ↔ graph）会重新建一遍任务，因为 `external_id` 前缀不同。
- **Graph 只支持应用权限**（client credentials），不支持用户登录授权。
- **IMAP 是明文 `LOGIN` + 993 SSL**，没有 XOAUTH2。
- **不会自动清理消失的条目**：Canvas 上被删掉的作业/公告不会从列表里消失，也不会被自动标记完成（需要你自己勾选）。
- **公告按课程逐门请求**：`N` 门课会产生 `2N+1` 条请求链，课程多时首轮会慢一些。
- **不剥 HTML**：公告正文原样保存（只在给 AI 之前做最小清理）。
- **AI 失败即降级**：整批 AI 失败时该轮不写快照，下一轮自动重试（不会丢素材，但也不会硬失败）。

## 10. 许可

MIT，见 `LICENSE`。
