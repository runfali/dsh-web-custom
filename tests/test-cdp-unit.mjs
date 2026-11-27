/** dsh-web-fetch — CDP 策略与辅助函数单元测试。 */
import assert from "node:assert/strict"
import { numberOr, redactCredentials, withTimeout, plainText, truncate, source } from "../src/helpers.js"
import { makeCdpStrategy, resolveCdpCfg } from "../src/strategies/cdp.js"

let passed = 0, failed = 0
async function ok(name, fn) {
  try { await fn(); passed += 1; console.log("  ✓ " + name) }
  catch (err) { failed += 1; console.log("  ✗ " + name); console.log("    " + (err && err.message ? err.message : String(err))) }
}

async function run() {
  console.log("[helpers]")
  await ok("plainText 去掉 HTML 标签并折叠空白", () => { assert.equal(plainText("<p>  hello <b>world</b>  </p>"), "hello world") })
  await ok("plainText 剥离 Markdown 粗体", () => { assert.equal(plainText("**bold**"), "bold") })
  await ok("plainText 处理空/非字符串", () => { assert.equal(plainText(""), ""); assert.equal(plainText(null), ""); assert.equal(plainText(undefined), ""); assert.equal(plainText(123), "") })
  await ok("truncate 在边界内不裁剪", () => { assert.equal(truncate("hi", 5), "hi") })
  await ok("truncate 在边界处裁剪并加省略号", () => { assert.equal(truncate("abcdefgh", 5), "abcd…") })
  await ok("truncate 不切半 UTF-16 代理对", () => {
    const grin = "\uD83D\uDE00" // 两个码元合起来才是完整码点
    assert.equal(truncate("x" + grin + "y", 3), "x…")
    assert.equal(truncate("ab" + grin + "cd", 4), "ab…")
    assert.equal(truncate(grin + grin, 3), grin + "…")
    assert.equal(truncate(grin, 1), "…")
    for (const [text, n] of [["x" + grin + "y", 3], ["ab" + grin + "cd", 4], [grin + grin, 3], ["abcdefgh", 5]]) {
      const out = truncate(text, n)
      assert.ok(out.length <= n, "输出长度必须 ≤ " + n)
      const last = out.charCodeAt(out.length - 1)
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), "输出不得以孤立高代理结尾")
    }
  })
  await ok("source 构造 WebSource", () => { assert.deepEqual(source("http://x.com", { title:"X", snippet:"s", content:"c", provider:"cdp" }), { url:"http://x.com", title:"X", snippet:"s", content:"c", provider:"cdp" }) })
  await ok("withTimeout 在超时会中止并清理", async () => { const w = withTimeout(undefined, 5); await new Promise(r => setTimeout(r, 20)); assert.equal(w.signal.aborted, true); w.cleanup() })
  await ok("withTimeout 传播上游 signal", async () => { const outer = new AbortController(); const w = withTimeout(outer.signal, 5000); outer.abort(new Error("upstream")); assert.equal(w.signal.aborted, true); w.cleanup() })
  await ok("numberOr：0 是合法值，缺失/非数字/低于下限回退默认", () => {
    assert.equal(numberOr(0, 2000, 0), 0)
    assert.equal(numberOr("0", 2000, 0), 0)
    assert.equal(numberOr(5000, 2000, 1000), 5000)
    assert.equal(numberOr(500, 2000, 1000), 2000)
    assert.equal(numberOr(-5, 2000, 0), 2000)
    assert.equal(numberOr(undefined, 2000, 0), 2000)
    assert.equal(numberOr(null, 2000, 0), 2000)
    assert.equal(numberOr("", 2000, 0), 2000)
    assert.equal(numberOr("abc", 2000, 0), 2000)
  })
  await ok("redactCredentials：k=v / JSON 形状 / as_sk_ 前缀都脱敏，正常文案不受损", () => {
    const out = redactCredentials('{"api_key":"as_sk_700b","password":"p-leak"}')
    assert.ok(!out.includes("as_sk_700b"), out)
    assert.ok(!out.includes("p-leak"), out)
    assert.equal(redactCredentials("api_key=sk-leak"), "api_key=<redacted>")
    assert.ok(!redactCredentials("bearer sk-leak-abc").includes("sk-leak-abc"))
    assert.equal(redactCredentials("invalid api key"), "invalid api key")
    assert.equal(redactCredentials("rate limited: retry later"), "rate limited: retry later")
  })

  console.log("[CDP strategy factory]")
  await ok("默认配置下 endpoint 回退到默认值", () => { const s = makeCdpStrategy({}); assert.equal(s.id, "cdp"); assert.equal(s.available(), true) })
  await ok("available 返回 true 当 endpoint 合法", () => { assert.equal(makeCdpStrategy({ endpoint:"http://127.0.0.1:9222" }).available(), true) })
  await ok("available 拒绝非法协议", () => { assert.equal(makeCdpStrategy({ endpoint:"gopher://x" }).available(), false) })
  await ok("resolveCdpCfg：cdpWaitMs=0 不被 || 吃掉（0 = 不额外等待）", () => {
    assert.equal(resolveCdpCfg({ cdpWaitMs: 0 }).cfg.waitMs, 0)
    assert.equal(resolveCdpCfg({ cdpWaitMs: 500 }).cfg.waitMs, 500)
    assert.equal(resolveCdpCfg({}).cfg.waitMs, 2000)
    assert.equal(resolveCdpCfg({ cdpWaitMs: -1 }).cfg.waitMs, 2000)
  })
  await ok("resolveCdpCfg：超时下限 1000，0/越界回退 60000", () => {
    assert.equal(resolveCdpCfg({ cdpTimeoutMs: 5000 }).cfg.timeoutMs, 5000)
    assert.equal(resolveCdpCfg({ cdpTimeoutMs: 0 }).cfg.timeoutMs, 60000)
    assert.equal(resolveCdpCfg({ cdpTimeoutMs: 999 }).cfg.timeoutMs, 60000)
  })
  await ok("resolveCdpCfg：ws/wss 端点归一化为 http/https", () => {
    assert.equal(resolveCdpCfg({ cdpEndpoint: "ws://10.0.0.5:9222/" }).endpoint, "http://10.0.0.5:9222")
    assert.equal(resolveCdpCfg({ cdpEndpoint: "wss://h.example" }).endpoint, "https://h.example")
    assert.equal(resolveCdpCfg({}).endpoint, "http://127.0.0.1:9222")
  })
  await ok("fetch 拒绝空 url", async () => { const s = makeCdpStrategy({ endpoint:"http://127.0.0.1:9222" }); try { await s.fetch({ url:"" }); assert.fail("should throw") } catch {} })
  await ok("fetch 对缺少协议的 URL 自动补 http", async () => { const s = makeCdpStrategy({ endpoint:"http://127.0.0.1:1" }); try { await s.fetch({ url:"example.com" }); assert.fail("should throw") } catch {} })
  await ok("fetch 对已中止的 signal 立即拒绝且零网络", async () => {
    const s = makeCdpStrategy({ endpoint: "http://127.0.0.1:9" })
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => s.fetch({ url: "https://x.example" }, ac.signal), (e) => /cdp fetch aborted/.test(String(e.message)))
  })
  await ok("connect 失败时带出底层原因（端口无人监听不再只说「无 webSocketDebuggerUrl」）", async () => {
    const s = makeCdpStrategy({ endpoint: "http://127.0.0.1:1" })
    let message = ""
    try { await s.fetch({ url: "example.com" }) } catch (err) { message = String(err.message) }
    assert.match(message, /无 webSocketDebuggerUrl/)
    assert.match(message, /请求失败/)
  })

  // 合并轮：旧 router.js（71 行）是早期设计残留，只被本文件引用，已随死代码删除。
  // 工具选择改由模型在 web_fetch_cdp / web_fetch_tavily 两个独立工具间自主决策，
  // 对应行为在 entry.test.mjs（工具声明面 + 禁用态文案）与 host-integration 覆盖。
  console.log("========================================")
  console.log("  passed: " + passed + ", failed: " + failed)
  if (failed > 0) process.exit(1)
}
run().catch(e => { console.error(e); process.exit(1) })