/**
 * dsh-web-custom — 搜索 provider（ctx.web 能力缝），接管宿主原生 web_search。
 *
 * 两档策略（searchApi 字段：auto | anysearch | generic）：
 * - anysearch：AnySearch 专用档（POST https://api.anysearch.com/v1/search）。
 *   带 key → Authorization: Bearer；不带 → 匿名免费档（完全不发鉴权头）。
 * - generic：通用 JSON 档（GET/POST 模板 + 字段映射），SearXNG 等端点照旧可用。
 *
 * 合并自 dsh-web-search-custom/src/index.js：逻辑、错误文案、脱敏与占位符语义原样保留，
 * 仅把配置键改用 search* 前缀并抽走公共 helper。provider id 保持 'custom'（profile 的
 * web.searchProvider 已指向它）。
 */
import {
  cleanText,
  firstString,
  getPath,
  normalizeUrl,
  withTimeout
} from "./helpers.js"

/** 本 provider 在 ctx.web 搜索注册表中的稳定 id。 */
export const SEARCH_PROVIDER_ID = "custom"

export const DEFAULT_TIMEOUT_MS = 30000
export const DEFAULT_URL = "https://api.anysearch.com/v1/search"
export const DEFAULT_MAX_RESULTS = 10
export const ANYSEARCH_MAX_RESULTS_CAP = 10
export const ANYSEARCH_HOSTS = ["anysearch.com", "www.anysearch.com", "api.anysearch.com"]

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** searchHeaders 字段在设置里是 JSON 字符串；兼容直接传对象的写法。 */
function parseHeaders(headers) {
  if (headers === null || headers === undefined) return {}
  if (typeof headers === "object") return headers
  const text = String(headers).trim()
  if (text === "") return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 解析当前生效的 provider 选项（设置层 + 环境变量覆盖）。readConfig 每次现读。 */
function resolveOptions(rawConfig) {
  const env = process.env
  const config = rawConfig === null || rawConfig === undefined ? {} : rawConfig
  const method = String(config.searchMethod || "GET").toUpperCase()
  return {
    api: env.WEB_SEARCH_CUSTOM_API || config.searchApi || "auto",
    url: env.WEB_SEARCH_CUSTOM_URL || config.searchUrl || "",
    apiKey: env.WEB_SEARCH_CUSTOM_API_KEY || config.searchApiKey || "",
    maxResults: toInt(env.WEB_SEARCH_CUSTOM_MAX_RESULTS, config.searchMaxResults ?? DEFAULT_MAX_RESULTS),
    method: method === "POST" ? "POST" : "GET",
    body: config.searchBody || '{"query":"{query}"}',
    headers: parseHeaders(env.WEB_SEARCH_CUSTOM_HEADERS || config.searchHeaders),
    authHeader: config.searchAuthHeader || "Authorization",
    authScheme: config.searchAuthScheme ?? "Bearer",
    timeoutMs: toInt(env.WEB_SEARCH_CUSTOM_TIMEOUT_MS, config.searchTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    resultsPath: config.searchResultsPath || "results",
    urlField: config.searchUrlField || "url",
    titleField: config.searchTitleField || "title",
    snippetField: config.searchSnippetField || "content",
    publishedField: config.searchPublishedField || "publishedDate"
  }
}

/** 取 URL 模板的主机名：先剥掉 {占位符}（模板化主机名也能判定），解析失败返回空串。 */
function hostOf(urlTemplate) {
  const staticPart = String(urlTemplate || "").replace(/\{\w+\}/g, "x").split("?")[0]
  try {
    return new URL(staticPart).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function isAnySearchHost(host) {
  if (!host) return false
  return ANYSEARCH_HOSTS.includes(host) || host.endsWith(".anysearch.com")
}

/** 决定本次请求走哪一档：显式 anysearch/generic 优先，auto 按主机名判定。 */
function resolveApi(options) {
  const wanted = String(options.api || "auto").trim().toLowerCase()
  if (wanted === "anysearch") return "anysearch"
  if (wanted === "generic") return "generic"
  return isAnySearchHost(hostOf(options.url)) ? "anysearch" : "generic"
}

/** 把模板里的 {query}（已编码）/ {queryRaw}（未编码）/ {apiKey}（已编码）/ {apiKeyRaw}（原样）换值；未知占位符原样保留。 */
function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  )
}

function templateValues(request, options) {
  return {
    query: encodeURIComponent(request.query),
    queryRaw: request.query,
    apiKey: encodeURIComponent(options.apiKey || ""),
    apiKeyRaw: options.apiKey || ""
  }
}

/** 构造最终请求 URL：模板优先；GET 且无 {query} 时自动补 q= 参数。 */
function buildUrl(raw, values, appendQuery) {
  let urlString = fillTemplate(raw, values)
  if (appendQuery) {
    const url = new URL(urlString)
    url.searchParams.set("q", values.queryRaw)
    urlString = url.toString()
  }
  return urlString
}

/** 组合请求头：accept + 用户 headers + 可选的 Authorization。 */
function buildHeaders(options, keyAlreadyEmbedded, method) {
  const headers = { accept: "application/json" }
  for (const [name, value] of Object.entries(options.headers)) headers[name] = String(value)
  if ((method || options.method) === "POST") headers["content-type"] = "application/json"
  if (options.apiKey && !keyAlreadyEmbedded) {
    headers[options.authHeader] = options.authScheme
      ? options.authScheme + " " + options.apiKey
      : options.apiKey
  }
  return headers
}

/** 把任意 JSON 结果数组映射为 web 缝的 WebSearchSource[]（按 url 去重）。 */
function mapResults(payload, options) {
  const list = getPath(payload, options.resultsPath)
  const seen = new Set()
  const sources = []
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item === null || item === undefined || typeof item !== "object" || Array.isArray(item)) continue
      const url = normalizeUrl(firstString(item, [options.urlField, "url", "link"]))
      if (!url || seen.has(url)) continue
      seen.add(url)
      const out = { url }
      const title = firstString(item, [options.titleField, "title", "name"])
      if (title) out.title = cleanText(title)
      const snippet = firstString(item, [options.snippetField, "content", "snippet", "description", "text"])
      if (snippet) out.snippet = cleanText(snippet)
      const published = firstString(item, [options.publishedField, "publishedDate", "publishedAt", "pubdate", "date"])
      if (published) out.publishedAt = published
      sources.push(out)
    }
  }
  return { sources, truncated: false }
}

/** AnySearch 单次请求的 max_results：取「配置值、调用方上限」较小者，再夹进 1..10。 */
function anysearchMaxResults(options, callerMax) {
  const configured = toInt(options.maxResults, DEFAULT_MAX_RESULTS)
  const caller = toInt(callerMax, configured)
  return Math.max(1, Math.min(ANYSEARCH_MAX_RESULTS_CAP, Math.min(configured, caller)))
}

/** 脱敏厂商错误文案：402 会自动回吐「自动生成的凭据」，这类字段一律不进错误消息。 */
function redactCredentials(text) {
  let out = String(text)
  for (const key of ["api_key", "password", "username", "secret", "token"]) {
    out = out.replace(new RegExp(key + "\\s*=\\s*\\S+", "gi"), key + "=<redacted>")
  }
  out = out.replace(/(sk-|ak-)[A-Za-z0-9_-]{6,}/g, "<redacted-key>")
  return out
}

/** 把非成功响应（HTTP != 2xx 或业务 code !== 0）归一化成带处置提示的错误。 */
function anysearchError(status, envelope) {
  const source = envelope && typeof envelope === "object" ? envelope : {}
  const detail = firstString(source, ["message", "error"])
  const requestId = firstString(source, ["request_id"])
  const code = typeof source.code === "number" ? source.code : undefined
  const parts = ["AnySearch search failed: HTTP " + status + (code !== undefined && code !== 0 ? " (code " + code + ")" : "")]
  if (detail) parts.push(redactCredentials(detail))
  if (requestId) parts.push("request_id=" + requestId)
  if (status === 401 || status === 403) {
    parts.push('check the "searchApiKey" setting for the web-custom plugin (or clear it to use the anonymous free tier)')
  } else if (status === 402) {
    parts.push('anonymous daily free quota exhausted: set the "searchApiKey" in the web-custom settings (the key/credentials in the response were redacted and NOT stored)')
  } else if (status === 429) {
    parts.push('rate limited: retry later or set the "searchApiKey" in the web-custom settings')
  } else if (status === 400 || status === 502) {
    parts.push("check the request settings (tag/params/zone/language are forwarded as-is in the POST body)")
  }
  return new Error(parts.join(" "))
}

/** 把 AnySearch 信封映射成 web 缝结果：data.results[].{title,url,snippet|content}。 */
function mapAnySearchResults(payload) {
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}
  const results = getPath(envelope, "data.results")
  const seen = new Set()
  const sources = []
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item === null || item === undefined || typeof item !== "object" || Array.isArray(item)) continue
      const url = normalizeUrl(item.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const out = { url }
      const title = typeof item.title === "string" ? item.title.trim() : ""
      if (title) out.title = cleanText(title)
      const snippet = firstString(item, ["snippet", "content"])
      if (snippet) out.snippet = cleanText(snippet)
      sources.push(out)
    }
  }
  return { sources, truncated: false }
}

/** 发一次请求并把网络层错误归一化（保持既有文案与 abort 语义）。 */
async function dispatch(target, init, callSignal, callerSignal) {
  try {
    return await fetch(target, { ...init, signal: callSignal })
  } catch (error) {
    if (callerSignal && callerSignal.aborted === true) {
      throw new Error("custom web search aborted", { cause: error })
    }
    if (callSignal.aborted) {
      const reason = callSignal.reason
      throw new Error(reason instanceof Error ? reason.message : "search timed out", { cause: error })
    }
    throw new Error("custom web search request failed: " + String(error), { cause: error })
  }
}

/** 解析响应 JSON；不可解析时抛带 HTTP 状态的消息。 */
async function readJson(response) {
  try {
    return await response.json()
  } catch (error) {
    throw new Error("search API returned unparseable JSON (HTTP " + response.status + ")", { cause: error })
  }
}

/** generic 档：模板化 GET/POST + 字段映射（SearXNG 等端点，行为与既有版本一致）。 */
async function searchGeneric(options, request, callSignal, callerSignal) {
  const values = templateValues(request, options)
  const keyAlreadyEmbedded =
    options.url.includes("{apiKey}") ||
    options.url.includes("{apiKeyRaw}") ||
    (options.method === "POST" && (options.body.includes("{apiKey}") || options.body.includes("{apiKeyRaw}")))
  const appendQuery = options.method === "GET" && !options.url.includes("{query}")
  const url = buildUrl(options.url, values, appendQuery)
  const headers = buildHeaders(options, keyAlreadyEmbedded)
  const body = options.method === "POST" ? fillTemplate(options.body, values) : undefined

  const response = await dispatch(url, {
    method: options.method,
    headers,
    ...(body !== undefined ? { body } : {})
  }, callSignal, callerSignal)

  const payload = await readJson(response)
  if (!response.ok) {
    const detail = payload && (payload.error || payload.message)
    throw new Error("search API returned HTTP " + response.status + (detail ? ": " + detail : ""))
  }
  return mapResults(payload, options)
}

/** anysearch 档：厂商信封 POST，带 key 走鉴权配额、不带 key 走匿名免费档。 */
async function searchAnySearch(options, request, callSignal, callerSignal) {
  const keyAlreadyEmbedded = options.url.includes("{apiKey}") || options.url.includes("{apiKeyRaw}")
  const url = buildUrl(options.url, templateValues(request, options), false)
  const headers = buildHeaders(options, keyAlreadyEmbedded, "POST")
  const body = JSON.stringify({
    query: request.query,
    max_results: anysearchMaxResults(options, request.maxResults)
  })

  const response = await dispatch(url, { method: "POST", headers, body }, callSignal, callerSignal)
  const payload = await readJson(response)
  const code = payload && typeof payload === "object" && typeof payload.code === "number" ? payload.code : undefined

  if (!response.ok || (code !== undefined && code !== 0)) {
    throw anysearchError(response.status, payload)
  }
  return mapAnySearchResults(payload)
}

/**
 * 构造搜索 provider。readConfig 是 thunk：每次调用现读配置（volatile 原地提交后即生效）。
 * provider id 固定为 'custom'——profile 的 web 行 searchProvider 已指向它。
 */
export function makeSearchProvider(readConfig) {
  const current = () => (typeof readConfig === "function" ? readConfig() || {} : {})
  return {
    id: SEARCH_PROVIDER_ID,

    /** 廉价本地可用性检查（不得发网络请求）。 */
    available() {
      const options = resolveOptions(current())
      if (!options.url || options.timeoutMs <= 0) return false
      try {
        const url = new URL(fillTemplate(options.url, { query: "x", apiKey: "x", queryRaw: "x" }))
        return url.protocol === "http:" || url.protocol === "https:"
      } catch {
        return false
      }
    },

    /** 执行一次搜索（按 api 档分派）。 */
    async search(request, signal) {
      const options = resolveOptions(current())
      const timeout = withTimeout(signal, options.timeoutMs, "search timed out after " + options.timeoutMs + " ms")
      try {
        if (resolveApi(options) === "anysearch") {
          return await searchAnySearch(options, request, timeout.signal, signal)
        }
        return await searchGeneric(options, request, timeout.signal, signal)
      } finally {
        timeout.cleanup()
      }
    }
  }
}
