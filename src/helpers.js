/**
 * dsh-web-custom — 两个能力半共享的辅助函数。
 *
 * 合并自 dsh-web-fetch/src/helpers.js 与 dsh-web-search-custom/src/index.js 的内部工具：
 * 超时、HTML/Markdown 清洗、结果投影、JSON 路径取值、URL 校验。所有函数保持原实现
 * 的语义与文案，避免合并引入行为漂移。
 */

/** 合并调用方取消信号与本地超时，返回 signal + cleanup。
 * 第三个参数只在需要保留历史文案时传（搜索侧用 'search timed out after N ms'）。 */
export function withTimeout(signal, timeoutMs, message) {
  const finalMessage = message || "request timed out after " + timeoutMs + " ms"
  const controller = new AbortController()
  const onAbort = () => {
    const reason = signal && signal.reason !== undefined ? signal.reason : new Error("aborted")
    controller.abort(reason)
  }
  if (signal && signal.aborted === true) { onAbort() }
  else { signal && signal.addEventListener("abort", onAbort, { once: true }) }
  const timer = setTimeout(() => controller.abort(new Error(finalMessage)), timeoutMs)
  timer.unref && timer.unref()
  return {
    signal: controller.signal,
    cleanup: () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort) }
  }
}

/** 解析数字配置：缺失 / 非数字 / 低于下限一律回退默认值（0 是合法值，不能被 || 当假值吃掉）。 */
export function numberOr(value, fallback, min = 0) {
  if (value === null || value === undefined || value === "") return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** 剥离 HTML 标签与 Markdown 标记，折叠空白，返回纯文本。 */
export function plainText(raw) {
  if (!raw || typeof raw !== "string") return ""
  const html = raw.replace(/<[^>]+>/g, " ")
  const md = html
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*?)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\*\*([^*]*?)\*\*/g, "$1")
    .replace(/__([^_]*?)__/g, "$1")
    .replace(/\*([^*]*?)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
  return md.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

/** 截断字符串，保留省略号；截断点落在代理对中间时退一位，不产生半个字符。 */
export function truncate(text, limit) {
  const n = Math.max(1, Math.trunc(limit))
  if (text.length <= n) return text
  let end = n - 1
  const kept = end >= 1 ? text.charCodeAt(end - 1) : NaN
  const dropped = text.charCodeAt(end)
  if (kept >= 0xd800 && kept <= 0xdbff && dropped >= 0xdc00 && dropped <= 0xdfff) end -= 1
  return text.slice(0, end) + "\u2026"
}

/** 构造单个 WebSource。 */
export function source(url, opts = {}) {
  const out = { url }
  if (opts.title) out.title = opts.title
  if (opts.snippet) out.snippet = opts.snippet
  if (opts.content) out.content = opts.content
  if (opts.provider) out.provider = opts.provider
  return out
}

/** 脱敏凭据：厂商错误体可能回吐自动生成的 key（402 档实测），一律不进错误文案。
 *  覆盖 key=value / "key":"value" / authorization 头形状，以及 as_sk_ / sk- / ak- 前缀。 */
export function redactCredentials(text) {
  let out = String(text)
  out = out.replace(/((?:api[_-]?key|password|username|secret|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1<redacted>")
  out = out.replace(/\b(?:as_sk_|sk-|ak-)[A-Za-z0-9_-]{4,}/g, "<redacted-key>")
  return out
}

function decodeEntities(input) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    hellip: "\u2026", mdash: "\u2014", ndash: "\u2013",
    lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d"
  }
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X"
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code) } catch { /* keep original */ }
      }
    }
    const value = named[body]
    return value === undefined ? match : value
  })
}

/** 去掉 HTML 标签、折叠空白（搜索结果的 title/content 常带 HTML）。 */
export function cleanText(value) {
  return decodeEntities(String(value))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** 按点路径取值，例如 "data.results"。 */
export function getPath(object, path) {
  if (!path) return object
  let current = object
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined
    current = current[key]
  }
  return current
}

/** 取 item 上第一个非空字符串字段（非对象条目一律视为无字段）。 */
export function firstString(item, keys) {
  if (item === null || item === undefined || typeof item !== "object") return ""
  for (const key of keys) {
    const value = item[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/** 校验并归一化一条搜索结果的 URL（只接受 http/https；非法返回空串）。 */
export function normalizeUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return ""
  const url = value.trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
  } catch {
    return ""
  }
  return url
}
