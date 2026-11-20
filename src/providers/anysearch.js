/**
 * dsh-web-fetch — AnySearch Extract 数据源（宿主 WebFetchProvider 实现）。
 *
 * 与 src/strategies/*.js 的分工：
 *   strategies  → 本插件自己的工具（web_fetch_cdp / web_fetch_tavily），工具名自己起；
 *   providers   → 接管宿主原生 web_fetch 的数据源：宿主按 web 行的 config.fetchProvider
 *                 选出唯一 provider，工具名、参数与输出 schema 全部不变。这正是
 *                 dsh-web-search-custom 接管 web_search 的机制。
 *
 * 实测边界（2026-11-12，18 个真实 URL）：正常 HTML 页面返回干净 Markdown，字符数约
 * 为原始 HTML 的 1/10；但 PDF、raw.githubusercontent、github blob 文件视图、知乎全站
 * 一律 422 extract_failed，且不做 JS 渲染。因此内置 HTTP 直取兜底——extract 失败即回落
 * 到原生行为，绝不让 web_fetch 比不装插件时更弱。
 *
 * 宿主契约（@deepseek-ai/dsh-web 的 WebFetchProvider）：
 *   { id, available(): boolean, fetch(request: { url }, signal) }
 *   => { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }
 */
import { withTimeout, truncate } from "../helpers.js"

/** provider 注册键，profile 里 web 行的 config.fetchProvider 必须等于它。 */
export const ANYSEARCH_FETCH_PROVIDER_ID = "anysearch"
export const DEFAULT_ANYSEARCH_ENDPOINT = "https://api.anysearch.com/v1/extract"
export const DEFAULT_ANYSEARCH_TIMEOUT_MS = 30000
export const DEFAULT_ANYSEARCH_MAX_CHARS = 100000
/** 与宿主 @deepseek-ai/dsh-web-fetch-http 一致：显式产品 UA，绝不伪装浏览器。 */
export const HTTP_FALLBACK_USER_AGENT = "deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)"

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value))
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** 规范化目标 URL：缺协议补 https，非 http(s) 直接拒绝。 */
export function normalizeFetchUrl(raw) {
  const text = String(raw === null || raw === undefined ? "" : raw).trim()
  if (!text) throw new Error("url is empty")
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : "https://" + text
  if (!isHttpUrl(candidate)) throw new Error("unsupported url (only http/https): " + text)
  return new URL(candidate).href
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1000 ? Math.trunc(n) : fallback
}

/**
 * 把 /v1/extract 响应映射成 WebFetchResult。
 * data.content 缺失即视为失败（对应 400/401/402/403/422/429 各档错误体）。
 */
export function mapExtractPayload(payload, requestUrl, maxChars) {
  const data = payload && typeof payload === "object" ? payload.data : null
  if (!data || typeof data !== "object" || typeof data.content !== "string" || data.content === "") {
    const code = payload && payload.code !== undefined ? String(payload.code) : "no-code"
    const message = payload && payload.message ? String(payload.message) : "empty extract payload"
    throw new Error("AnySearch extract failed (code " + code + ": " + message + ") for " + requestUrl)
  }
  const title = typeof data.title === "string" ? data.title.trim() : ""
  let content = data.content
  if (title && !content.startsWith("# ")) content = "# " + title + "\n\n" + content
  const truncated = content.length > maxChars
  if (truncated) content = truncate(content, maxChars)
  return {
    url: typeof data.url === "string" && data.url ? data.url : requestUrl,
    statusCode: 200,
    body: { kind: "text", content },
    truncated
  }
}

/**
 * 构造 AnySearch fetch provider。readConfig 是 thunk：每次调用现读配置行，
 * 设置页保存（volatile 原地提交）后无需重启即生效。
 */
export function makeAnySearchFetchProvider(readConfig) {
  const read = () => (typeof readConfig === "function" ? readConfig() || {} : {})

  async function extract(cfg, url, maxChars, signal) {
    const endpoint = cfg.anysearchEndpoint === undefined ? DEFAULT_ANYSEARCH_ENDPOINT : String(cfg.anysearchEndpoint)
    const timeout = withTimeout(signal, positiveInt(cfg.anysearchTimeoutMs, DEFAULT_ANYSEARCH_TIMEOUT_MS))
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: "Bearer " + String(cfg.anysearchApiKey || "")
        },
        // /v1/extract 校验很严：只允许 { url } 一个字段，不许多余键
        body: JSON.stringify({ url }),
        signal: timeout.signal
      })
      const raw = await response.text()
      let payload = null
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = null
      }
      if (!response.ok) {
        const code = payload && payload.code !== undefined ? String(payload.code) : "http-" + response.status
        const message = payload && payload.message ? String(payload.message) : raw.slice(0, 200)
        const err = new Error("AnySearch extract HTTP " + response.status + " (code " + code + ": " + message + ") for " + url)
        err.statusCode = response.status
        err.fromAnySearch = true
        throw err
      }
      return mapExtractPayload(payload, url, maxChars)
    } finally {
      timeout.cleanup()
    }
  }

  async function fetchDirect(url, maxChars, signal, timeoutMs) {
    const timeout = withTimeout(signal, timeoutMs)
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": HTTP_FALLBACK_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
        },
        redirect: "follow",
        signal: timeout.signal
      })
      const raw = await response.text()
      const truncated = raw.length > maxChars
      return {
        url: response.url || url,
        statusCode: response.status,
        body: { kind: "html", content: truncated ? truncate(raw, maxChars) : raw },
        truncated
      }
    } finally {
      timeout.cleanup()
    }
  }

  return {
    id: ANYSEARCH_FETCH_PROVIDER_ID,

    /** 廉价本地可用性检查（不发网络请求）：extract 或 HTTP 兜底至少一条路通。 */
    available() {
      const cfg = read()
      const endpointReady = isHttpUrl(cfg.anysearchEndpoint === undefined ? DEFAULT_ANYSEARCH_ENDPOINT : cfg.anysearchEndpoint)
      const extractReady =
        cfg.anysearchEnabled !== false && String(cfg.anysearchApiKey || "") !== "" && endpointReady
      const fallbackReady = cfg.anysearchFallbackToHttp !== false
      return extractReady || fallbackReady
    },

    async fetch(request, signal) {
      const cfg = read()
      const url = normalizeFetchUrl(request && request.url)
      const maxChars = positiveInt(cfg.anysearchMaxChars, DEFAULT_ANYSEARCH_MAX_CHARS)
      const timeoutMs = positiveInt(cfg.anysearchTimeoutMs, DEFAULT_ANYSEARCH_TIMEOUT_MS)
      const useExtract = cfg.anysearchEnabled !== false && String(cfg.anysearchApiKey || "") !== ""
      if (useExtract) {
        try {
          return await extract(cfg, url, maxChars, signal)
        } catch (err) {
          if (cfg.anysearchFallbackToHttp === false) throw err
          // PDF / raw 文件 / 知乎等站点 extract 必 422：回落原生 HTTP 直取
          return await fetchDirect(url, maxChars, signal, timeoutMs)
        }
      }
      return await fetchDirect(url, maxChars, signal, timeoutMs)
    }
  }
}
