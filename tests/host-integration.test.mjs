/**
 * host-integration.test.mjs —— 真宿主对象契约测试（不是自造桩）。
 *
 * 用本仓 devDependencies 里的 dsh 0.2.2-rc.1 真实包驱动本插件：
 *   1. 真实 Cordis Context + 真实 WebRuntime：apply 后 custom / anysearch 两个 provider
 *      真注册进 host 注册表（搜索与抓取分别一张表）
 *   2. 真实 ctx.web.search() 全链路：provider 选择 → 我们的 provider → seam capSources
 *   3. 真实 ctx.web.fetch() 全链路：AnySearch Extract 成功路径 + 422 回落 HTTP 直取
 *   4. 真实 volatile 协议（@deepseek-ai/cosmokit）：设置卡保存 = 原地提交引用，
 *      下一次 search/fetch 立刻读到新值（不是 apply 快照）
 *   5. 真实 provider 选择语义：configured-id 不可用 → WEB_PROVIDER_CONFIGURED_UNAVAILABLE；
 *      同 id 重复注册 → WEB_DUPLICATE_PROVIDER（新旧包不能并存的契约依据）
 *   6. 真实 ToolRuntime：两个独立工具进真注册表，schema 投影保留 url / 去掉 query
 *   7. 真实 SettingsForms：describe() 枚举到 web-custom、29 字段默认值、volatile 可写、
 *      schema 外字段被拒
 *   8. 真实兼容闸 evaluatePluginCompatibility 接受本仓 peer 区间并拒绝 0.3.0
 *   9. 真实 client 包：dsh.client.inject 四包存在且是 web bundle；primitives 导出本卡组件
 *
 * 依赖解析：本仓 node_modules（devDependencies，与宿主同版）→ @deepseek-ai/dsh 包依赖树。
 * 解析不到时显式 skip 并打印原因（不假绿）。
 *
 * 运行：node tests/host-integration.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ✓ " + label); };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ENTRY = await import("../src/index.js");

const baseRequire = createRequire(import.meta.url);
let DSH_PKG;
try { DSH_PKG = baseRequire.resolve("@deepseek-ai/dsh/package.json"); } catch { DSH_PKG = undefined; }

/** 解析包目录：本仓 node_modules 优先，其次 @deepseek-ai/dsh 自己的依赖树。 */
function resolveDepDir(name) {
  const bases = [import.meta.url];
  if (DSH_PKG !== undefined) bases.push(DSH_PKG);
  for (const from of bases) {
    try { return dirname(createRequire(from).resolve(name + "/package.json")); } catch { /* next */ }
  }
  return undefined;
}

/** 按包自身 exports/main 解析 ESM 入口并真实 import（不猜文件布局）。 */
async function loadDep(name) {
  const dir = resolveDepDir(name);
  if (dir === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entry = manifest.exports?.["."];
  const rel = typeof entry === "string" ? entry : (entry?.import ?? entry?.default ?? manifest.module ?? manifest.main);
  return import(pathToFileURL(join(dir, rel)).href);
}

const DEP_NAMES = [
  "@deepseek-ai/cordis", "@deepseek-ai/dsh-web", "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-app-boot", "@deepseek-ai/cosmokit", "@deepseek-ai/schemastery"
];
const missing = DEP_NAMES.filter((name) => resolveDepDir(name) === undefined);
if (missing.length > 0) {
  console.log("SKIP: unresolvable host deps: " + missing.join(", ") + " (run pnpm install)");
  process.exit(0);
}

const [cordisMod, webMod, toolsMod, promptMod, settingsMod, bootMod, cosmo] = await Promise.all([
  loadDep("@deepseek-ai/cordis"), loadDep("@deepseek-ai/dsh-web"), loadDep("@deepseek-ai/dsh-tools"),
  loadDep("@deepseek-ai/dsh-system-prompt"), loadDep("@deepseek-ai/dsh-settings"),
  loadDep("@deepseek-ai/dsh-app-boot"), loadDep("@deepseek-ai/cosmokit")
]);
const Context = cordisMod.Context ?? cordisMod.default?.Context;
const WebRuntime = webMod.WebRuntime ?? webMod.default;
const ToolRuntime = toolsMod.default ?? toolsMod.ToolRuntime;
const SystemPrompt = promptMod.SystemPrompt;
const SettingsForms = settingsMod.default ?? settingsMod.SettingsForms;
const evaluatePluginCompatibility = bootMod.evaluatePluginCompatibility;
const { createVolatile, updateVolatile } = cosmo;
assert.equal(typeof Context, "function", "real cordis Context must be constructible");
assert.equal(typeof WebRuntime, "function", "real WebRuntime must be constructible");
assert.equal(typeof ToolRuntime, "function", "real ToolRuntime must be constructible");
assert.equal(typeof SettingsForms, "function", "real SettingsForms must be constructible");
assert.equal(typeof createVolatile, "function", "real cosmokit createVolatile must exist");
ok("真实宿主包可解析：cordis / dsh-web / dsh-tools / dsh-system-prompt / dsh-settings / app-boot / cosmokit");

const CONFIG_KEYS = ENTRY.CONFIG_KEYS;
assert.equal(CONFIG_KEYS.length, 29, "merged Config must have exactly 29 fields");

/** schema 解析出的默认值（volatile 注解不影响 schema 直接 resolve）。 */
function plainDefaults() {
  const resolved = ENTRY.Config({});
  const out = {};
  for (const [key, value] of Object.entries(resolved)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

/** 真实的 apply 输入形状：29 字段齐备，volatile 字段是 {get()} 活引用。 */
function liveConfig(overrides = {}) {
  const defaults = plainDefaults();
  const config = {};
  for (const key of CONFIG_KEYS) {
    const raw = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key];
    config[key] = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw : createVolatile(raw);
  }
  return config;
}

/** 搭真实宿主：真 Context + 真 WebRuntime + 真 ToolRuntime + 真 SystemPrompt。 */
async function makeHost(webConfig, pluginConfig) {
  const app = new Context();
  const resolved = {};
  for (const key of Object.keys(WebRuntime.Config.dict ?? { searchProvider: 0, fetchProvider: 0 })) {
    resolved[key] = createVolatile(webConfig?.[key]);
  }
  // SystemPrompt 必须先注册（ToolRuntime 构造期就访问 ctx.systemPrompt.tools）。
  const systemPrompt = new SystemPrompt(app, {});
  const web = new WebRuntime(app, resolved);
  const tools = new ToolRuntime(app, { mode: "native" });
  const ctx = app.extend({ web, tools, systemPrompt });
  ENTRY.apply(ctx, pluginConfig ?? liveConfig());
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { ctx, web, tools };
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

const SEARCH_SAMPLE = {
  results: [
    { url: "https://a.example", title: "<b>A</b>", snippet: "alpha&hellip;" },
    { url: "https://b.example", title: "B", snippet: "beta" }
  ]
};

// ---------------------------------------------------------------------------
// 1. provider 真注册 + web.search 全链路 + seam 截断
// ---------------------------------------------------------------------------
{
  const pluginConfig = liveConfig({ searchApi: "generic", searchUrl: "http://127.0.0.1:18080/search?format=json" });
  const host = await makeHost({ searchProvider: "custom", fetchProvider: "anysearch" }, pluginConfig);
  assert.deepEqual([...host.web.searchProviders.keys()], ["custom"], "search provider must land in the real registry");
  assert.deepEqual([...host.web.fetchProviders.keys()], ["anysearch"], "fetch provider must land in the real registry");
  assert.equal(host.web.searchProviders.get("custom").available(), true);
  assert.equal(host.web.fetchProviders.get("anysearch").available(), true);

  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => SEARCH_SAMPLE };
  });
  try {
    const result = await host.web.search({ query: "hello world", maxResults: 1 });
    assert.equal(calls.length, 1);
    assert.ok(/q=hello(%20|\+)world/.test(calls[0].url), "generic GET must append the query: " + calls[0].url);
    assert.equal(result.sources.length, 1, "seam must cap sources to maxResults");
    assert.equal(result.truncated, true, "seam must flag truncation");
    assert.equal(result.sources[0].url, "https://a.example");
    assert.equal(result.sources[0].title, "A", "HTML must be stripped");
    assert.equal(result.sources[0].snippet, "alpha…", "entities must be decoded");
  } finally { restore(); }
}
ok("真实 WebRuntime：两 provider 入表；web.search 全链路 + seam capSources 截断");

// ---------------------------------------------------------------------------
// 2. web.fetch：Extract 成功 + 422 回落 HTTP 直取
// ---------------------------------------------------------------------------
{
  const pluginConfig = liveConfig({ anysearchApiKey: "k-test", anysearchEnabled: true });
  const host = await makeHost({ fetchProvider: "anysearch" }, pluginConfig);
  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true, status: 200, url: String(url),
      text: async () => JSON.stringify({ data: { title: "Doc T", content: "Hello body" } })
    };
  });
  try {
    const result = await host.web.fetch({ url: "https://a.example" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anysearch.com/v1/extract");
    assert.deepEqual(JSON.parse(calls[0].init.body), { url: "https://a.example/" }, "extract body must be exactly {url}");
    assert.equal(calls[0].init.headers.authorization, "Bearer k-test");
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.kind, "text");
    assert.ok(result.body.content.startsWith("# Doc T"), "title must be prepended as markdown heading");
    assert.ok(result.body.content.includes("Hello body"));
  } finally { restore(); }
}
ok("真实 WebRuntime.fetch：AnySearch Extract 命中（POST {url} + Bearer + 标题 Markdown）");

{
  const pluginConfig = liveConfig({ anysearchApiKey: "k-test", anysearchEnabled: true, anysearchFallbackToHttp: true });
  const host = await makeHost({ fetchProvider: "anysearch" }, pluginConfig);
  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return { ok: false, status: 422, url: String(url), text: async () => JSON.stringify({ code: 422, message: "extract_failed" }) };
    }
    return { ok: true, status: 200, url: String(url), text: async () => "<html><body>fallback body</body></html>" };
  });
  try {
    const result = await host.web.fetch({ url: "https://a.example/raw" });
    assert.equal(calls.length, 2, "extract failure must fall back to a direct HTTP fetch");
    assert.equal(calls[1].url, "https://a.example/raw");
    assert.equal(result.body.kind, "html");
    assert.ok(result.body.content.includes("fallback body"));
  } finally { restore(); }
}
ok("真实 WebRuntime.fetch：extract 422 → 原生 HTTP 直取兜底（绝不比不装插件更弱）");

// ---------------------------------------------------------------------------
// 3. 真实 volatile 提交：下一次调用读新值
// ---------------------------------------------------------------------------
{
  const urlRef = createVolatile("http://127.0.0.1:18080/search?format=json");
  const pluginConfig = liveConfig({ searchApi: "generic", searchUrl: urlRef });
  const host = await makeHost({ searchProvider: "custom" }, pluginConfig);
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => SEARCH_SAMPLE };
  });
  try {
    await host.web.search({ query: "before" });
    updateVolatile(urlRef, createVolatile("http://127.0.0.1:19090/search?format=json"));
    await host.web.search({ query: "after" });
  } finally { restore(); }
  assert.ok(calls[0].startsWith("http://127.0.0.1:18080/"), "first search uses the live value: " + calls[0]);
  assert.ok(calls[1].startsWith("http://127.0.0.1:19090/"), "after _commitVolatile the next search must read the new value: " + calls[1]);
}
ok("真实 volatile 协议：设置卡保存后下一次调用立刻生效（非 apply 快照）");

// ---------------------------------------------------------------------------
// 4. 选择语义：不可用 / 重复注册
// ---------------------------------------------------------------------------
{
  const pluginConfig = liveConfig({ searchUrl: "" });
  const host = await makeHost({ searchProvider: "custom" }, pluginConfig);
  await assert.rejects(() => host.web.search({ query: "x" }),
    (error) => error.code === "WEB_PROVIDER_CONFIGURED_UNAVAILABLE",
    "configured provider that reports unavailable must throw, not silently fall back");
}
ok("真实选择语义：configured 但 unavailable → WEB_PROVIDER_CONFIGURED_UNAVAILABLE（不回落）");

{
  const host = await makeHost({ fetchProvider: "anysearch" });
  assert.throws(() => host.web.registerFetchProvider({ id: "anysearch", available: () => true, fetch: async () => ({}) }),
    (error) => error.code === "WEB_DUPLICATE_PROVIDER",
    "two providers on one seam id must fail loudly — old and new bundles can never coexist");
}
ok("真实注册表：同 id 第二个 provider → WEB_DUPLICATE_PROVIDER（新旧包不可并存）");

// ---------------------------------------------------------------------------
// 5. 真实 ToolRuntime：两工具 + schema 投影
// ---------------------------------------------------------------------------
{
  const host = await makeHost({});
  const visible = [...host.tools.view().visible.keys()].sort();
  assert.deepEqual(visible, ["web_fetch_cdp", "web_fetch_tavily"], "real registry must carry both tools: " + JSON.stringify(visible));
  const schemas = host.tools.schemas();
  for (const name of ["web_fetch_cdp", "web_fetch_tavily"]) {
    const schema = schemas.find((s) => s.name === name);
    assert.ok(schema, name + " must appear in the schema projection");
    assert.ok(schema.parameters.properties.url, name + " must keep the url parameter");
    assert.equal(Object.hasOwn(schema.parameters.properties, "query"), false, name + " must not resurrect the legacy query parameter");
  }
}
ok("真实 ToolRuntime：两工具入表，schema 投影保留 url / 去掉 query");

// ---------------------------------------------------------------------------
// 6. 真实 SettingsForms（0.2.2 契约）
// ---------------------------------------------------------------------------
function makeSettingsHarness() {
  const root = new Context();
  root.provide("loader", { await: () => Promise.resolve() });
  root.provide("profileContext", { home: join(tmpdir(), "dsh-web-custom-harness") });
  const entries = [];
  const base = {};
  const userLayer = {};
  root.provide("configEditor", {
    entries: () => entries,
    configuration: () => entries.map((e) => ({ entry: e, inherited: base[e.options.id] ?? {}, override: userLayer[e.options.id] ?? {} })),
    documentPath: join(tmpdir(), "cordis.patch.yml"),
    edit: async (entry, change) => {
      const id = entry.options.id;
      userLayer[id] = await change(userLayer[id] ?? {}, base[id] ?? {});
    }
  });
  const settings = new SettingsForms(root);
  const addEntry = (id, schema) => {
    const runtime = { Config: schema };
    entries.push({
      id, options: { id, config: {} },
      // 0.2.2-rc.1 的 describe() 读 fiber.effectiveConfig；config 键留给旧宿主。
      fiber: {
        runtime, state: 2, uid: "uid-" + id,
        config: cordisMod.resolveConfig(runtime, {}),
        effectiveConfig: cordisMod.resolveConfig(runtime, {}),
        ctx: root
      }
    });
  };
  return { settings, addEntry, userLayer };
}

{
  const harness = makeSettingsHarness();
  harness.addEntry(ENTRY.SETTINGS_NS, ENTRY.Config);
  const described = harness.settings.describe();
  const row = described.find((d) => d.ns === ENTRY.SETTINGS_NS);
  assert.ok(row, "describe() must enumerate " + ENTRY.SETTINGS_NS + " (otherwise the plugin page has no settings card): " + JSON.stringify(described.map((d) => d.ns)));
  assert.equal(row.applies, "live", "volatile form must apply live (no fiber restart)");
  assert.deepEqual(Object.keys(row.value).sort(), [...CONFIG_KEYS].sort(), "describe() value must carry all 29 fields");
  assert.equal(row.value.searchApi, "auto");
  assert.equal(row.value.searchMaxResults, 10);
  assert.equal(row.value.cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(row.value.tavilyEnabled, false);
  assert.equal(row.value.anysearchEnabled, true);
  assert.equal(row.value.anysearchMaxChars, 100000);
  assert.deepEqual(row.user, {}, "clean host must have an empty user layer");

  await harness.settings.update(ENTRY.SETTINGS_NS, { tavilyEnabled: true, searchMaxResults: 5 });
  const written = harness.settings.describe().find((d) => d.ns === ENTRY.SETTINGS_NS);
  assert.deepEqual(written.user, { tavilyEnabled: true, searchMaxResults: 5 }, "update() must write volatile fields into the user layer");

  await assert.rejects(() => harness.settings.update(ENTRY.SETTINGS_NS, { nope: 1 }), /not volatile/,
    "fields outside the schema must be rejected (write surface stays closed)");
}
ok("真实 SettingsForms：web-custom 可见 / applies=live / 29 字段默认值 / volatile 可写 / 未知字段被拒");

// ---------------------------------------------------------------------------
// 7. 真实兼容闸
// ---------------------------------------------------------------------------
{
  for (const version of ["0.2.2-rc.1", "0.2.2", "0.2.1", "0.2.0", "0.1.7-rc.1", "0.1.5-rc.1"]) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined, "compat gate must accept " + version);
  }
  const rejected = evaluatePluginCompatibility(pkg, {}, "0.3.0");
  assert.notEqual(rejected, undefined, "0.3.0 must be rejected (unverified upper bound)");
  const unmet = rejected.requirements ?? rejected.peers;
  assert.ok(Object.keys(unmet).includes("@deepseek-ai/dsh"), "rejection must name the dsh peer: " + JSON.stringify(rejected));
}
ok("真实兼容闸：接受 0.2.2-rc.1 / 0.2.x / 0.1.x，拒绝 0.3.0");

// ---------------------------------------------------------------------------
// 8. client 半的真实包契约（源码级）
// ---------------------------------------------------------------------------
{
  const declared = pkg.dsh.client.inject ?? [];
  assert.equal(declared.length, 4, "client inject list keeps the four verified web bundles");
  for (const name of declared) {
    const dir = resolveDepDir(name);
    assert.notEqual(dir, undefined, "dsh.client.inject name must exist (typo guard): " + name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.dsh?.client?.platform, "web", name + " must be a web client bundle");
  }
  const primDir = resolveDepDir("@deepseek-ai/dsh-client-ui-primitives");
  const primSrc = readFileSync(join(primDir, "lib", "index.js"), "utf8");
  for (const name of ["SettingsForm", "SettingsValueField"]) {
    assert.ok(primSrc.includes(name), "real primitives must export " + name + " (client card depends on it)");
  }
}
ok("真实 client 包：inject 四包都存在且是 web bundle；primitives 确有本卡用到的两个组件");

console.log("\n全部通过: " + passed + " 组");
