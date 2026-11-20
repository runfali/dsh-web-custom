/**
 * dsh-web-fetch — AnySearch fetch provider 单元测试.
 * 纯本地：拦截 globalThis.fetch 模拟 /v1/extract 与 HTTP 直取，不发真实网络请求。
 */
import assert from "node:assert/strict"
import {
  ANYSEARCH_FETCH_PROVIDER_ID,
  makeAnySearchFetchProvider,
  mapExtractPayload,
  normalizeFetchUrl
} from "../src/providers/anysearch.js"

let calls = []

function stubFetch(handlers) {
  const real = globalThis.fetch
  calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts })
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]
    return handler(String(url), opts)
  }
  return () => {
    globalThis.fetch = real
  }
}

function jsonResponse(status, payload, url) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: url || "https://example.com/",
    text: async () => JSON.stringify(payload)
  }
}

function textResponse(status, body, url) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: url || "https://example.com/",
    text: async () => body
  }
}

const liveCfg = { anysearchEnabled: true, anysearchApiKey: "as_sk_test", anysearchFallbackToHttp: true }

async function run() {
  console.log("[AnySearch provider]")

  {
    const p = makeAnySearchFetchProvider(() => liveCfg)
    assert.equal(p.id, ANYSEARCH_FETCH_PROVIDER_ID)
    assert.equal(ANYSEARCH_FETCH_PROVIDER_ID, "anysearch")
    assert.equal(p.available(), true)
    console.log("  ok id=anysearch，配了 key 时 available() 为 true")
  }

  {
    const off = makeAnySearchFetchProvider(() => ({ anysearchEnabled: false, anysearchFallbackToHttp: false }))
    assert.equal(off.available(), false)
    const onlyFallback = makeAnySearchFetchProvider(() => ({ anysearchEnabled: false, anysearchFallbackToHttp: true }))
    assert.equal(onlyFallback.available(), true)
    console.log("  ok 只有 extract 与兜底都关掉时 available() 才是 false")
  }

  {
    assert.equal(normalizeFetchUrl("example.com"), "https://example.com/")
    assert.equal(normalizeFetchUrl(" http://a.b/c "), "http://a.b/c")
    let threw = false
    try {
      normalizeFetchUrl("ftp://x/y")
    } catch {
      threw = true
    }
    assert.equal(threw, true)
    console.log("  ok URL 规范化：缺协议补 https，非 http(s) 拒绝")
  }

  {
    const clean = stubFetch([
      () =>
        jsonResponse(200, {
          code: 0,
          message: "ok",
          data: { url: "https://example.com/", title: "Example Domain", content: "Some **markdown** body" }
        })
    ])
    const p = makeAnySearchFetchProvider(() => liveCfg)
    const res = await p.fetch({ url: "example.com" })
    clean()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.anysearch.com/v1/extract")
    assert.equal(JSON.parse(calls[0].opts.body).url, "https://example.com/")
    assert.equal(calls[0].opts.headers.authorization, "Bearer as_sk_test")
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.kind, "text")
    assert.equal(res.body.content.startsWith("# Example Domain"), true)
    assert.equal(res.truncated, false)
    console.log("  ok extract 成功：Markdown + 标题一级标题 + statusCode 200")
  }

  {
    const clean = stubFetch([
      () => jsonResponse(422, { code: 422, message: "extract_failed" }),
      () => textResponse(200, "<html>raw fallback</html>")
    ])
    const p = makeAnySearchFetchProvider(() => liveCfg)
    const res = await p.fetch({ url: "https://www.zhihu.com/question/1" })
    clean()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, "https://www.zhihu.com/question/1")
    assert.equal(res.body.kind, "html")
    assert.equal(res.body.content, "<html>raw fallback</html>")
    assert.equal(res.statusCode, 200)
    console.log("  ok extract 422 时回落 HTTP 直取（不抛错）")
  }

  {
    const clean = stubFetch([() => jsonResponse(422, { code: 422, message: "extract_failed" })])
    const p = makeAnySearchFetchProvider(() => Object.assign({}, liveCfg, { anysearchFallbackToHttp: false }))
    let message = ""
    try {
      await p.fetch({ url: "https://example.com/" })
    } catch (err) {
      message = err.message
    }
    clean()
    assert.equal(/422/.test(message), true)
    assert.equal(calls.length, 1)
    console.log("  ok 关闭兜底后 extract 失败直接抛错（带状态码）")
  }

  {
    const clean = stubFetch([() => textResponse(200, "<html>no key</html>")])
    const p = makeAnySearchFetchProvider(() => ({ anysearchEnabled: true, anysearchApiKey: "" }))
    const res = await p.fetch({ url: "example.com" })
    clean()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://example.com/")
    assert.equal(res.body.kind, "html")
    console.log("  ok 未配 key 时直接 HTTP 直取，不浪费一次 extract 调用")
  }

  {
    const clean = stubFetch([() => textResponse(200, "<html>" + "x".repeat(5000) + "</html>")])
    const p = makeAnySearchFetchProvider(() => Object.assign({}, liveCfg, { anysearchMaxChars: 1000 }))
    const res = await p.fetch({ url: "example.com" })
    clean()
    assert.equal(res.truncated, true)
    assert.equal(res.body.content.length <= 1000, true)
    console.log("  ok 超过 anysearchMaxChars 时截断并置 truncated")
  }

  {
    let threw = false
    try {
      mapExtractPayload({ code: 401, message: "invalid_api_key" }, "https://x/", 1000)
    } catch {
      threw = true
    }
    assert.equal(threw, true)
    console.log("  ok data 缺失（401 之类错误体）在映射阶段即抛错")
  }

  console.log("[AnySearch provider] all passed")
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
