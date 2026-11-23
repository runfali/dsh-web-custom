window.__ModuleLoader__.load({
  id: "dsh-web-custom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;
    // 官方表单原语（与官方 web-search / agent-loop 设置卡同一份实现）：
    // SettingsForm 负责只读提示 + 字段区 + 保存按钮，SettingsValueField 负责
    // 标签/覆盖胶囊/重置/输入框/hint。卡壳不再手写。
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---- minimal snapshot store (own implementation: zero extra imports) ----
    function createStore(init) {
      let state = init;
      const listeners = new Set();
      return {
        getSnapshot() { return state; },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set(next) { state = next; listeners.forEach((fn) => fn()); }
      };
    }

    // ---- card form model (own staging + revision-fenced scope writes) ----
    function textField(field) {
      return {
        field,
        format: (value) => typeof value === "string" ? value : "",
        parse: (text) => {
          const trimmed = text.trim();
          return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
        }
      };
    }
    function numberField(field) {
      return {
        field,
        format: (value) => typeof value === "number" ? String(value) : "",
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "") return { kind: "clear" };
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
        }
      };
    }
    function boolField(field) {
      return {
        field,
        format: (value) => value === true ? "true" : "",
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "true") return { kind: "set", value: true };
          if (trimmed === "") return { kind: "set", value: false };
          return undefined;
        }
      };
    }

    function CardForm(scope, specs) {
      this.scope = scope;
      this.specs = new Map();
      specs.forEach((spec) => { this.specs.set(spec.field, spec); });
      this.staged = new Map();
      this.listeners = new Set();
      this.saving = false;
      this.failed = false;
      const self = this;
      this._unsubscribe = scope.subscribe(() => { self.publish(); });
    }
    CardForm.prototype.bind = function (project) {
      const self = this;
      const store = createStore(project());
      this.listeners.add(() => { store.set(project()); });
      return store;
    };
    CardForm.prototype.shell = function () {
      const snapshot = this.scope.getSnapshot();
      const plan = this.plan();
      return {
        available: snapshot.status === "ready",
        writable: snapshot.writable === true,
        dirty: plan.length > 0,
        invalid: plan.some((item) => item.run === undefined),
        saving: this.saving,
        failed: this.failed
      };
    };
    CardForm.prototype.field = function (field) {
      const staged = this.staged.get(field);
      const spec = this.spec(field);
      if (staged === undefined) {
        return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false };
      }
      const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
      return {
        text: staged.text,
        overridden: write !== undefined && write.kind === "set",
        invalid: write === undefined
      };
    };
    CardForm.prototype.actions = function () {
      const self = this;
      return {
        edit: (field, text) => self.stage(field, { text, clear: false }),
        resetField: (field) => self.stage(field, { text: self.spec(field).format(self.baseValue(field)), clear: true }),
        save: () => self.save(),
        discard: () => {
          if (self.staged.size === 0 && !self.failed) return;
          self.staged.clear();
          self.failed = false;
          self.publish();
        }
      };
    };
    CardForm.prototype.save = async function () {
      const plan = this.plan();
      const writes = [];
      plan.forEach((item) => { if (item.run !== undefined) writes.push(item.run); });
      // 只读部署下不发起写入（官方 SettingsFormModel.save 同款守卫）。
      if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
      if (this.snapshotOf().writable === false) return;
      this.saving = true;
      this.failed = false;
      this.publish();
      let landed = true;
      for (let i = 0; i < writes.length; i += 1) {
        const ok = await writes[i]();
        if (!ok) landed = false;
      }
      if (landed) this.staged.clear();
      this.saving = false;
      this.failed = !landed;
      this.publish();
    };
    CardForm.prototype.plan = function () {
      const self = this;
      const plan = [];
      this.staged.forEach((staged, field) => {
        const spec = self.spec(field);
        if (staged.clear) {
          if (self.stored(field)) plan.push({ field, run: () => self.clear(field) });
          return;
        }
        if (staged.text === spec.format(self.sectionValue(field))) return;
        const write = spec.parse(staged.text);
        if (write === undefined) plan.push({ field, run: undefined });
        else if (write.kind === "clear") plan.push({ field, run: () => self.clear(field) });
        else plan.push({ field, run: () => self.store(field, write.value) });
      });
      return plan;
    };
    CardForm.prototype.clear = async function (field) {
      await this.scope.unset(field);
      return !this.stored(field);
    };
    CardForm.prototype.store = async function (field, value) {
      await this.scope.set(field, value);
      const user = this.userLayer();
      return user === undefined ? false : user[field] === value;
    };
    CardForm.prototype.stage = function (field, edit) {
      this.staged.set(field, edit);
      this.failed = false;
      this.publish();
    };
    CardForm.prototype.spec = function (field) {
      const spec = this.specs.get(field);
      if (spec === undefined) throw new Error("plugin card has no field " + field);
      return spec;
    };
    CardForm.prototype.snapshotOf = function () { return this.scope.getSnapshot(); };
    CardForm.prototype.sectionValue = function (field) {
      const value = this.snapshotOf().value;
      return value === undefined ? undefined : value[field];
    };
    CardForm.prototype.baseValue = function (field) {
      const base = this.snapshotOf().base;
      return base === undefined ? undefined : base[field];
    };
    CardForm.prototype.userLayer = function () { return this.snapshotOf().user; };
    CardForm.prototype.stored = function (field) {
      const user = this.userLayer();
      return user !== undefined && Object.prototype.hasOwnProperty.call(user, field);
    };
    CardForm.prototype.publish = function () { this.listeners.forEach((fn) => fn()); };
    CardForm.prototype.dispose = function () {
      this._unsubscribe();
      this.listeners.clear();
    };

    // ---- field key sets ----
    const TOGGLE_KEYS = ["anysearchEnabled", "anysearchFallbackToHttp", "cdpEnabled", "tavilyEnabled"];
    const FIELD_KEYS=[
      "searchApi", "searchUrl", "searchApiKey", "searchMaxResults", "searchMethod", "searchBody",
      "searchHeaders", "searchAuthHeader", "searchAuthScheme", "searchTimeoutMs", "searchResultsPath",
      "searchUrlField", "searchTitleField", "searchSnippetField", "searchPublishedField",
      "cdpEnabled", "cdpEndpoint", "cdpTimeoutMs", "cdpWaitMs",
      "tavilyEnabled", "tavilyEndpoint", "tavilyApiKey", "tavilyTimeoutMs",
      "anysearchEnabled", "anysearchEndpoint", "anysearchApiKey", "anysearchTimeoutMs",
      "anysearchFallbackToHttp", "anysearchMaxChars"
    ];
    const FIELD_VIEWS = [
      { key: "searchApi", labelKey: "field.searchApi", hintKey: "hint.searchApi" },
      { key: "searchUrl", labelKey: "field.searchUrl", hintKey: "hint.searchUrl" },
      { key: "searchApiKey", labelKey: "field.searchApiKey", hintKey: "hint.searchApiKey" },
      { key: "searchMaxResults", labelKey: "field.searchMaxResults", hintKey: "hint.searchMaxResults", numeric: true },
      { key: "searchMethod", labelKey: "field.searchMethod", hintKey: "hint.searchMethod" },
      { key: "searchBody", labelKey: "field.searchBody", hintKey: "hint.searchBody" },
      { key: "searchHeaders", labelKey: "field.searchHeaders", hintKey: "hint.searchHeaders" },
      { key: "searchAuthHeader", labelKey: "field.searchAuthHeader", hintKey: "hint.searchAuthHeader" },
      { key: "searchAuthScheme", labelKey: "field.searchAuthScheme", hintKey: "hint.searchAuthScheme" },
      { key: "searchTimeoutMs", labelKey: "field.searchTimeoutMs", hintKey: "hint.searchTimeoutMs", numeric: true },
      { key: "searchResultsPath", labelKey: "field.searchResultsPath", hintKey: "hint.searchResultsPath" },
      { key: "searchUrlField", labelKey: "field.searchUrlField", hintKey: "hint.fieldMap" },
      { key: "searchTitleField", labelKey: "field.searchTitleField", hintKey: "hint.fieldMap" },
      { key: "searchSnippetField", labelKey: "field.searchSnippetField", hintKey: "hint.fieldMap" },
      { key: "searchPublishedField", labelKey: "field.searchPublishedField", hintKey: "hint.fieldMap" },
      { key: "anysearchEndpoint", labelKey: "field.anysearchEndpoint", hintKey: "hint.anysearchEndpoint" },
      { key: "anysearchApiKey", labelKey: "field.anysearchApiKey", hintKey: "hint.anysearchApiKey" },
      { key: "anysearchTimeoutMs", labelKey: "field.anysearchTimeoutMs", hintKey: "hint.anysearchTimeoutMs", numeric: true },
      { key: "anysearchMaxChars", labelKey: "field.anysearchMaxChars", hintKey: "hint.anysearchMaxChars", numeric: true },
      { key: "cdpEndpoint", labelKey: "field.cdpEndpoint", hintKey: "hint.cdpEndpoint" },
      { key: "cdpTimeoutMs", labelKey: "field.cdpTimeoutMs", hintKey: "hint.cdpTimeoutMs", numeric: true },
      { key: "cdpWaitMs", labelKey: "field.cdpWaitMs", hintKey: "hint.cdpWaitMs", numeric: true },
      { key: "tavilyEndpoint", labelKey: "field.tavilyEndpoint", hintKey: "hint.tavilyEndpoint" },
      { key: "tavilyApiKey", labelKey: "field.tavilyApiKey", hintKey: "hint.tavilyApiKey" },
      { key: "tavilyTimeoutMs", labelKey: "field.tavilyTimeoutMs", hintKey: "hint.tavilyTimeoutMs", numeric: true }
    ];

    function WebCustomController(scope) {
      const self = this;
      const numeric = new Set(["searchMaxResults", "searchTimeoutMs", "cdpTimeoutMs", "cdpWaitMs", "tavilyTimeoutMs", "anysearchTimeoutMs", "anysearchMaxChars"]);
      const specs = FIELD_KEYS.map((key) => {
        if (TOGGLE_KEYS.includes(key)) return boolField(key);
        return numeric.has(key) ? numberField(key) : textField(key);
      });
      this.form = new CardForm(scope, specs);
      this.store = this.form.bind(() => self.projection());
    }
    WebCustomController.prototype.projection = function () {
      const shell = this.form.shell();
      const result = {};
      Object.keys(shell).forEach((key) => { result[key] = shell[key]; });
      FIELD_KEYS.forEach((key) => { result[key] = this.form.field(key); });
      return result;
    };
    WebCustomController.prototype.inject = function () {
      const actions = this.form.actions();
      const result = { hooks: { webCustom: this.store } };
      Object.keys(actions).forEach((key) => { result[key] = actions[key]; });
      return result;
    };
    WebCustomController.prototype.dispose = function () { this.form.dispose(); };

    /** SettingsForm 需要的框架文案（官方卡同款键集合）。 */
    function formLabels(t) {
      return {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving")
      };
    }

    // ---- 本地小组件（无手写卡壳；仅分组标题与开关行，样式走官方 token） ----
    function GroupTitle(props) {
      return jsx("div", {
        style: {
          color: "var(--dsw-alias-label-primary)",
          fontSize: 14,
          fontWeight: 600,
          margin: "16px 0 8px"
        },
        children: props.children
      });
    }
    function ToggleRow(props) {
      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 4, margin: "0 0 12px" },
        children: [
          jsxs("label", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              cursor: props.disabled ? "default" : "pointer",
              color: props.disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)"
            },
            htmlFor: props.id,
            children: [
              jsx("input", {
                type: "checkbox",
                id: props.id,
                checked: props.checked,
                disabled: props.disabled,
                onChange: (event) => props.onChange(event.target.checked)
              }),
              jsx("span", { children: props.label }),
              jsx("span", {
                style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
                children: props.checked ? props.onLabel : props.offLabel
              })
            ]
          }),
          jsx("span", {
            style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: 1.5 },
            children: props.hint
          })
        ]
      });
    }

    /**
     * 插件页本卡片的两个视图（plugins.item 的 ownerProps.view）：
     * - "summary"：列表卡描述区 —— 只返回一行文案。
     * - "page"：详情页配置区 —— 返回 SettingsForm 本体，不重复画卡壳。
     */
    function WebCustomCard(props) {
      const t = props.t;
      // hooks 规则：条件返回必须排在所有 hook 调用之后，summary/page 两条路径共用同一 hook 顺序。
      const state = props.useWebCustom((snapshot) => snapshot);
      if (props.view === "summary") return t("card.description");
      const disabled = !state.writable;
      const toggle = (key, checked) => { props.edit(key, checked ? "true" : ""); };
      const fieldRow = (view) => {
        const field = state[view.key];
        return jsx(primitives.SettingsValueField, {
          key: view.key,
          id: "plugin-config-web-custom-" + view.key,
          label: t(view.labelKey),
          hint: t(view.hintKey),
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          invalidLabel: t("invalid"),
          numeric: view.numeric === true,
          disabled,
          ...field,
          onEdit: (text) => { props.edit(view.key, text); },
          onReset: () => { props.resetField(view.key); }
        });
      };
      const rows = (prefix) => FIELD_VIEWS.filter((view) => view.key.startsWith(prefix)).map(fieldRow);
      return jsx(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsx(GroupTitle, { key: "g-search", children: t("group.search") }),
          ...rows("search"),
          jsx(GroupTitle, { key: "g-anysearch", children: t("group.anysearch") }),
          jsx(ToggleRow, {
            key: "t-anysearch",
            id: "wc-anysearch-enabled",
            label: t("field.anysearchEnabled"),
            hint: t("hint.anysearchEnabled"),
            checked: state.anysearchEnabled.text === "true",
            onLabel: t("on"), offLabel: t("off"),
            disabled,
            onChange: (checked) => toggle("anysearchEnabled", checked)
          }),
          jsx(ToggleRow, {
            key: "t-anysearch-fallback",
            id: "wc-anysearch-fallback",
            label: t("field.anysearchFallbackToHttp"),
            hint: t("hint.anysearchFallbackToHttp"),
            checked: state.anysearchFallbackToHttp.text === "true",
            onLabel: t("on"), offLabel: t("off"),
            disabled,
            onChange: (checked) => toggle("anysearchFallbackToHttp", checked)
          }),
          ...rows("anysearch"),
          jsx(GroupTitle, { key: "g-cdp", children: t("group.cdp") }),
          jsx(ToggleRow, {
            key: "t-cdp",
            id: "wc-cdp-enabled",
            label: t("field.cdpEnabled"),
            hint: t("hint.cdpEnabled"),
            checked: state.cdpEnabled.text === "true",
            onLabel: t("on"), offLabel: t("off"),
            disabled,
            onChange: (checked) => toggle("cdpEnabled", checked)
          }),
          ...rows("cdp"),
          jsx(GroupTitle, { key: "g-tavily", children: t("group.tavily") }),
          jsx(ToggleRow, {
            key: "t-tavily",
            id: "wc-tavily-enabled",
            label: t("field.tavilyEnabled"),
            hint: t("hint.tavilyEnabled"),
            checked: state.tavilyEnabled.text === "true",
            onLabel: t("on"), offLabel: t("off"),
            disabled,
            onChange: (checked) => toggle("tavilyEnabled", checked)
          }),
          ...rows("tavily")
        ]
      });
    }

    // ---- locales ----
    const NS = "web-custom";
    const zh = {
      "card.title": "通用 Web 获取与搜索（web-custom）",
      "card.description": "一个插件接管 web_search 与 web_fetch：AnySearch 搜索 / AnySearch Extract，外加 CDP 浏览器与 Tavily 两个独立抓取工具。",
      "unavailable": "该插件当前未加载，暂时无法配置。",
      "save": "保存",
      "saving": "保存中…",
      "saveFailed": "保存未生效，请检查填写内容",
      "readOnly": "该设置为只读（当前连接不可写）",
      "overridden": "已覆盖",
      "reset": "重置",
      "invalid": "请输入有效值",
      "on": "已开启",
      "off": "已关闭",
      "group.search": "搜索（接管 web_search）",
      "group.anysearch": "抓取 · AnySearch（接管 web_fetch）",
      "group.cdp": "抓取 · CDP 浏览器（独立工具）",
      "group.tavily": "抓取 · Tavily（独立工具）",
      "field.searchApi": "接口档位（searchApi）",
      "hint.searchApi": "auto（默认，按 URL 主机名判定）/ anysearch（AnySearch 专用档）/ generic（通用 JSON 档）",
      "field.searchUrl": "搜索 URL",
      "hint.searchUrl": "anysearch 档：https://api.anysearch.com/v1/search；generic 档支持 {query}（已编码）/ {queryRaw}（原始）/ {apiKey} 占位符，GET 且无 {query} 时自动补 q= 参数",
      "field.searchApiKey": "搜索 API Key（留空 = 免 key 匿名档）",
      "hint.searchApiKey": "anysearch 档：留空则完全不发鉴权头（匿名免费额度）；填了发 Authorization: Bearer <key>",
      "field.searchMaxResults": "结果条数上限",
      "hint.searchMaxResults": "anysearch 档发送 max_results，取本值与调用方上限的较小者，并夹在 1–10",
      "field.searchMethod": "请求方法（仅 generic）",
      "hint.searchMethod": "GET 或 POST；anysearch 档固定 POST",
      "field.searchBody": "POST body 模板",
      "hint.searchBody": "支持 {query} / {apiKey} 占位符",
      "field.searchHeaders": "额外请求头（JSON）",
      "hint.searchHeaders": "例如 {\"X-Custom\":\"1\"}，留空为 {}",
      "field.searchAuthHeader": "鉴权请求头名（仅 generic）",
      "hint.searchAuthHeader": "默认 Authorization；anysearch 档固定 Authorization",
      "field.searchAuthScheme": "鉴权 scheme（仅 generic）",
      "hint.searchAuthScheme": "默认 Bearer；留空则原样发送 key（anysearch 档固定 Bearer）",
      "field.searchTimeoutMs": "超时（毫秒）",
      "hint.searchTimeoutMs": "单次请求超时，默认 30000",
      "field.searchResultsPath": "结果数组路径（仅 generic）",
      "hint.searchResultsPath": "JSON 点路径，默认 results；anysearch 档固定 data.results",
      "field.searchUrlField": "URL 字段",
      "field.searchTitleField": "标题字段",
      "field.searchSnippetField": "摘要字段",
      "field.searchPublishedField": "发布日期字段",
      "hint.fieldMap": "结果字段名映射（仅 generic；SearXNG：url/title/content/publishedDate）",
      "field.anysearchEnabled": "启用 AnySearch Extract",
      "hint.anysearchEnabled": "开启并填好 API Key 后，原生 web_fetch 改由 AnySearch /v1/extract 提供（profile 的 web 行 fetchProvider 需为 anysearch）",
      "field.anysearchFallbackToHttp": "extract 失败时回落 HTTP 直取",
      "hint.anysearchFallbackToHttp": "PDF / raw 文件 / 知乎等站点 extract 必 422，回落可保住原生能力，建议开启；注意：关闭回落且未填 Key 时 extract 档不可用，宿主会让整个 web_fetch 直接报错、不自动回落",
      "field.anysearchEndpoint": "AnySearch 端点",
      "hint.anysearchEndpoint": "Extract API URL，默认 https://api.anysearch.com/v1/extract",
      "field.anysearchApiKey": "AnySearch API Key",
      "hint.anysearchApiKey": "以 as_sk_ 开头；留空则 web_fetch 直接走 HTTP 直取（与搜索 key 可填同一个）",
      "field.anysearchTimeoutMs": "AnySearch 超时（毫秒）",
      "hint.anysearchTimeoutMs": "请求超时，默认 30000",
      "field.anysearchMaxChars": "返回内容上限（字符）",
      "hint.anysearchMaxChars": "超过即截断并标记 truncated，默认 100000",
      "field.cdpEnabled": "启用 CDP 浏览器",
      "hint.cdpEnabled": "开启后 web_fetch_cdp 通过 CDP 端点连接远程浏览器抓取页面内容",
      "field.cdpEndpoint": "CDP 端点 URL",
      "hint.cdpEndpoint": "Chrome DevTools Protocol HTTP 端点，默认 127.0.0.1:9222",
      "field.cdpTimeoutMs": "CDP 超时（毫秒）",
      "hint.cdpTimeoutMs": "页面导航超时，默认 60000",
      "field.cdpWaitMs": "页面加载额外等待（毫秒）",
      "hint.cdpWaitMs": "Page.loadEventFired 后再等待的毫秒数，默认 2000",
      "field.tavilyEnabled": "启用 Tavily",
      "hint.tavilyEnabled": "开启后 web_fetch_tavily 通过 Tavily Extract API 抓取（需要 API Key）",
      "field.tavilyEndpoint": "Tavily API 端点",
      "hint.tavilyEndpoint": "Tavily Extract API URL，默认 https://api.tavily.com/extract",
      "field.tavilyApiKey": "Tavily API Key",
      "hint.tavilyApiKey": "从 https://app.tavily.com 获取；留空则 Tavily 不可用",
      "field.tavilyTimeoutMs": "Tavily 超时（毫秒）",
      "hint.tavilyTimeoutMs": "请求超时，默认 30000"
    };
    const en = {
      "card.title": "Web fetch & search (web-custom)",
      "card.description": "One plugin serves web_search and web_fetch (AnySearch), plus two standalone tools: CDP browser and Tavily.",
      "unavailable": "This plugin is not loaded, so it cannot be configured right now.",
      "save": "Save",
      "saving": "Saving…",
      "saveFailed": "Save did not land; check your input",
      "readOnly": "Read-only in this session (not writable over the current connection)",
      "overridden": "Overridden",
      "reset": "Reset",
      "invalid": "Enter a valid value",
      "on": "On",
      "off": "Off",
      "group.search": "Search (serves web_search)",
      "group.anysearch": "Fetch · AnySearch (serves web_fetch)",
      "group.cdp": "Fetch · CDP Browser (standalone tool)",
      "group.tavily": "Fetch · Tavily (standalone tool)",
      "field.searchApi": "API profile (searchApi)",
      "hint.searchApi": "auto (default; decided by URL host) / anysearch (AnySearch POST API) / generic (any JSON endpoint)",
      "field.searchUrl": "Search URL",
      "hint.searchUrl": "anysearch: https://api.anysearch.com/v1/search. generic: supports {query} (encoded) / {queryRaw} / {apiKey}; GET without {query} appends q=",
      "field.searchApiKey": "Search API key (empty = keyless anonymous tier)",
      "hint.searchApiKey": "anysearch: empty sends NO Authorization header (anonymous free tier); set it to send Authorization: Bearer <key>",
      "field.searchMaxResults": "Max results",
      "hint.searchMaxResults": "anysearch sends max_results = min(this value, caller limit), clamped to 1-10",
      "field.searchMethod": "Request method (generic)",
      "hint.searchMethod": "GET or POST; the anysearch profile always uses POST",
      "field.searchBody": "POST body template",
      "hint.searchBody": "Supports {query} / {apiKey} placeholders",
      "field.searchHeaders": "Extra headers (JSON)",
      "hint.searchHeaders": "e.g. {\"X-Custom\":\"1\"}; empty = {}",
      "field.searchAuthHeader": "Auth header name (generic)",
      "hint.searchAuthHeader": "Default Authorization; the anysearch profile always uses Authorization",
      "field.searchAuthScheme": "Auth scheme (generic)",
      "hint.searchAuthScheme": "Default Bearer; empty sends the key raw (anysearch always uses Bearer)",
      "field.searchTimeoutMs": "Timeout (ms)",
      "hint.searchTimeoutMs": "Per-request timeout, default 30000",
      "field.searchResultsPath": "Results array path (generic)",
      "hint.searchResultsPath": "Dot path into the JSON, default results; anysearch always reads data.results",
      "field.searchUrlField": "URL field",
      "field.searchTitleField": "Title field",
      "field.searchSnippetField": "Snippet field",
      "field.searchPublishedField": "Published-date field",
      "hint.fieldMap": "Result field mapping (generic only; SearXNG: url/title/content/publishedDate)",
      "field.anysearchEnabled": "Enable AnySearch Extract",
      "hint.anysearchEnabled": "When enabled with a key, the native web_fetch is served by AnySearch /v1/extract (web row fetchProvider must be anysearch)",
      "field.anysearchFallbackToHttp": "Fall back to plain HTTP when extract fails",
      "hint.anysearchFallbackToHttp": "PDF / raw files / zhihu always fail with 422; keep the fallback to preserve native behaviour. Fallback off with an empty key makes the extract provider unavailable, and the host then fails every web_fetch instead of falling back",
      "field.anysearchEndpoint": "AnySearch endpoint",
      "hint.anysearchEndpoint": "Extract API URL, default https://api.anysearch.com/v1/extract",
      "field.anysearchApiKey": "AnySearch API key",
      "hint.anysearchApiKey": "Starts with as_sk_; empty = plain HTTP only (may be the same key as search)",
      "field.anysearchTimeoutMs": "AnySearch timeout (ms)",
      "hint.anysearchTimeoutMs": "Per-request timeout, default 30000",
      "field.anysearchMaxChars": "Content cap (chars)",
      "hint.anysearchMaxChars": "Truncated beyond this and flagged, default 100000",
      "field.cdpEnabled": "Enable CDP browser",
      "hint.cdpEnabled": "web_fetch_cdp connects to the CDP endpoint and scrapes the rendered page",
      "field.cdpEndpoint": "CDP endpoint URL",
      "hint.cdpEndpoint": "Chrome DevTools Protocol HTTP endpoint, default 127.0.0.1:9222",
      "field.cdpTimeoutMs": "CDP timeout (ms)",
      "hint.cdpTimeoutMs": "Page-navigation timeout, default 60000",
      "field.cdpWaitMs": "Extra wait after load (ms)",
      "hint.cdpWaitMs": "Milliseconds to wait after Page.loadEventFired, default 2000",
      "field.tavilyEnabled": "Enable Tavily",
      "hint.tavilyEnabled": "web_fetch_tavily uses the Tavily Extract API (requires a key)",
      "field.tavilyEndpoint": "Tavily API endpoint",
      "hint.tavilyEndpoint": "Tavily Extract API URL, default https://api.tavily.com/extract",
      "field.tavilyApiKey": "Tavily API key",
      "hint.tavilyApiKey": "Get one from https://app.tavily.com; empty disables Tavily",
      "field.tavilyTimeoutMs": "Tavily timeout (ms)",
      "hint.tavilyTimeoutMs": "Per-request timeout, default 30000"
    };

    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-custom: dictionaries");
      const controller = new WebCustomController(ctx.configForms.get(NS));
      ctx.effect(() => () => controller.dispose(), "dsh-web-custom: form subscription");
      // 0.1.7 slots.inject 契约：callback 是「返回 disposer 的普通函数」；
      // whileServed：宿主开始服务本命名空间才注册，停用时自动摘除。
      ctx.effect(
        () => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.item",
          () => ctx.slots.register({
            name: "plugins.item",
            id: NS,
            order: 30,
            label: () => t("card.title"),
            locale: NS,
            inject: () => controller.inject()
          }, WebCustomCard)
        )),
        "dsh-web-custom: card registration"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
