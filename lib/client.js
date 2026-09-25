/**
 * dsh-canvas-task-monitor — DSH 插件浏览器半区
 * ---------------------------------------------------------------------------
 * 三个注册点：
 *   1. `sidebar.panellist`  —— 侧边栏导航行（行本身由 sidebar 渲染，这里只给图标）
 *   2. `main` (key = 同一个 id) —— 行被点击后显示的主区域整页面板
 *   3. `sidebar.footer.action` —— 左下角带待办数量的快捷按钮
 *
 * 数据全部走同源路由 `/canvas-task-monitor/api`（宿主半区 lib/index.js 自己处理：
 * 读取插件自己的配置、拉取 Canvas/邮箱、评分、写自己的 SQLite），不做任何跨源 fetch，
 * 也没有任何子进程 / Python 依赖。
 *
 * 面板内共有两个视图，共用同一份插件内 store：
 *   - `list`    任务清单（筛选 / 排序 / 勾选 / 撤销 toast）
 *   - `settings` 设置页（Canvas / 邮箱 / AI / 拉取 四组配置 + 连接测试）
 *
 * 注意：这是宿主用 `new Function` 之外、直接执行的普通 JS 文件（无 JSX、无 TS），
 * 必须自己包在 `window.__ModuleLoader__.load({...})` 里并 `return module.exports`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-canvas-task-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------ 常量 */

    const PANEL_ID = 'canvas-task-monitor';
    const API_PATH = '/canvas-task-monitor/api';
    const STYLE_MARKER = 'canvas-task-monitor';
    const CATEGORY_LABEL = { assignment: '作业', activity: '活动', reminder: '提醒' };
    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'assignment', label: '作业' },
      { id: 'activity', label: '活动' },
      { id: 'reminder', label: '提醒' },
    ];

    /** 宿主对“已保存的密文”统一用这个字面量占位，绝不把真密钥发到浏览器。 */
    const SAVED = '__SAVED__';
    const SAVED_PLACEHOLDER = '已保存（留空表示不修改）';
    /** 撤销 toast 的存活时间。 */
    const TOAST_MS = 8_000;

    const SETTINGS_SECTIONS = [
      {
        id: 'canvas',
        title: 'Canvas 数据源',
        source: 'canvas',
        fields: [
          { key: 'canvas.enabled', label: '启用', type: 'checkbox' },
          { key: 'canvas.baseUrl', label: 'Canvas 地址', type: 'text', placeholder: 'https://your-school.instructure.com' },
          { key: 'canvas.token', label: '访问令牌', type: 'secret' },
          { key: 'canvas.lookbackDays', label: '回看天数', type: 'number' },
        ],
      },
      {
        id: 'mail',
        title: '邮箱数据源',
        source: 'mail',
        fields: [
          { key: 'mail.enabled', label: '启用', type: 'checkbox' },
          {
            key: 'mail.provider',
            label: '协议',
            type: 'select',
            options: [
              { value: 'imap', label: 'IMAP' },
              { value: 'graph', label: 'Microsoft Graph' },
            ],
          },
          { key: 'mail.host', label: '邮件服务器', type: 'text' },
          { key: 'mail.port', label: '端口', type: 'number' },
          { key: 'mail.user', label: '账号', type: 'text' },
          { key: 'mail.password', label: '密码', type: 'secret' },
          { key: 'mail.folders', label: '文件夹', type: 'list', placeholder: 'INBOX, Notifications' },
          { key: 'mail.lookbackDays', label: '回看天数', type: 'number' },
          { key: 'mail.tenantId', label: 'Tenant ID', type: 'text' },
          { key: 'mail.clientId', label: 'Client ID', type: 'text' },
          { key: 'mail.clientSecret', label: 'Client Secret', type: 'secret' },
        ],
      },
      {
        id: 'ai',
        title: 'AI 评分',
        source: 'ai',
        fields: [
          { key: 'ai.enabled', label: '启用', type: 'checkbox' },
          { key: 'ai.baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
          { key: 'ai.apiKey', label: 'API Key', type: 'secret' },
          { key: 'ai.model', label: '模型', type: 'text' },
          { key: 'ai.maxOutputTokens', label: '最大输出 Token', type: 'number' },
        ],
      },
      {
        id: 'poll',
        title: '拉取',
        source: null,
        fields: [
          { key: 'poll.autoPull', label: '自动拉取', type: 'checkbox' },
          { key: 'poll.intervalSeconds', label: '间隔秒数', type: 'number' },
        ],
      },
    ];

    /* -------------------------------------------------------- 数据通路 */

    async function api(action, params) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params: params ?? {} }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null || typeof payload !== 'object') throw new Error(`HTTP ${response.status}（响应不是 JSON）`);
      if (payload.ok !== true) throw new Error(typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : `HTTP ${response.status}`);
      return payload.data;
    }

    function messageOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }

    /* ------------------------------------------------- 插件内共享状态 */

    const store = {
      value: {
        /* 清单 */
        loaded: false,
        loading: false,
        pulling: false,
        error: null,
        summary: null,
        tasks: [],
        updatedAt: 0,
        status: null,
        /* 撤销 toast */
        toast: null,
        /* 视图切换 */
        view: 'list',
        /* 设置页 */
        config: null,
        /* 宿主 get_config / save_config 另外返回的元信息（dataDir / configPath / configExists / problems）。 */
        configMeta: null,
        /* 只有成功读到过一次配置，才允许保存，避免用空表单把磁盘上的值覆盖成空。 */
        configLoaded: false,
        configLoading: false,
        configSaving: false,
        configError: null,
        form: {},
        saveMsg: null,
        testing: null,
        tests: {},
      },
      listeners: new Set(),
      set(patch) {
        store.value = { ...store.value, ...patch };
        for (const listener of [...store.listeners]) {
          try {
            listener();
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
    };

    function useStore() {
      const [value, setValue] = React.useState(store.value);
      React.useEffect(() => store.subscribe(() => setValue(store.value)), []);
      return value;
    }

    async function refresh() {
      if (store.value.loading) return;
      store.set({ loading: true });
      try {
        const [summary, tasks, status] = await Promise.all([
          api('summarize_pending'),
          api('list_tasks', { limit: 500 }),
          // status 只是锦上添花：拿不到也不能让整个面板报错。
          api('status').catch(() => null),
        ]);
        store.set({
          loaded: true,
          loading: false,
          error: null,
          summary: summary ?? null,
          tasks: Array.isArray(tasks) ? tasks : [],
          status: status !== null && typeof status === 'object' ? status : null,
          updatedAt: Date.now(),
        });
      } catch (error) {
        store.set({ loaded: true, loading: false, error: messageOf(error) });
      }
    }

    async function pull() {
      if (store.value.pulling || store.value.loading) return;
      store.set({ pulling: true, error: null });
      try {
        await api('poll_now');
        store.set({ pulling: false });
        await refresh();
      } catch (error) {
        store.set({ pulling: false, error: messageOf(error) });
      }
    }

    /* ------------------------------------------------------ 撤销 toast */

    let toastTimer = null;
    let toastSeq = 0;

    function clearToastTimer() {
      if (toastTimer !== null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
    }

    /** 新 toast 顶掉旧 toast，同时重置 8 秒计时。 */
    function showToast(taskId, title) {
      clearToastTimer();
      toastSeq += 1;
      const id = toastSeq;
      store.set({ toast: { id, taskId, title } });
      toastTimer = setTimeout(() => {
        toastTimer = null;
        const current = store.value.toast;
        if (current !== null && current.id === id) store.set({ toast: null });
      }, TOAST_MS);
      toastTimer.unref?.();
    }

    function dismissToastFor(taskId) {
      const current = store.value.toast;
      if (current !== null && current.taskId === taskId) {
        clearToastTimer();
        store.set({ toast: null });
      }
    }

    /* -------------------------------------------------------- 任务操作 */

    async function markTask(taskId, done) {
      // 乐观更新：先把本地状态翻过去，界面立刻有反应。
      store.set({ tasks: store.value.tasks.map((item) => (item.id === taskId ? { ...item, status: done ? 'done' : 'pending' } : item)) });
      try {
        await api('mark_task', { task_id: taskId, done });
        await refresh();
      } catch (error) {
        store.set({ error: messageOf(error) });
        await refresh();
      }
    }

    async function toggle(task) {
      if (task === null || typeof task !== 'object') return;
      const done = task.status !== 'done';
      if (done) {
        const title = typeof task.title === 'string' && task.title.length > 0 ? task.title : '(无标题)';
        showToast(task.id, title);
      } else {
        // 点已完成那一行把它恢复回来时，旧 toast 已经没有意义了。
        dismissToastFor(task.id);
      }
      await markTask(task.id, done);
    }

    /** toast 上的「撤销」：把刚勾掉的那条改回未完成。 */
    async function undoDone() {
      const current = store.value.toast;
      if (current === null || typeof current !== 'object') return;
      clearToastTimer();
      store.set({ toast: null });
      await markTask(current.taskId, false);
    }

    /* -------------------------------------------------------- 设置页 */

    function getPath(root, keys) {
      let cursor = root;
      for (const key of keys) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = cursor[key];
      }
      return cursor;
    }

    function setPath(root, keys, value) {
      if (!Array.isArray(keys) || keys.length === 0) return;
      let cursor = root;
      for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index];
        if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = value;
    }

    /** config -> 表单草稿。密文字段保持 `__SAVED__` 字面量，渲染时再变成空输入框。 */
    function buildForm(config) {
      const source = config !== null && typeof config === 'object' ? config : {};
      const form = {};
      for (const section of SETTINGS_SECTIONS) {
        for (const field of section.fields) {
          const raw = getPath(source, field.key.split('.'));
          if (field.type === 'checkbox') {
            form[field.key] = raw === true;
            continue;
          }
          if (field.type === 'number') {
            if (typeof raw === 'number' && Number.isFinite(raw)) form[field.key] = String(raw);
            else if (typeof raw === 'string' && raw.length > 0) form[field.key] = raw;
            else form[field.key] = '';
            continue;
          }
          if (field.type === 'list') {
            form[field.key] = Array.isArray(raw) ? raw.map((entry) => String(entry)).join(', ') : typeof raw === 'string' ? raw : '';
            continue;
          }
          form[field.key] = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
        }
      }
      return form;
    }

    function setField(key, value) {
      const form = { ...(store.value.form !== null && typeof store.value.form === 'object' ? store.value.form : {}) };
      form[key] = value;
      store.set({ form, saveMsg: null });
    }

    /** 这份对象看起来像不像一份配置（而不是宿主的包装壳）。 */
    function looksLikeConfig(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      return ['canvas', 'mail', 'ai', 'poll'].some((key) => value[key] !== null && typeof value[key] === 'object');
    }

    async function loadConfig() {
      if (store.value.configLoading) return;
      store.set({ configLoading: true, configError: null });
      try {
        /* 宿主 get_config 的 data 是 { config, dataDir, configPath, configExists, problems }：
           表单只认里面那份纯配置。少拆这一层，所有字段都会渲染成空（看着像“配置丢了”）。
           宿主万一换回裸配置也认；两样都不是就必须拒绝，绝不能拿空表单把磁盘上的值覆盖成空。 */
        const data = await api('get_config');
        const payload = data !== null && typeof data === 'object' ? data : {};
        const bare = looksLikeConfig(payload.config) ? payload.config : looksLikeConfig(payload) ? payload : null;
        if (bare === null) {
          store.set({ configLoading: false, config: null, configMeta: payload, configLoaded: false, configError: '宿主没有返回可用的配置内容，为避免写空值，已停用保存' });
          return;
        }
        store.set({ configLoading: false, config: bare, configMeta: payload, configLoaded: true, form: buildForm(bare), saveMsg: null, tests: {} });
      } catch (error) {
        store.set({ configLoading: false, configError: messageOf(error) });
      }
    }

    function openSettings() {
      store.set({ view: 'settings' });
      if (store.value.config === null) loadConfig();
    }

    function closeSettings() {
      store.set({ view: 'list' });
    }

    async function saveConfig() {
      const base = store.value.config;
      if (store.value.configLoaded !== true || base === null || typeof base !== 'object') {
        store.set({ saveMsg: { tone: 'error', text: '配置还没读取完，为避免写空值，请稍候再保存' } });
        return;
      }
      let draft;
      try {
        draft = JSON.parse(JSON.stringify(base));
      } catch {
        draft = {};
      }
      if (draft === null || typeof draft !== 'object') draft = {};
      const form = store.value.form !== null && typeof store.value.form === 'object' ? store.value.form : {};

      for (const section of SETTINGS_SECTIONS) {
        for (const field of section.fields) {
          const path = field.key.split('.');
          const raw = form[field.key];
          if (field.type === 'secret') {
            // 留空 -> 保留 base 里的 __SAVED__（或原值），也就是“不修改”。
            if (typeof raw === 'string' && raw.length > 0) setPath(draft, path, raw);
            continue;
          }
          if (field.type === 'checkbox') {
            setPath(draft, path, raw === true);
            continue;
          }
          if (field.type === 'number') {
            if (typeof raw === 'string' && raw.trim().length > 0) {
              const parsed = Number(raw);
              setPath(draft, path, Number.isFinite(parsed) ? parsed : raw);
            }
            continue;
          }
          if (field.type === 'list') {
            setPath(
              draft,
              path,
              typeof raw === 'string'
                ? raw
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0)
                : [],
            );
            continue;
          }
          setPath(draft, path, typeof raw === 'string' ? raw : '');
        }
      }

      store.set({ configSaving: true, saveMsg: null });
      try {
        const result = await api('save_config', { config: draft });
        const payload = result !== null && typeof result === 'object' ? result : {};
        const saved = payload.config !== null && typeof payload.config === 'object' ? payload.config : draft;
        const previous = store.value.configMeta !== null && typeof store.value.configMeta === 'object' ? store.value.configMeta : {};
        const meta = { ...previous };
        if (typeof payload.configPath === 'string') meta.configPath = payload.configPath;
        if (Array.isArray(payload.problems)) meta.problems = payload.problems;
        if (typeof payload.configExists === 'boolean') meta.configExists = payload.configExists;
        store.set({ configSaving: false, config: saved, configMeta: meta, configLoaded: true, form: buildForm(saved), saveMsg: { tone: 'ok', text: '已保存' } });
      } catch (error) {
        store.set({ configSaving: false, saveMsg: { tone: 'error', text: messageOf(error) } });
      }
    }

    async function testSource(source) {
      if (store.value.testing !== null) return;
      store.set({ testing: source });
      const tests = { ...(store.value.tests !== null && typeof store.value.tests === 'object' ? store.value.tests : {}) };
      try {
        const result = await api('test_source', { source });
        const payload = result !== null && typeof result === 'object' ? result : {};
        const ok = payload.ok === true;
        tests[source] = {
          ok,
          message: typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : ok ? '连接成功' : '连接失败',
          detail: typeof payload.detail === 'string' ? payload.detail : '',
        };
      } catch (error) {
        tests[source] = { ok: false, message: messageOf(error), detail: '' };
      }
      store.set({ testing: null, tests });
    }

    /* ------------------------------------------------------------ 工具 */

    function numOf(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function dueInfo(dueAt) {
      if (typeof dueAt !== 'string' || dueAt.length === 0) return null;
      const time = Date.parse(dueAt);
      if (Number.isNaN(time)) return { text: dueAt, tone: 'normal' };
      const now = Date.now();
      if (time < now) return { text: '已逾期', tone: 'overdue' };
      const days = Math.floor((time - now) / 86_400_000);
      if (days === 0) return { text: '今天截止', tone: 'soon' };
      if (days === 1) return { text: '明天截止', tone: 'soon' };
      if (days <= 7) return { text: `${days} 天后截止`, tone: 'soon' };
      const date = new Date(time);
      return { text: `${date.getMonth() + 1}月${date.getDate()}日（${days} 天后）`, tone: 'normal' };
    }

    function formatDue(dueAt) {
      if (typeof dueAt !== 'string' || dueAt.length === 0) return '';
      const time = Date.parse(dueAt);
      if (Number.isNaN(time)) return dueAt;
      try {
        return new Date(time).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return dueAt;
      }
    }

    function dueTimeOf(task) {
      if (task === null || typeof task !== 'object') return null;
      const raw = task.due_at;
      if (typeof raw !== 'string' || raw.length === 0) return null;
      const time = Date.parse(raw);
      return Number.isNaN(time) ? null : time;
    }

    /**
     * 客户端排序：先按截止时间，时间排完的按重要程度。
     *   - 有可解析 due_at 的排前面，按时间升序（最早 / 最逾期优先）；
     *     同一时刻按 importance 降序、再按 urgency 降序。
     *   - 没有 due_at（或解析不出来）的排在所有带时间行之后，
     *     按 importance 降序 -> urgency 降序 -> score 降序 -> id 升序。
     */
    function sortTasks(rows) {
      const list = Array.isArray(rows) ? rows.slice() : [];
      const desc = (task, key) => -numOf(task === null || typeof task !== 'object' ? undefined : task[key], 0);
      const asc = (task, key) => numOf(task === null || typeof task !== 'object' ? undefined : task[key], 0);
      return list.sort((left, right) => {
        const a = dueTimeOf(left);
        const b = dueTimeOf(right);
        if (a !== null && b !== null) {
          if (a !== b) return a - b;
          if (desc(left, 'importance') !== desc(right, 'importance')) return desc(left, 'importance') - desc(right, 'importance');
          return desc(left, 'urgency') - desc(right, 'urgency');
        }
        if (a !== null) return -1;
        if (b !== null) return 1;
        if (desc(left, 'importance') !== desc(right, 'importance')) return desc(left, 'importance') - desc(right, 'importance');
        if (desc(left, 'urgency') !== desc(right, 'urgency')) return desc(left, 'urgency') - desc(right, 'urgency');
        if (desc(left, 'score') !== desc(right, 'score')) return desc(left, 'score') - desc(right, 'score');
        return asc(left, 'id') - asc(right, 'id');
      });
    }

    function pendingOf(state) {
      const summary = state.summary;
      if (summary === null || typeof summary !== 'object') return null;
      return typeof summary.total === 'number' ? summary.total : null;
    }

    /** 宿主还没建数据目录 / 配置文件 —— 面板要指路到设置按钮，而不是显示空列表。 */
    function needsSetup(state) {
      const status = state.status;
      if (status === null || typeof status !== 'object') return false;
      const hasDataDir = typeof status.dataDir === 'string' && status.dataDir.length > 0;
      const hasConfigPath = typeof status.configPath === 'string' && status.configPath.length > 0;
      return !hasDataDir || !hasConfigPath;
    }

    /* ------------------------------------------------------------ 样式 */

    const CSS = `
[data-slot="sidebar.footer.action"] { display: flex !important; flex-direction: column; width: 100%; }

.ctm-badge { display:flex; align-items:center; gap:8px; width:100%; min-height:42px; padding:0 10px;
  border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary,#2A2A28);
  font:inherit; font-size:13px; cursor:pointer; }
.ctm-badge:hover { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); }
.ctm-badge-glyph { display:flex; align-items:center; justify-content:center; width:18px; height:18px; flex:none; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-badge-text { flex:1 1 auto; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ctm-badge-count { flex:none; min-width:20px; padding:0 6px; border-radius:9px; background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08));
  color:var(--dsw-alias-label-secondary,#6E6A63); font-size:11px; line-height:18px; text-align:center; font-variant-numeric:tabular-nums; }
.ctm-badge-count[data-tone="hot"] { background:var(--dsw-alias-state-error-primary,#B4462F); color:#fff; }
.ctm-badge-count[data-tone="error"] { background:var(--dsw-alias-state-error-primary,#B4462F); color:#fff; }
.ctm-badge[data-collapsed="true"] { justify-content:center; padding:0; }
.ctm-badge[data-collapsed="true"] .ctm-badge-text, .ctm-badge[data-collapsed="true"] .ctm-badge-count { display:none; }

.ctm-root { display:flex; flex-direction:column; height:100%; min-height:0; box-sizing:border-box;
  background:var(--dsw-alias-bg-base,#FAF9F6); color:var(--dsw-alias-label-primary,#2A2A28);
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
.ctm-head { flex:none; padding:20px 24px 12px; border-bottom:1px solid var(--dsw-alias-border-l2,#EDEAE3); }
.ctm-head-row { display:flex; align-items:center; gap:12px; }
.ctm-title { margin:0; font-size:18px; font-weight:600; letter-spacing:.2px; }
.ctm-spacer { flex:1 1 auto; }
.ctm-stats { margin-top:6px; font-size:12px; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-stats b { font-weight:600; color:var(--dsw-alias-label-primary,#2A2A28); font-variant-numeric:tabular-nums; }
.ctm-btn { display:inline-flex; align-items:center; gap:6px; padding:5px 11px; border-radius:7px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#EDEAE3); background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#2A2A28); font:inherit; font-size:12px; white-space:nowrap; }
.ctm-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.ctm-btn:disabled { opacity:.5; cursor:default; }
.ctm-filters { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
.ctm-chip { padding:3px 12px; border-radius:999px; cursor:pointer; font-size:12px; line-height:20px;
  border:1px solid var(--dsw-alias-border-l2,#EDEAE3); background:transparent; color:var(--dsw-alias-label-primary,#2A2A28); font-family:inherit; }
/* 选中态用半透明底色：不透明色在浅色主题下会变成“白底白字”。 */
.ctm-chip[data-active="true"] {
  background: rgba(42,42,40,.10);
  border-color: rgba(42,42,40,.30);
  background: color-mix(in srgb, var(--dsw-alias-label-primary,#2A2A28) 14%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary,#2A2A28) 38%, transparent);
  color: var(--dsw-alias-label-primary,#2A2A28);
}
.ctm-toggle { margin-left:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px;
  color:var(--dsw-alias-label-secondary,#6E6A63); cursor:pointer; user-select:none; }

.ctm-banner { flex:none; margin:12px 24px 0; padding:9px 12px; border-radius:8px; font-size:12px; line-height:1.6;
  background:var(--dsw-alias-bg-layer-2,rgba(212,168,67,.12)); border-left:3px solid #D4A843; color:var(--dsw-alias-label-primary,#2A2A28); white-space:pre-wrap; }
.ctm-banner[data-tone="error"] { background:rgba(180,70,47,.10); border-left-color:#B4462F; }
.ctm-banner[data-tone="warn"] { background:rgba(212,168,67,.12); border-left-color:#D4A843; }

.ctm-body { flex:1 1 auto; min-height:0; overflow-y:auto; padding:14px 24px 28px; }
.ctm-empty { padding:48px 0; text-align:center; font-size:13px; color:var(--dsw-alias-label-tertiary,#8C877E); }
.ctm-setup { padding:32px 0; text-align:center; font-size:13px; line-height:2; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-setup b { color:var(--dsw-alias-label-primary,#2A2A28); font-weight:600; }

.ctm-card { display:flex; gap:12px; padding:12px 14px; margin-bottom:8px; border-radius:10px; cursor:pointer;
  background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#F1EEE8); border-left-width:3px; }
.ctm-card:hover { border-color:var(--dsw-alias-border-l2,#E3DED4); }
.ctm-card[data-cat="assignment"] { border-left-color:#4C8C5A; }
.ctm-card[data-cat="activity"] { border-left-color:#C79A3A; }
.ctm-card[data-cat="reminder"] { border-left-color:#7A8699; }
.ctm-card[data-done="true"] { opacity:.55; }
.ctm-card[data-done="true"] .ctm-card-title { text-decoration:line-through; }

.ctm-check { flex:none; width:20px; height:20px; margin-top:1px; padding:0; border-radius:6px; cursor:pointer;
  border:1.5px solid var(--dsw-alias-border-l3,#CFC8BA); background:transparent; color:transparent;
  font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; }
.ctm-check[data-done="true"] { background:var(--dsw-alias-label-primary,#2A2A28); border-color:var(--dsw-alias-label-primary,#2A2A28); color:var(--dsw-alias-bg-base,#fff); }
.ctm-main { flex:1 1 auto; min-width:0; }
.ctm-line { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.ctm-card-title { flex:1 1 auto; margin:0; font-size:14px; font-weight:600; line-height:1.45; }
.ctm-flags { flex:none; display:inline-flex; align-items:center; gap:5px; }
.ctm-flag { padding:1px 8px; border-radius:999px; font-size:11px; line-height:17px; font-weight:600; white-space:nowrap; }
.ctm-flag[data-tone="urgent"] { background:rgba(180,70,47,.14); color:#B4462F; }
.ctm-flag[data-tone="overdue"] { background:rgba(180,70,47,.14); color:#B4462F; }
.ctm-flag[data-tone="important"] { background:rgba(199,154,58,.18); color:#9A7522; }
.ctm-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:5px; font-size:12px; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-tag { padding:1px 7px; border-radius:4px; background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); font-size:11px; }
.ctm-due[data-tone="overdue"] { color:#B4462F; font-weight:600; }
.ctm-due[data-tone="soon"] { color:#9A7522; font-weight:600; }
.ctm-detail { margin-top:9px; padding-top:9px; border-top:1px dashed var(--dsw-alias-border-l2,#EDEAE3);
  font-size:12px; line-height:1.7; color:var(--dsw-alias-label-secondary,#6E6A63); white-space:pre-wrap; }
.ctm-detail b { color:var(--dsw-alias-label-primary,#2A2A28); font-weight:600; }

.ctm-toast { flex:none; display:flex; align-items:center; gap:12px; margin:0 24px 10px; padding:9px 12px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); border:1px solid var(--dsw-alias-border-l2,#EDEAE3);
  font-size:12px; color:var(--dsw-alias-label-primary,#2A2A28); }
.ctm-toast-text { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ctm-toast-undo { flex:none; padding:3px 12px; border-radius:6px; cursor:pointer; font:inherit; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,#EDEAE3); background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#2A2A28); }
.ctm-toast-undo:hover { background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08)); }

.ctm-foot { flex:none; padding:8px 24px 12px; font-size:11px; color:var(--dsw-alias-label-tertiary,#8C877E);
  border-top:1px solid var(--dsw-alias-border-l1,#F1EEE8); display:flex; gap:10px; align-items:center; }
.ctm-spin { display:inline-block; width:11px; height:11px; border:1.5px solid currentColor; border-top-color:transparent;
  border-radius:50%; animation:ctm-spin .8s linear infinite; }
@keyframes ctm-spin { to { transform: rotate(360deg); } }

/* -------------------------------------------------------------- 设置页 */
.ctm-set-head { flex:none; display:flex; align-items:center; gap:10px; padding:20px 24px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2,#EDEAE3); }
.ctm-set { flex:1 1 auto; min-height:0; overflow-y:auto; padding:16px 24px 28px; }
.ctm-group { margin-bottom:18px; padding-bottom:14px; border-bottom:1px solid var(--dsw-alias-border-l1,#F1EEE8); }
.ctm-group:last-of-type { border-bottom:0; }
.ctm-group-head { display:flex; align-items:center; gap:10px; margin-bottom:9px; }
.ctm-legend { margin:0; font-size:13px; font-weight:600; }
.ctm-row { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.ctm-row-label { flex:none; width:126px; font-size:12px; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-row-label .ctm-tag { margin-left:6px; }
.ctm-input { flex:1 1 auto; min-width:0; box-sizing:border-box; padding:5px 9px; border-radius:6px; font:inherit; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,#EDEAE3); background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#2A2A28); }
.ctm-input:disabled { opacity:.6; }
.ctm-check-inline { display:inline-flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }
.ctm-hint { display:block; margin:4px 0 6px; font-size:12px; line-height:1.6; white-space:pre-wrap; color:var(--dsw-alias-label-secondary,#6E6A63); }
.ctm-hint[data-tone="ok"] { color:#4C8C5A; }
.ctm-hint[data-tone="error"] { color:#B4462F; }
.ctm-note { font-size:12px; line-height:1.9; color:var(--dsw-alias-label-secondary,#6E6A63); word-break:break-all; }
.ctm-note code { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--dsw-alias-label-primary,#2A2A28); }
`;

    function installStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-dsh-plugin="${STYLE_MARKER}"]`) !== null) return;
      const style = document.createElement('style');
      style.setAttribute('data-dsh-plugin', STYLE_MARKER);
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------ 图标 */

    function glyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M9 5h9' }),
        h('path', { d: 'M9 12h9' }),
        h('path', { d: 'M9 19h9' }),
        h('path', { d: 'M4 5l1.2 1.2L7.5 3.8' }),
        h('path', { d: 'M4 12l1.2 1.2L7.5 10.8' }),
        h('path', { d: 'M4 19l1.2 1.2L7.5 17.8' }),
      );
    }

    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      return glyph(size);
    }

    /* ------------------------------------------------------ 左下角角标 */

    function FooterBadge(props) {
      const state = useStore();
      const collapsed = props?.wide === false;
      const total = pendingOf(state);
      const tone = state.error !== null ? 'error' : total !== null && total > 0 ? 'hot' : 'plain';
      const label = total === null ? '任务' : `待办 ${total}`;
      return h(
        'button',
        {
          type: 'button',
          className: 'ctm-badge',
          'data-collapsed': collapsed ? 'true' : 'false',
          title: state.error !== null ? `Canvas 任务：${state.error}` : '打开 Canvas 任务面板',
          onClick: () => openPanel(),
        },
        h('span', { className: 'ctm-badge-glyph' }, glyph(collapsed ? 18 : 16)),
        h('span', { className: 'ctm-badge-text' }, label),
        state.error !== null
          ? h('span', { className: 'ctm-badge-count', 'data-tone': tone }, '!')
          : total !== null && total > 0
            ? h('span', { className: 'ctm-badge-count', 'data-tone': tone }, String(total))
            : null,
      );
    }

    /* ------------------------------------------------------- 任务卡片 */

    function TaskCard({ task, open, onToggle, onOpen }) {
      const done = task.status === 'done';
      const due = dueInfo(task.due_at);
      const overdue = due !== null && due.tone === 'overdue';

      /* 数值分数不上屏，只翻译成文字徽标。 */
      const flags = [];
      if (numOf(task.urgency, 0) >= 4) flags.push(h('span', { className: 'ctm-flag', 'data-tone': 'urgent', key: 'urgent' }, '紧急'));
      if (numOf(task.importance, 0) >= 4) flags.push(h('span', { className: 'ctm-flag', 'data-tone': 'important', key: 'important' }, '重要'));
      if (overdue) flags.push(h('span', { className: 'ctm-flag', 'data-tone': 'overdue', key: 'overdue' }, '已逾期'));

      const reasons = [];
      if (typeof task.summary === 'string' && task.summary.length > 0) reasons.push(h('div', { key: 's' }, task.summary));
      if (typeof task.urgency_reason === 'string' && task.urgency_reason.length > 0) reasons.push(h('div', { key: 'u' }, h('b', null, '紧迫理由：'), task.urgency_reason));
      if (typeof task.importance_reason === 'string' && task.importance_reason.length > 0) reasons.push(h('div', { key: 'i' }, h('b', null, '重要理由：'), task.importance_reason));
      const dueText = formatDue(task.due_at);
      if (dueText.length > 0) reasons.push(h('div', { key: 'd' }, h('b', null, '截止时间：'), dueText));

      const tags = Array.isArray(task.tags) ? task.tags : [];
      const categoryLabel = CATEGORY_LABEL[task.category] ?? (typeof task.category === 'string' ? task.category : '');

      return h(
        'article',
        {
          className: 'ctm-card',
          'data-cat': typeof task.category === 'string' ? task.category : 'unknown',
          'data-done': done ? 'true' : 'false',
          onClick: () => onOpen(open ? null : task.id),
        },
        h(
          'button',
          {
            type: 'button',
            className: 'ctm-check',
            'data-done': done ? 'true' : 'false',
            title: done ? '标记为未完成' : '标记为完成',
            'aria-label': done ? '标记为未完成' : '标记为完成',
            onClick: (event) => {
              event.stopPropagation();
              onToggle(task);
            },
          },
          '✓',
        ),
        h(
          'div',
          { className: 'ctm-main' },
          h(
            'div',
            { className: 'ctm-line' },
            h('h2', { className: 'ctm-card-title' }, typeof task.title === 'string' && task.title.length > 0 ? task.title : '(无标题)'),
            flags.length > 0 ? h('span', { className: 'ctm-flags' }, flags) : null,
          ),
          h(
            'div',
            { className: 'ctm-meta' },
            categoryLabel.length > 0 ? h('span', { className: 'ctm-tag' }, categoryLabel) : null,
            typeof task.course === 'string' && task.course.length > 0 ? h('span', null, task.course) : null,
            due !== null && !overdue ? h('span', { className: 'ctm-due', 'data-tone': due.tone }, `截止 ${due.text}`) : null,
            task.is_rule === true ? h('span', { className: 'ctm-tag' }, '规则') : null,
            tags.map((tag, index) => h('span', { className: 'ctm-tag', key: `t${index}` }, String(tag))),
          ),
          open && reasons.length > 0 ? h('div', { className: 'ctm-detail' }, reasons) : null,
        ),
      );
    }

    /* --------------------------------------------------------- 设置页 */

    function renderField(field, form) {
      const raw = form[field.key];
      /* 密文在表单里永远是 __SAVED__：输入框留空 + 标签旁显式标“已保存”，省得看着像配置丢了。 */
      const secretStored = field.type === 'secret' && raw === SAVED;
      if (field.type === 'checkbox') {
        return h(
          'div',
          { className: 'ctm-row', key: field.key },
          h(
            'label',
            { className: 'ctm-check-inline' },
            h('input', { type: 'checkbox', 'data-field': field.key, checked: raw === true, onChange: (event) => setField(field.key, event.target.checked === true) }),
            field.label,
          ),
        );
      }

      let control;
      if (field.type === 'select') {
        const options = Array.isArray(field.options) ? field.options : [];
        control = h(
          'select',
          { className: 'ctm-input', 'data-field': field.key, value: typeof raw === 'string' ? raw : '', onChange: (event) => setField(field.key, event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        );
      } else {
        const isSecret = field.type === 'secret';
        const stored = secretStored;
        control = h('input', {
          type: isSecret ? 'password' : field.type === 'number' ? 'number' : 'text',
          className: 'ctm-input',
          'data-field': field.key,
          value: typeof raw === 'string' && !stored ? raw : '',
          placeholder: isSecret && stored ? SAVED_PLACEHOLDER : typeof field.placeholder === 'string' ? field.placeholder : '',
          onChange: (event) => setField(field.key, event.target.value),
        });
      }

      return h(
        'div',
        { className: 'ctm-row', key: field.key },
        h(
          'span',
          { className: 'ctm-row-label' },
          field.label,
          secretStored ? h('span', { className: 'ctm-tag', 'data-role': 'secret-stored' }, '已保存') : null,
        ),
        control,
      );
    }

    function renderSettings(state) {
      const form = state.form !== null && typeof state.form === 'object' ? state.form : {};
      const status = state.status !== null && typeof state.status === 'object' ? state.status : {};
      const ready = state.config !== null && typeof state.config === 'object';
      const meta = state.configMeta !== null && typeof state.configMeta === 'object' ? state.configMeta : {};
      const problems = Array.isArray(meta.problems) ? meta.problems.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];

      const head = h(
        'header',
        { className: 'ctm-set-head' },
        h('h1', { className: 'ctm-title' }, '设置'),
        h('span', { className: 'ctm-spacer' }),
        state.saveMsg !== null && typeof state.saveMsg === 'object'
          ? h('span', { className: 'ctm-hint', 'data-tone': state.saveMsg.tone, 'data-role': 'save-msg' }, String(state.saveMsg.text ?? ''))
          : null,
        h(
          'button',
          { type: 'button', className: 'ctm-btn', 'data-role': 'save', disabled: state.configSaving === true || !ready, onClick: () => saveConfig() },
          state.configSaving === true ? '保存中…' : '保存',
        ),
        h('button', { type: 'button', className: 'ctm-btn', 'data-role': 'back', onClick: () => closeSettings() }, '返回'),
      );

      const groups = SETTINGS_SECTIONS.map((section) => {
        const tested = section.source !== null && state.tests !== null && typeof state.tests === 'object' ? state.tests[section.source] : null;
        return h(
          'section',
          { className: 'ctm-group', key: section.id },
          h(
            'div',
            { className: 'ctm-group-head' },
            h('h2', { className: 'ctm-legend' }, section.title),
            section.source !== null
              ? h(
                  'button',
                  { type: 'button', className: 'ctm-btn', 'data-test': section.source, disabled: state.testing !== null, onClick: () => testSource(section.source) },
                  state.testing === section.source ? '测试中…' : '测试连接',
                )
              : null,
          ),
          section.fields.map((field) => renderField(field, form)),
          tested !== null && tested !== undefined
            ? h(
                'div',
                { className: 'ctm-hint', 'data-tone': tested.ok === true ? 'ok' : 'error', 'data-test-msg': section.source },
                tested.detail ? `${tested.message}（${tested.detail}）` : String(tested.message),
              )
            : null,
        );
      });

      const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback);

      return h(
        'div',
        { className: 'ctm-root', 'data-view': 'settings' },
        head,
        h(
          'div',
          { className: 'ctm-set' },
          state.configLoading === true ? h('div', { className: 'ctm-empty' }, '正在读取配置…') : null,
          state.configError !== null ? h('div', { className: 'ctm-banner', 'data-tone': 'error' }, `读取配置失败：${state.configError}`) : null,
          ready
            ? h(
                'div',
                { className: 'ctm-hint', 'data-tone': 'ok', 'data-role': 'config-source' },
                `已读取配置：${text(meta.configPath, text(status.configPath, '（未创建）'))}${meta.configExists === false ? '（文件尚未创建，保存后生成）' : ''}`,
              )
            : null,
          problems.length > 0
            ? h('div', { className: 'ctm-banner', 'data-tone': 'warn', 'data-role': 'config-problems' }, `配置体检：${problems.join('；')}`)
            : null,
          ready ? groups : null,
          h(
            'div',
            { className: 'ctm-note' },
            h('div', null, '数据目录：', h('code', null, text(status.dataDir, '（未初始化）'))),
            h('div', null, '数据库：', h('code', null, text(status.dbPath, '（未创建）'))),
            h('div', null, '配置文件：', h('code', null, text(status.configPath, '（未创建）'))),
            h('div', null, '上次拉取：', h('code', null, text(status.lastPollAt, '（从未拉取）'))),
            h('div', null, '版本：', h('code', null, text(status.version, '—'))),
          ),
        ),
      );
    }

    /* -------------------------------------------------------- 主面板 */

    function TaskPanel() {
      const state = useStore();
      const [filter, setFilter] = React.useState('all');
      const [showDone, setShowDone] = React.useState(false);
      const [openId, setOpenId] = React.useState(null);

      React.useEffect(() => {
        if (!store.value.loaded && !store.value.loading) refresh();
        return () => {
          // 面板卸载后定时器不能再回调 setState。
          clearToastTimer();
        };
      }, []);

      if (state.view === 'settings') return renderSettings(state);

      const summary = state.summary !== null && typeof state.summary === 'object' ? state.summary : {};
      const allTasks = Array.isArray(state.tasks) ? state.tasks : [];
      const visible = allTasks.filter((task) => task !== null && typeof task === 'object' && (showDone || task.status !== 'done') && (filter === 'all' || task.category === filter));
      const rows = sortTasks(visible);
      const busy = state.loading || state.pulling;
      const setup = needsSetup(state);
      const toast = state.toast;

      const body = setup
        ? h(
            'div',
            { className: 'ctm-setup' },
            '尚未完成初始化：还没有数据目录 / 配置文件。',
            h('br'),
            '请点击右上角的 ',
            h('b', null, '设置'),
            ' 填写 Canvas 数据源后保存。',
          )
        : rows.length === 0
          ? h('div', { className: 'ctm-empty' }, state.loading && !state.loaded ? '正在读取…' : allTasks.length === 0 ? '暂无任务' : '没有符合条件的任务')
          : rows.map((task) => h(TaskCard, { key: String(task.id), task, open: openId === task.id, onToggle: toggle, onOpen: setOpenId }));

      return h(
        'div',
        { className: 'ctm-root', 'data-view': 'list' },
        h(
          'header',
          { className: 'ctm-head' },
          h(
            'div',
            { className: 'ctm-head-row' },
            h('h1', { className: 'ctm-title' }, '任务'),
            h('span', { className: 'ctm-spacer' }),
            h(
              'button',
              { type: 'button', className: 'ctm-btn', disabled: busy, onClick: () => refresh(), title: '重新读取本地快照' },
              state.loading && !state.pulling ? h('span', { className: 'ctm-spin' }) : null,
              '刷新',
            ),
            h(
              'button',
              { type: 'button', className: 'ctm-btn', disabled: busy, onClick: () => pull(), title: '拉取 Canvas / 邮件并重新抽取任务（可能需要 30–60 秒）' },
              state.pulling ? h('span', { className: 'ctm-spin' }) : null,
              '拉取',
            ),
            h('button', { type: 'button', className: 'ctm-btn', 'data-role': 'settings', onClick: () => openSettings(), title: '插件设置' }, '设置'),
          ),
          h(
            'div',
            { className: 'ctm-stats' },
            typeof summary.total === 'number'
              ? h(
                  'span',
                  null,
                  '待办 ',
                  h('b', null, String(summary.total)),
                  `  ·  作业 ${numOf(summary.assignment, 0)}  ·  活动 ${numOf(summary.activity, 0)}  ·  提醒 ${numOf(summary.reminder, 0)}`,
                  `  ·  已逾期 ${numOf(summary.overdue, 0)}  ·  今天截止 ${numOf(summary.dueToday, 0)}`,
                  typeof summary.max_urgency === 'number' ? `  ·  最高紧迫 ${summary.max_urgency}` : '',
                )
              : state.loaded
                ? h('span', null, '暂无摘要')
                : h('span', null, '正在读取…'),
          ),
          h(
            'div',
            { className: 'ctm-filters' },
            FILTERS.map((item) =>
              h(
                'button',
                { key: item.id, type: 'button', className: 'ctm-chip', 'data-active': filter === item.id ? 'true' : 'false', onClick: () => setFilter(item.id) },
                item.label,
              ),
            ),
            h(
              'label',
              { className: 'ctm-toggle' },
              h('input', { type: 'checkbox', 'data-role': 'show-done', checked: showDone, onChange: (event) => setShowDone(event.target.checked === true) }),
              '显示已完成',
            ),
          ),
        ),
        state.error !== null ? h('div', { className: 'ctm-banner', 'data-tone': 'error' }, `读取失败：${state.error}`) : null,
        h('div', { className: 'ctm-body' }, body),
        toast !== null && typeof toast === 'object'
          ? h(
              'div',
              { className: 'ctm-toast', 'data-role': 'toast' },
              h('span', { className: 'ctm-toast-text' }, `已标记完成：「${typeof toast.title === 'string' ? toast.title : '(无标题)'}」`),
              h('button', { type: 'button', className: 'ctm-toast-undo', 'data-role': 'undo', onClick: () => undoDone() }, '撤销'),
            )
          : null,
        h(
          'footer',
          { className: 'ctm-foot' },
          h('span', null, state.updatedAt > 0 ? `更新于 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN')}` : '尚未读取'),
          h('span', { className: 'ctm-spacer' }),
          h('span', null, '数据来自插件本地 SQLite'),
        ),
      );
    }

    /* ------------------------------------------------------------ 入口 */

    let pluginCtx = null;
    let warmupTimer = null;

    function openPanel() {
      try {
        const layout = typeof pluginCtx?.get === 'function' ? pluginCtx.get('layout') : undefined;
        if (layout !== null && typeof layout === 'object' && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
      } catch {
        /* 拿不到 layout 就只靠侧边栏导航行 */
      }
    }

    const inject = ['slots'];

    function apply(ctx) {
      pluginCtx = ctx;
      installStyles();
      const slots = ctx?.slots;
      if (slots === undefined || slots === null) {
        console.warn('[canvas-task-monitor] 客户端半区拿不到 slots 服务，界面不会注册');
        return;
      }

      // 1) 侧边栏导航行（行本身由 sidebar 渲染，这里只提供图标与 label）
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '任务' }, SidebarIcon),
      );
      // 2) 主区域整页面板 —— key 必须与上面的 id 一致，sidebar 才点得开
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, TaskPanel));
      // 3) 左下角带角标的快捷按钮
      slots.inject('sidebar.footer.action', () =>
        slots.register({ name: 'sidebar.footer.action', id: `${PANEL_ID}-badge`, order: 30 }, FooterBadge),
      );

      // 延迟预热：等 DSH 启动稳定后取一次摘要，让角标一开始就有数字。
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        refresh();
      }, 3_000);
      warmupTimer.unref?.();
    }

    exports.apply = apply;
    exports.inject = inject;
    // 排序是纯函数，单独导出便于测试与复用。
    exports.sortTasks = sortTasks;
    return module.exports;
  },
});
