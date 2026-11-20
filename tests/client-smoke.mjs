/**
 * client-smoke.mjs —— lib/client.js（浏览器半）结构与交互测试。
 *
 * 0.2.x 契约（对照宿主真实源码）：
 *   - 设置卡槽位 plugins.item（list，id + label thunk + summary/page 双视图）
 *   - configForms.get(ns) + configForms.whileServed 门控
 *   - slots.inject(key, callback) 的 callback 是「返回 disposer 的普通函数」
 *   - 表单原语走 @deepseek-ai/dsh-client-ui-primitives（SettingsForm / SettingsValueField）
 *
 * 验证：
 *   1. bundle id / exports.inject 短服务名集合
 *   2. locale zh/en 键集合互相覆盖，卡片与四组字段文案齐全
 *   3. configForms.get 绑定命名空间；whileServed 门控真实生效（未服务不注册）
 *   4. plugins.item 注册契约（id / order 30 / locale / label thunk / hooks.webCustom + actions）
 *   5. 双视图：summary 一行描述；page 渲染 29 个控件（25 输入框 + 4 开关）
 *   6. 不可用态渲染提示；只读态全禁用 + 只读提示；保存按钮跟随 dirty/invalid
 *   7. 交互落盘：开关布尔 / 数字 number / 清空移除键 / 非法数字置 invalid 且不写
 *
 * 运行：node tests/client-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ✓ " + label); };

function makeElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined) };
}
const jsxStub = (type, props) => {
  const pc = props && props.children;
  const children = pc === undefined || pc === null ? [] : (Array.isArray(pc) ? pc : [pc]);
  return makeElement(type, props, ...children);
};

const primitivesStub = {
  SettingsForm(props) {
    const labels = props.labels || {};
    if (props.state.available !== true) return jsxStub("div", { children: labels.unavailable });
    const inner = [];
    if (props.state.writable !== true) inner.push(jsxStub("p", { children: labels.readOnly }));
    if (props.state.failed === true) inner.push(jsxStub("p", { children: labels.saveFailed }));
    inner.push(jsxStub("div", { children: props.children }));
    inner.push(jsxStub("button", {
      disabled: props.state.dirty !== true || props.state.invalid === true || props.state.saving === true,
      onClick: props.onSave,
      children: props.state.saving === true ? labels.saving : labels.save
    }));
    inner.push(jsxStub("button", { onClick: props.onDiscard, children: labels.discard || "discard" }));
    return jsxStub("div", { children: inner });
  },
  SettingsValueField(props) {
    return jsxStub("div", {
      children: [
        jsxStub("label", { htmlFor: props.id, children: props.label }),
        jsxStub("input", {
          id: props.id,
          value: props.text === undefined ? "" : props.text,
          inputMode: props.numeric === true ? "numeric" : undefined,
          "aria-invalid": props.invalid === true ? true : undefined,
          disabled: props.disabled === true,
          onChange: (event) => props.onEdit(event.target.value)
        }),
        props.overridden === true ? jsxStub("button", { onClick: props.onReset, children: props.overriddenLabel }) : null,
        props.invalid === true ? jsxStub("p", { children: props.invalidLabel }) : null,
        props.hint ? jsxStub("p", { children: props.hint }) : null
      ]
    });
  }
};

let bundleFactory = null;
let bundleId = null;
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { bundleId = id; bundleFactory = factory; } } };
const requireStub = (specifier) => {
  if (specifier === "react/jsx-runtime") return { jsx: jsxStub, jsxs: jsxStub };
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
  throw new Error("unexpected require: " + specifier);
};

new Function("code", "return eval(code)")(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));

console.log("== bundle 加载 ==");
assert.equal(bundleId, "dsh-web-custom", "bundle id 必须等于包名");
ok("bundle id = dsh-web-custom（与 package.json name 一致）");

const exportsRef = bundleFactory(requireStub);
assert.deepEqual([...exportsRef.inject], ["slots", "locale", "configForms"], "exports.inject 必须是短服务名集合");
assert.equal(typeof exportsRef.apply, "function");
ok("exports.inject = [slots, locale, configForms]；apply 可调用");

// ---- 桩环境 ----
const NS = "web-custom";
const localeDicts = {};
let servedGate = true;
let whileServedNamespaces = null;
let boundNamespace = null;
const scopeListeners = new Set();
const DEFAULTS = {
  searchApi: "auto", searchUrl: "https://api.anysearch.com/v1/search", searchApiKey: "", searchMaxResults: 10,
  searchMethod: "GET", searchBody: '{"query":"{query}"}', searchHeaders: "{}", searchAuthHeader: "Authorization",
  searchAuthScheme: "Bearer", searchTimeoutMs: 30000, searchResultsPath: "results", searchUrlField: "url",
  searchTitleField: "title", searchSnippetField: "content", searchPublishedField: "publishedDate",
  cdpEnabled: true, cdpEndpoint: "http://10.200.0.5:9222", cdpTimeoutMs: 60000, cdpWaitMs: 2000,
  tavilyEnabled: false, tavilyEndpoint: "https://api.tavily.com/extract", tavilyApiKey: "", tavilyTimeoutMs: 30000,
  anysearchEnabled: true, anysearchEndpoint: "https://api.anysearch.com/v1/extract", anysearchApiKey: "",
  anysearchTimeoutMs: 30000, anysearchFallbackToHttp: true, anysearchMaxChars: 100000
};
const scopeState = { status: "ready", writable: true, value: { ...DEFAULTS }, base: { ...DEFAULTS }, user: {}, revision: 1, mode: "host" };
const scopeStub = {
  getSnapshot: () => scopeState,
  subscribe(fn) { scopeListeners.add(fn); return () => { scopeListeners.delete(fn); }; },
  set: async (key, value) => {
    scopeState.user[key] = value;
    scopeState.value = Object.assign({}, scopeState.value, { [key]: value });
    scopeListeners.forEach((fn) => fn());
    return true;
  },
  unset: async (key) => {
    delete scopeState.user[key];
    const next = Object.assign({}, scopeState.value);
    delete next[key];
    scopeState.value = next;
    scopeListeners.forEach((fn) => fn());
    return true;
  }
};
const configFormsStub = {
  get(ns) { boundNamespace = ns; return scopeStub; },
  whileServed(namespaces, register) {
    whileServedNamespaces = [...namespaces];
    if (servedGate) register();
    return () => {};
  }
};
let slotEntry = null;
const slotsStub = {
  inject(slot, callback) { const reg = callback(); slotEntry = { slot, reg }; return () => {}; },
  register(def, component) { return { def, component }; }
};
const ctxStub = {
  effect(fn) { return fn(); },
  locale: {
    register(ns, dict) { localeDicts[ns] = dict; },
    bind(ns) {
      return (key) => {
        const dict = localeDicts[ns] || {};
        const hit = dict[key];
        return hit === undefined ? key : hit;
      };
    }
  },
  configForms: configFormsStub,
  slots: slotsStub
};

exportsRef.apply(ctxStub);

console.log("== locale ==");
const zh = localeDicts[NS].zh;
const en = localeDicts[NS].en;
for (const key of Object.keys(zh)) assert.ok(Object.hasOwn(en, key), "en 缺少键: " + key);
for (const key of Object.keys(en)) assert.ok(Object.hasOwn(zh, key), "zh 缺少键: " + key);
assert.equal(Object.keys(en).length, Object.keys(zh).length);
ok("zh/en 键集合互相覆盖（" + Object.keys(zh).length + " 键）");
for (const key of [
  "card.title", "card.description", "unavailable", "readOnly", "save", "saving", "saveFailed",
  "overridden", "reset", "invalid", "on", "off",
  "group.search", "group.anysearch", "group.cdp", "group.tavily",
  "field.searchApi", "field.searchApiKey", "field.cdpEnabled", "field.tavilyEnabled",
  "hint.searchApi", "hint.anysearchFallbackToHttp"
]) {
  assert.ok(zh[key], "zh 翻译键缺失: " + key);
  assert.ok(en[key], "en 翻译键缺失: " + key);
}
ok("卡片框架 / 四组标题 / 关键字段与 hint 文案齐全");

console.log("== configForms / whileServed ==");
assert.equal(boundNamespace, NS, "configForms.get 必须绑定 " + NS);
assert.deepEqual(whileServedNamespaces, [NS], "whileServed 必须门控 [" + NS + "]");
ok("configForms.get 与 whileServed 都绑定 web-custom");

console.log("== plugins.item 槽位 ==");
assert.equal(slotEntry.slot, "plugins.item");
const injected = slotEntry.reg;
assert.equal(injected.def.name, "plugins.item");
assert.equal(injected.def.id, NS);
assert.equal(injected.def.order, 30, "客户端 order 沿用抓取侧 30（与 web-search 旧卡 50 区分）");
assert.equal(injected.def.locale, NS);
assert.equal(typeof injected.def.label, "function");
const payload = injected.def.inject();
assert.equal(typeof payload.hooks.webCustom.getSnapshot, "function", "hooks.webCustom 提供快照");
for (const fn of ["edit", "resetField", "save", "discard"]) {
  assert.equal(typeof payload[fn], "function", "action 缺失: " + fn);
}
ok("槽位契约：plugins.item / id=web-custom / order 30 / label thunk / hooks.webCustom + 4 actions");

// ---- 渲染辅助 ----
const Card = injected.component;
const snap = () => payload.hooks.webCustom.getSnapshot();
function collect(node, out = { els: [], strings: [] }) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.strings.push(String(node)); return out; }
  if (typeof node !== "object") return out;
  if (typeof node.type === "function") { collect(node.type(node.props), out); return out; }
  out.els.push(node);
  for (const child of node.children || []) collect(child, out);
  return out;
}
const cardProps = (extra = {}) => Object.assign({
  t: (key) => (zh[key] === undefined ? key : zh[key]),
  useWebCustom: (selector) => selector(snap())
}, payload, extra);
const render = (extra = {}) => collect(jsxStub(Card, cardProps(extra)));
const controls = (out) => out.els.filter((n) => n.type === "input" || n.type === "select");
const byId = (out, id) => out.els.find((n) => n.props.id === id);
const button = (out, text) => out.els.find((n) => n.type === "button" && n.children.join("").includes(text));

console.log("== 双视图 ==");
const summary = Card(cardProps({ view: "summary" }));
assert.equal(typeof summary, "string", "summary 视图必须只返回一行描述");
assert.equal(summary, zh["card.description"]);
ok("summary 视图返回描述串（不渲染表单）");

let nodes = render();
const inputs = controls(nodes);
assert.equal(inputs.length, 29, "page 视图应渲染 29 个控件（25 SettingsValueField + 4 ToggleRow）");
assert.equal(inputs.filter((n) => n.props.type === "checkbox").length, 4, "四个开关是 checkbox");
assert.equal(inputs.filter((n) => n.props.type !== "checkbox").length, 25, "其余 25 个字段是输入框");
for (const title of ["group.search", "group.anysearch", "group.cdp", "group.tavily"]) {
  assert.ok(nodes.strings.includes(zh[title]), "分组标题缺失: " + zh[title]);
}
for (const id of ["wc-anysearch-enabled", "wc-anysearch-fallback", "wc-cdp-enabled", "wc-tavily-enabled"]) {
  assert.ok(byId(nodes, id), "开关 id 缺失: " + id);
}
assert.ok(byId(nodes, "plugin-config-web-custom-searchMaxResults"), "字段输入框 id 缺失");
assert.ok(button(nodes, zh["save"]), "保存按钮缺失");
ok("page 视图：四组标题 + 29 控件（25 输入框 + 4 开关）+ 保存按钮");

console.log("== 不可用 / 只读态 ==");
scopeState.status = "unavailable";
scopeListeners.forEach((fn) => fn());
nodes = render();
assert.ok(nodes.strings.includes(zh["unavailable"]), "不可用态必须渲染提示（而非静默消失）");
assert.equal(controls(nodes).length, 0, "不可用态不应渲染控件");
scopeState.status = "ready";
scopeListeners.forEach((fn) => fn());
ok("不可用态：渲染 unavailable 提示，无控件");

scopeState.writable = false;
scopeListeners.forEach((fn) => fn());
nodes = render();
assert.equal(controls(nodes).length, 29);
assert.ok(controls(nodes).every((n) => n.props.disabled === true), "只读态所有控件必须禁用");
assert.ok(nodes.strings.includes(zh["readOnly"]), "只读态必须显示只读提示");
assert.equal(button(nodes, zh["save"]).props.disabled, true, "只读态保存按钮禁用");
scopeState.writable = true;
scopeListeners.forEach((fn) => fn());
ok("只读态：29 控件全禁用 + readOnly 提示 + 保存禁用");

console.log("== 交互落盘 ==");
nodes = render();
assert.ok(controls(nodes).every((n) => n.props.disabled === false), "可写态控件必须可用");

// 选默认 false 的 tavily 开关：把它勾成 true 才是真变更（cdp 默认已 true，勾选等于没改，plan 会跳过）。
byId(nodes, "wc-tavily-enabled").props.onChange({ target: { checked: true } });
await payload.save();
assert.equal(scopeState.user.tavilyEnabled, true, "开关 onChange → 保存必须写 user 层");
ok("开关：tavilyEnabled 以 boolean true 落盘");

nodes = render();
byId(nodes, "plugin-config-web-custom-searchMaxResults").props.onChange({ target: { value: "5" } });
await payload.save();
assert.equal(scopeState.user.searchMaxResults, 5, "数字字段必须以 number 落盘");
assert.equal(typeof scopeState.user.searchMaxResults, "number");
ok("数字字段：searchMaxResults 以 number 5 落盘（不是字符串）");

scopeState.user.searchApiKey = "as_sk_x";
scopeState.value.searchApiKey = "as_sk_x";
scopeListeners.forEach((fn) => fn());
nodes = render();
byId(nodes, "plugin-config-web-custom-searchApiKey").props.onChange({ target: { value: "" } });
await payload.save();
assert.equal(Object.hasOwn(scopeState.user, "searchApiKey"), false, "清空文本字段必须从 user 层移除");
ok("清空文本字段：searchApiKey 从 user 层移除（回落默认）");

nodes = render();
byId(nodes, "plugin-config-web-custom-searchTimeoutMs").props.onChange({ target: { value: "abc" } });
assert.equal(snap().invalid, true, "非法数字必须置 invalid");
const before = Object.keys(scopeState.user).join(",");
await payload.save();
assert.equal(Object.keys(scopeState.user).join(","), before, "invalid 时保存不得写入任何字段");
payload.discard();
ok("非法数字：state.invalid = true，保存被拒且不落盘");

console.log("== whileServed 门控 ==");
servedGate = false;
slotEntry = null;
bundleFactory(requireStub).apply(ctxStub);
assert.equal(slotEntry, null, "命名空间未被服务时不得注册槽位（否则插件页出现空卡）");
servedGate = true;
bundleFactory(requireStub).apply(ctxStub);
assert.ok(slotEntry !== null, "命名空间被服务后必须完成注册");
ok("whileServed：未服务不注册 / 服务后注册");

console.log("========================================");
console.log("  client smoke: " + passed + " checks passed");
