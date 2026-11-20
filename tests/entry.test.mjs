/**
 * entry.test.mjs —— dsh-web-custom 合并入口守护测试（真实 import + 声明面 + 键集合一致性）。
 *
 * 覆盖：
 *   1. 模块可加载；name / SETTINGS_NS / Config / readField / inject 契约
 *   2. Config 29 字段全部 .volatile()（设置页只认 volatile 路径）
 *   3. apply 同步；configure({auto:false})；等待式注入 settings + web；
 *      一次 apply 注册 2 个 provider（custom / anysearch）+ 2 个独立工具
 *   4. 热读：volatile 活引用逐次现读（搜索 provider 与抓取工具都验）
 *   5. 工具声明面（output.schema + render + url 参数）与禁用态文案
 *   6. 键集合三处一致：Config ↔ client FIELD_KEYS ↔ cordis.patch.yml
 *   7. manifest / engines / peer 区间 / 依赖卫生
 *
 * 运行：node tests/entry.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ✓ " + label); };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const clientSource = readFileSync(join(root, "lib", "client.js"), "utf8");
const patchSource = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const ENTRY = await import("../src/index.js");

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

// ---------------------------------------------------------------------------
// 1. 入口与声明
// ---------------------------------------------------------------------------
assert.equal(typeof ENTRY.apply, "function");
assert.equal(ENTRY.name, "web-custom");
assert.equal(ENTRY.SETTINGS_NS, "web-custom");
assert.equal(ENTRY.SEARCH_PROVIDER_ID, "custom");
assert.equal(ENTRY.ANYSEARCH_FETCH_PROVIDER_ID, "anysearch");
assert.equal(typeof ENTRY.Config, "function", "Config 必须从模块导出（设置命名空间来源）");
assert.equal(typeof ENTRY.readField, "function", "readField 必须导出（volatile 解引用契约）");
assert.deepEqual([...ENTRY.inject], ["tools"], "tools 是硬依赖；settings/web 走等待式注入");
ok("入口真实 import：apply / name / SETTINGS_NS / 两个 provider id / Config / readField / inject");

const CONFIG_KEYS = [
  "searchApi", "searchUrl", "searchApiKey", "searchMaxResults", "searchMethod", "searchBody",
  "searchHeaders", "searchAuthHeader", "searchAuthScheme", "searchTimeoutMs", "searchResultsPath",
  "searchUrlField", "searchTitleField", "searchSnippetField", "searchPublishedField",
  "cdpEnabled", "cdpEndpoint", "cdpTimeoutMs", "cdpWaitMs",
  "tavilyEnabled", "tavilyEndpoint", "tavilyApiKey", "tavilyTimeoutMs",
  "anysearchEnabled", "anysearchEndpoint", "anysearchApiKey", "anysearchTimeoutMs",
  "anysearchFallbackToHttp", "anysearchMaxChars"
];
assert.equal(CONFIG_KEYS.length, 29);
assert.deepEqual(Object.keys(ENTRY.Config.dict).sort(), [...CONFIG_KEYS].sort(), "Config 键集合必须是 29 个合并字段");
for (const key of CONFIG_KEYS) {
  assert.equal(ENTRY.Config.dict[key].meta?.volatile, true,
    "Config." + key + " 必须 .volatile()——设置页只认 volatile 路径，非 volatile 字段写不进去");
}
ok("Config：29 字段全量 .volatile()（搜索 15 + 抓取 14）");

// ---------------------------------------------------------------------------
// 2. apply：同步 / 等待式注入 / 两个 provider + 两个工具
// ---------------------------------------------------------------------------
function makeCtx() {
  const registered = [];
  const providers = { search: [], fetch: [] };
  const seen = { configure: 0, autoPolicy: undefined, injects: [], effects: 0 };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fiber: { id: "test-fiber" },
    effect(fn) { seen.effects += 1; const d = fn(); return typeof d === "function" ? d : () => {}; },
    on() { return () => {}; },
    inject(services, cb) {
      seen.injects.push(services);
      cb({
        settings: {
          configure(presentation, owner) {
            seen.configure += 1;
            seen.autoPolicy = presentation && presentation.auto;
            return () => {};
          }
        },
        web: {
          registerSearchProvider(provider) { providers.search.push(provider); return () => {}; },
          registerFetchProvider(provider) { providers.fetch.push(provider); return () => {}; }
        },
        effect: ctx.effect,
        on: ctx.on,
        fiber: ctx.fiber
      });
      return () => {};
    },
    tools: { register(def) { registered.push(def); return () => {}; } }
  };
  return { ctx, registered, providers, seen };
}

{
  const { ctx, registered, providers, seen } = makeCtx();
  const ret = ENTRY.apply(ctx, { cdpEnabled: true, tavilyEnabled: false });
  assert.equal(ret, undefined, "apply 必须同步返回 undefined");
  assert.equal(seen.configure, 1, "必须经 ctx.inject([settings]) 调 settings.configure 一次");
  assert.equal(seen.autoPolicy, false, "必须注册 auto:false（关闭宿主自动默认页，卡片由 client 半提供）");
  assert.deepEqual(seen.injects, [["settings"], ["web"]], "apply 内必须等待式注入 settings 与 web");
  assert.equal(registered.length, 2, "两个独立工具");
  assert.deepEqual(registered.map((t) => t.name).sort(), ["web_fetch_cdp", "web_fetch_tavily"]);
  assert.equal(providers.search.length, 1, "一个搜索 provider");
  assert.equal(providers.search[0].id, "custom");
  assert.equal(typeof providers.search[0].available, "function");
  assert.equal(typeof providers.search[0].search, "function");
  assert.equal(providers.fetch.length, 1, "一个抓取 provider");
  assert.equal(providers.fetch[0].id, "anysearch");
  assert.equal(typeof providers.fetch[0].available, "function");
  assert.equal(typeof providers.fetch[0].fetch, "function");
}
ok("apply：同步 / configure({auto:false}) / 等待式注入 / 2 provider + 2 工具");

// 等待式注入也要能在 web 缺席时正常工作（抓取工具照常注册）
{
  const registered = [];
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
    on() { return () => {}; },
    inject() { return () => {}; }, // settings / web 都不回调
    tools: { register(def) { registered.push(def); return () => {}; } }
  };
  ENTRY.apply(ctx, {});
  assert.equal(registered.length, 2, "web/settings 缺席时仍注册两个工具");
}
ok("web 服务缺席：抓取工具照常注册（等待式注入不阻塞加载）");

// ---------------------------------------------------------------------------
// 3. 热读：volatile 活引用逐次现读
// ---------------------------------------------------------------------------
{
  const live = { key: "", maxResults: 2 };
  const volatileRow = {
    searchUrl: { get: () => "https://api.anysearch.com/v1/search" },
    searchApiKey: { get: () => live.key },
    searchMaxResults: { get: () => live.maxResults }
  };
  const { ctx, providers } = makeCtx();
  ENTRY.apply(ctx, volatileRow);
  const p = providers.search[0];
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { results: [] } }) };
  };
  try {
    await p.search({ query: "q" });
    assert.equal(headerValue(calls[0].init.headers, "authorization"), undefined, "空 key 不发 Authorization");
    live.key = "as_sk_live";
    live.maxResults = 3;
    await p.search({ query: "q" });
    assert.equal(headerValue(calls[1].init.headers, "authorization"), "Bearer as_sk_live", "下次调用必须读到新 key");
    assert.equal(JSON.parse(calls[1].init.body).max_results, 3, "maxResults 也必须现读");
  } finally { globalThis.fetch = real; }
}
ok("搜索 provider 热读：volatile 活引用逐次现读（设置页保存即时生效）");

{
  const live = { cdpEnabled: false };
  const { ctx, registered } = makeCtx();
  ENTRY.apply(ctx, {
    cdpEnabled: { get: () => live.cdpEnabled },
    cdpEndpoint: { get: () => "http://127.0.0.1:1" }
  });
  const cdp = registered.find((t) => t.name === "web_fetch_cdp");
  await assert.rejects(() => cdp.execute({ url: "https://example.com" }, undefined),
    (err) => err.message.includes("data source disabled"), "初始禁用态应报禁用");
  live.cdpEnabled = true;
  let message = "";
  try { await cdp.execute({ url: "example.com" }, undefined); } catch (err) { message = String(err.message); }
  assert.ok(!message.includes("data source disabled"), "execute 必须现读 volatile 活引用：" + message);
  assert.ok(/web-custom \(cdp\)/.test(message), "启用后应走到真实连接失败路径：" + message);
}
ok("抓取工具热读：同一个活引用换值后立即生效");

// 非 volatile 裸值形状同样可用
{
  const { ctx, registered } = makeCtx();
  ENTRY.apply(ctx, { cdpEnabled: true, cdpEndpoint: "http://127.0.0.1:1" });
  const cdp = registered.find((t) => t.name === "web_fetch_cdp");
  let message = "";
  try { await cdp.execute({ url: "example.com" }, undefined); } catch (err) { message = String(err.message); }
  assert.ok(!message.includes("data source disabled"), "裸值形状不应被判为禁用：" + message);
}
ok("兼容：非 volatile 裸值配置形状仍可用");

// ---------------------------------------------------------------------------
// 4. 工具声明面 + 禁用态文案
// ---------------------------------------------------------------------------
{
  const { ctx, registered } = makeCtx();
  ENTRY.apply(ctx, {});
  for (const tool of registered) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.output, "object", tool.name + " must declare output");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.parameters && tool.parameters.properties && tool.parameters.properties.url);
    assert.equal(Object.hasOwn(tool.parameters.properties, "query"), false);
  }
}
ok("两工具声明面完整（output.schema + render + url 参数）");

{
  const { ctx, registered } = makeCtx();
  ENTRY.apply(ctx, { cdpEnabled: false, tavilyEnabled: false });
  const cdp = registered.find((t) => t.name === "web_fetch_cdp");
  await assert.rejects(() => cdp.execute({ url: "https://example.com" }, undefined),
    (err) => err.message.includes("data source disabled") && err.message.includes("cdpEnabled") && err.message.includes("Plugins page"));
}
ok("禁用态文案含字段名 + 当前值 + 插件页指引");

// ---------------------------------------------------------------------------
// 5. 键集合三处一致
// ---------------------------------------------------------------------------
const hostKeys = Object.keys(ENTRY.Config.dict ?? {}).sort();
const fieldsBlock = /const FIELD_KEYS=\[([\s\S]*?)\];/.exec(clientSource)[1];
const clientKeys = [...fieldsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort();
const configBlock = /- insert:[\s\S]*$/.exec(patchSource)[0];
const patchKeys = [...configBlock.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort();
assert.deepEqual(hostKeys, clientKeys, "host schema 与 client 表单必须逐键相等");
assert.deepEqual(hostKeys, patchKeys, "host schema 与随包补丁 config 必须逐键相等");
assert.equal(hostKeys.length, 29, "三处键集合都必须是 29 键");
ok("三处键集合逐键相等（Config ↔ client FIELD_KEYS ↔ cordis.patch.yml，29 键）");

const viewsBlock = /const FIELD_VIEWS = \[([\s\S]*?)\n    \];/.exec(clientSource)[1];
const viewKeys = [...viewsBlock.matchAll(/key: "([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
const TOGGLE_KEYS = ["cdpEnabled", "tavilyEnabled", "anysearchEnabled", "anysearchFallbackToHttp"];
for (const key of viewKeys) assert.ok(clientKeys.includes(key), "FIELD_VIEWS key must exist in FIELD_KEYS: " + key);
for (const key of TOGGLE_KEYS) assert.ok(!viewKeys.includes(key), "布尔开关单独渲染: " + key);
assert.equal(viewKeys.length, clientKeys.length - TOGGLE_KEYS.length, "每个非开关字段都必须有行视图");
ok("client FIELD_VIEWS 是 FIELD_KEYS 的输入框子集（4 个开关单独渲染）");

// ---------------------------------------------------------------------------
// 6. manifest / engines / 依赖卫生
// ---------------------------------------------------------------------------
assert.equal(pkg.version, "0.4.0");
assert.equal(pkg.main, "src/index.js");
assert.equal(pkg.exports["."], "./src/index.js");
assert.equal(pkg.exports["./client"], "./lib/client.js");
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
assert.equal(pkg.dsh.client.platform, "web");
assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-primitives") === false,
  "inject 列表沿用搜索侧已验证的 4 项（primitives 由 ui-plugin-manager 暴露）");
for (const f of ["src", "lib", "tests", "cordis.patch.yml", "README.md", "LICENSE"]) {
  assert.ok(pkg.files.includes(f), "files must ship " + f);
}
ok("manifest：0.4.0 / exports / bundle patch / client 平台与 inject 声明");

const clause = pkg.dsh.engines.dsh;
for (const name of ["@deepseek-ai/dsh", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-tools"]) {
  assert.equal(pkg.peerDependencies[name], clause, name + " peer 区间必须与 dsh.engines.dsh 逐字一致");
}
const req = createRequire(import.meta.url);
let semver;
for (const candidate of ["semver", "@deepseek-ai/dsh/node_modules/semver"]) {
  try { semver = req(candidate); break; } catch { /* next */ }
}
if (semver && typeof semver.satisfies === "function") {
  for (const [version, expected] of [["0.2.2-rc.1", true], ["0.2.2", true], ["0.3.0", false], ["0.1.8", false]]) {
    assert.equal(semver.satisfies(version, clause), expected, "strict semver disagrees for " + version);
    assert.equal(semver.satisfies(version, clause, { includePrerelease: true }), expected, "host gate disagrees for " + version);
  }
  ok("engines/peer：真实 semver 核验（0.2.2-rc.1 放行，0.3.0 / 0.1.8 排除）");
} else {
  ok("semver 不可解析，跳过交叉验证（不假绿）");
}

for (const key of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
  assert.ok(!(pkg.scripts && pkg.scripts[key]), "must not declare a lifecycle script: " + key);
}
assert.equal(pkg.dependencies, undefined, "零运行时 dependencies（只声明 peerDependencies）");
assert.equal(pkg.optionalDependencies, undefined);
ok("依赖卫生：无安装期脚本、无 runtime dependencies（peer-only）");

console.log("\n全部通过: " + passed + " 组");
