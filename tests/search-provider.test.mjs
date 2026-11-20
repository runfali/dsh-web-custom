/**
 * search-provider.test.mjs —— 搜索 provider（src/search.js）行为守护。
 *
 * 合并自 dsh-web-search-custom 的 provider 单测，键名改成 search* 前缀后重跑：
 *   - 两档分派：auto 按主机名 → anysearch；显式 generic → 模板 GET/POST
 *   - AnySearch：POST {query,max_results}，无 key 不发 Authorization，带 key 发 Bearer
 *   - max_results 夹在 1..10 且取「配置 vs 调用方」较小者
 *   - 信封映射（snippet 回落 content / 去重 / file:// 丢弃 / 病态载荷降级空 sources）
 *   - 错误文案：HTTP 状态 + 厂商 message + request_id，且凭据被脱敏
 *   - generic：GET 自动补 q=、{query}/{queryRaw}/{apiKey} 占位符、自定义 headers
 *   - 取消 / 超时语义与 available() 廉价判定
 *
 * 运行：node tests/search-provider.test.mjs
 */
import assert from "node:assert/strict";
import { makeSearchProvider, SEARCH_PROVIDER_ID } from "../src/search.js";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ✓ " + label); };

// 生产路径上 Config 默认 searchUrl 已指向 AnySearch；测试显式补默认，避免空串落进 generic 分支。
const provider = (config = {}) => makeSearchProvider(() => ({ searchUrl: "https://api.anysearch.com/v1/search", ...config }));

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// 1. available()：廉价本地判定，不发网络
// ---------------------------------------------------------------------------
{
  const p = provider({ searchUrl: "https://api.anysearch.com/v1/search" });
  assert.equal(p.id, SEARCH_PROVIDER_ID);
  assert.equal(p.id, "custom");
  assert.equal(p.available(), true);
  assert.equal(provider({ searchUrl: "" }).available(), false);
  assert.equal(provider({ searchUrl: "ftp://example.com/search" }).available(), false);
  assert.equal(provider({ searchUrl: "http://127.0.0.1:18080/s?format=json" }).available(), true);
  assert.equal(provider({ searchUrl: "https://api.anysearch.com/v1/search", searchTimeoutMs: 0 }).available(), false);
}
ok("available()：只做本地 URL / 超时判定（空 / ftp / 0 超时 = 不可用）");

// ---------------------------------------------------------------------------
// 2. AnySearch 档：信封、鉴权、headers
// ---------------------------------------------------------------------------
{
  const calls = [];
  const restore = stubFetch(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ code: 0, data: { results: [] } }); });
  try {
    await provider({}).search({ query: "hello world" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anysearch.com/v1/search");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(headerValue(calls[0].init.headers, "authorization"), undefined, "empty key must not send Authorization at all");
    assert.equal(headerValue(calls[0].init.headers, "content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: "hello world", max_results: 10 });
  } finally { restore(); }
}
ok("AnySearch 档：POST 默认端点 + {query,max_results} 信封，空 key 完全不发鉴权头");

{
  const calls = [];
  const restore = stubFetch(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ code: 0, data: { results: [] } }); });
  try {
    await provider({ searchApiKey: "as_sk_test", searchHeaders: '{"x-tag":"demo"}' }).search({ query: "q" });
    assert.equal(headerValue(calls[0].init.headers, "authorization"), "Bearer as_sk_test");
    assert.equal(headerValue(calls[0].init.headers, "x-tag"), "demo");
  } finally { restore(); }
}
ok("AnySearch 档：有 key 发 Bearer，自定义 headers 透传");

{
  const calls = [];
  const restore = stubFetch(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ code: 0, data: { results: [] } }); });
  try {
    await provider({ searchApiKey: "as_sk_test", searchAuthHeader: "X-API-Key", searchAuthScheme: "" }).search({ query: "q" });
    assert.equal(headerValue(calls[0].init.headers, "x-api-key"), "as_sk_test", "empty scheme sends the raw key");
  } finally { restore(); }
}
ok("鉴权头可配置：searchAuthHeader / 空 searchAuthScheme 发裸 key");

// ---------------------------------------------------------------------------
// 3. max_results 夹取表
// ---------------------------------------------------------------------------
{
  const cases = [
    [{ searchMaxResults: 10 }, 2, 2],
    [{ searchMaxResults: 10 }, 50, 10],
    [{ searchMaxResults: 3 }, 50, 3],
    [{ searchMaxResults: 50 }, 20, 10],
    [{ searchMaxResults: 0 }, 5, 1],
    [{ searchMaxResults: 8 }, undefined, 8]
  ];
  for (const [config, requested, expected] of cases) {
    const bodies = [];
    const restore = stubFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ code: 0, data: { results: [] } }); });
    try {
      await provider(config).search(requested === undefined ? { query: "q" } : { query: "q", maxResults: requested });
    } finally { restore(); }
    assert.equal(bodies[0].max_results, expected,
      "config=" + JSON.stringify(config) + " requested=" + requested + " should clamp to " + expected);
  }
}
ok("max_results：夹在 1..10 且取配置与调用方较小者（6 行判定表）");

// ---------------------------------------------------------------------------
// 4. 信封映射
// ---------------------------------------------------------------------------
{
  const payload = {
    code: 0,
    data: {
      results: [
        { url: "https://a.example", title: "<b>A&amp;B</b>", snippet: "alpha&hellip;" },
        { url: "https://a.example", title: "dup", snippet: "dup" },
        { url: "https://b.example", title: "B", content: "from content" },
        { url: "file:///etc/passwd", title: "nope" },
        null,
        "garbage"
      ]
    }
  };
  const restore = stubFetch(async () => jsonResponse(payload));
  let result;
  try { result = await provider({}).search({ query: "q" }); } finally { restore(); }
  assert.equal(result.sources.length, 2, "duplicates and non-http entries must be dropped");
  assert.equal(result.sources[0].url, "https://a.example");
  assert.equal(result.sources[0].title, "A&B", "HTML stripped and entities decoded");
  assert.equal(result.sources[0].snippet, "alpha…");
  assert.equal(result.sources[1].snippet, "from content", "snippet falls back to content");
  assert.equal(result.truncated, false);
}
ok("信封映射：去重 / 丢弃 file:// / snippet 回落 content / HTML 清洗");

{
  const restore = stubFetch(async () => jsonResponse({ code: 0, data: { results: "not-an-array" } }));
  let result;
  try { result = await provider({}).search({ query: "q" }); } finally { restore(); }
  assert.deepEqual(result.sources, []);
}
ok("病态载荷：data.results 非数组 → 空 sources，不抛");

// ---------------------------------------------------------------------------
// 5. 错误文案与脱敏
// ---------------------------------------------------------------------------
{
  const restore = stubFetch(async () => jsonResponse({ code: 401, message: "invalid api key", request_id: "req-1" }, 401));
  let message = "";
  try { await provider({ searchApiKey: "as_sk_secret" }).search({ query: "q" }); } catch (error) { message = String(error.message); } finally { restore(); }
  assert.ok(message.includes("HTTP 401"), message);
  assert.ok(message.includes("invalid api key"), message);
  assert.ok(message.includes("req-1"), message);
  assert.ok(!message.includes("as_sk_secret"), "the key itself must never appear in the error: " + message);
}
ok("401：文案含 HTTP 状态 / 厂商 message / request_id，且不回显 key");

{
  const restore = stubFetch(async () => jsonResponse({ code: 402, message: "quota", api_key: "sk-leak", password: "p-leak" }, 402));
  let message = "";
  try { await provider({}).search({ query: "q" }); } catch (error) { message = String(error.message); } finally { restore(); }
  assert.ok(message.includes("HTTP 402"));
  assert.ok(!message.includes("sk-leak"), message);
  assert.ok(!message.includes("p-leak"), message);
}
ok("402：响应体里的 api_key / password 被脱敏");

{
  const restore = stubFetch(async () => jsonResponse({ code: 7, message: "vendor rejected" }, 200));
  await assert.rejects(() => provider({}).search({ query: "q" }), (error) => String(error.message).includes("vendor rejected"));
}
ok("HTTP 200 但信封 code !== 0 同样按失败处理");

// ---------------------------------------------------------------------------
// 6. generic 档
// ---------------------------------------------------------------------------
{
  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ results: [{ url: "http://x.example", title: "X" }] });
  });
  let result;
  try {
    result = await provider({ searchApi: "generic", searchUrl: "http://127.0.0.1:18080/search?format=json" }).search({ query: "hello world" });
  } finally { restore(); }
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].url.includes("q=hello%20world") || calls[0].url.includes("q=hello+world"), calls[0].url);
  assert.equal(result.sources[0].url, "http://x.example");
}
ok("generic：GET 缺 {query} 时自动补 q=，按 resultsPath 映射");

{
  const calls = [];
  const restore = stubFetch(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ results: [] }); });
  try {
    await provider({
      searchApi: "generic",
      searchUrl: "http://127.0.0.1:18080/s?raw={queryRaw}&enc={query}&key={apiKey}",
      searchApiKey: "k-1"
    }).search({ query: "a b/c" });
  } finally { restore(); }
  assert.ok(calls[0].url.includes("raw=a b/c"), "queryRaw must stay unencoded: " + calls[0].url);
  assert.ok(calls[0].url.includes("enc=a%20b%2Fc"), "query must be encoded: " + calls[0].url);
  assert.ok(calls[0].url.includes("key=k-1"));
  assert.equal(headerValue(calls[0].init.headers, "authorization"), undefined, "key already embedded in URL must not be sent again");
}
ok("generic：{queryRaw} 不编码 / {query} 编码 / {apiKey} 内嵌后不再发鉴权头");

{
  const calls = [];
  const restore = stubFetch(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse({ results: [] }); });
  try {
    await provider({ searchUrl: "http://127.0.0.1:18080/s", searchApi: "auto" }).search({ query: "q" });
  } finally { restore(); }
  assert.equal(calls[0].init.method, "GET", "non-anysearch host under auto must use generic");
}
ok("auto 档：非 anysearch 主机走 generic（默认 URL 才走 anysearch）");

// ---------------------------------------------------------------------------
// 7. 取消与超时
// ---------------------------------------------------------------------------
{
  const controller = new AbortController();
  const restore = stubFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  try {
    const pending = provider({}).search({ query: "q" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error) => String(error.message).includes("custom web search aborted"));
  } finally { restore(); }
}
ok("调用方取消：保留 abort 语义（custom web search aborted）");

{
  // withTimeout 的 timer 是 unref 的（真实网络 socket 会撑住事件循环）；桩里补一个 ref 定时器，
  // 否则事件循环先空转退出、5ms 超时永远不触发（假绿变假挂）。
  const restore = stubFetch((url, init) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 100);
    init.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("aborted")); }, { once: true });
  }));
  try {
    await assert.rejects(() => provider({ searchTimeoutMs: 5, searchUrl: "http://127.0.0.1:18080/s" }).search({ query: "q" }),
      (error) => String(error.message).includes("timed out after 5 ms"));
  } finally { restore(); }
}
ok("超时：按 searchTimeoutMs 中止并给超时文案");

// ---------------------------------------------------------------------------
// 8. 热读：同一个 provider 实例逐次现读配置
// ---------------------------------------------------------------------------
{
  const live = { searchUrl: "http://127.0.0.1:18080/a?format=json", searchApi: "generic" };
  const p = makeSearchProvider(() => live);
  const calls = [];
  const restore = stubFetch(async (url) => { calls.push(String(url)); return jsonResponse({ results: [] }); });
  try {
    await p.search({ query: "one" });
    live.searchUrl = "http://127.0.0.1:19090/b?format=json";
    await p.search({ query: "two" });
  } finally { restore(); }
  assert.ok(calls[0].startsWith("http://127.0.0.1:18080/a"));
  assert.ok(calls[1].startsWith("http://127.0.0.1:19090/b"), "provider must read config per call: " + calls[1]);
}
ok("热读：同一 provider 实例每次 search 现读配置（设置卡保存即生效）");

console.log("\n全部通过: " + passed + " 组");
