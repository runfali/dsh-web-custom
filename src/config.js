/**
 * dsh-web-custom — 单一 Config（29 字段，设置命名空间 = cordis 行 id = web-custom）。
 *
 * 字段命名规则：
 *   - 搜索侧 15 个统一加 search 前缀（旧包的 api/url/timeoutMs 等泛名在 29 字段里会歧义）；
 *   - 抓取侧 14 个保持原名（已按数据源前缀命名，迁移即换行搬运）。
 *
 * 全部字段 .volatile()：0.1.7+ 的设置页只认 volatile 路径，改动经 _commitVolatile
 * 原地提交、不重启 fiber；apply 收到的对应字段是 {get()} 活引用，由 materializeConfig
 * 每次现读解引用。
 */
import z from "@deepseek-ai/schemastery"

export const DEFAULT_SEARCH_URL = "https://api.anysearch.com/v1/search"
export const DEFAULT_SEARCH_MAX_RESULTS = 10
export const DEFAULT_SEARCH_TIMEOUT_MS = 30000
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222"
export const DEFAULT_CDP_TIMEOUT_MS = 60000
export const DEFAULT_CDP_WAIT_MS = 2000
export const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/extract"
export const DEFAULT_TAVILY_TIMEOUT_MS = 30000
export const DEFAULT_ANYSEARCH_ENDPOINT = "https://api.anysearch.com/v1/extract"
export const DEFAULT_ANYSEARCH_TIMEOUT_MS = 30000
export const DEFAULT_ANYSEARCH_MAX_CHARS = 100000

export const Config = z.object({
  // ── 搜索：接管原生 web_search（provider id: custom） ──────────────────────
  searchApi: z.string().default("auto").volatile(),
  searchUrl: z.string().default(DEFAULT_SEARCH_URL).volatile(),
  searchApiKey: z.string().default("").volatile(),
  searchMaxResults: z.number().step(1).default(DEFAULT_SEARCH_MAX_RESULTS).volatile(),
  searchMethod: z.string().default("GET").volatile(),
  searchBody: z.string().default('{"query":"{query}"}').volatile(),
  searchHeaders: z.string().default("{}").volatile(),
  searchAuthHeader: z.string().default("Authorization").volatile(),
  searchAuthScheme: z.string().default("Bearer").volatile(),
  searchTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_SEARCH_TIMEOUT_MS).volatile(),
  searchResultsPath: z.string().default("results").volatile(),
  searchUrlField: z.string().default("url").volatile(),
  searchTitleField: z.string().default("title").volatile(),
  searchSnippetField: z.string().default("content").volatile(),
  searchPublishedField: z.string().default("publishedDate").volatile(),

  // ── 抓取：CDP 浏览器（独立工具 web_fetch_cdp） ────────────────────────────
  cdpEnabled: z.boolean().default(true).volatile(),
  cdpEndpoint: z.string().default(DEFAULT_CDP_ENDPOINT).volatile(),
  cdpTimeoutMs: z.number().min(1000).default(DEFAULT_CDP_TIMEOUT_MS).volatile(),
  cdpWaitMs: z.number().min(0).default(DEFAULT_CDP_WAIT_MS).volatile(),

  // ── 抓取：Tavily（独立工具 web_fetch_tavily） ─────────────────────────────
  tavilyEnabled: z.boolean().default(false).volatile(),
  tavilyEndpoint: z.string().default(DEFAULT_TAVILY_ENDPOINT).volatile(),
  tavilyApiKey: z.string().default("").volatile(),
  tavilyTimeoutMs: z.number().min(1000).default(DEFAULT_TAVILY_TIMEOUT_MS).volatile(),

  // ── 抓取：AnySearch Extract（接管原生 web_fetch，provider id: anysearch） ──
  anysearchEnabled: z.boolean().default(true).volatile(),
  anysearchEndpoint: z.string().default(DEFAULT_ANYSEARCH_ENDPOINT).volatile(),
  anysearchApiKey: z.string().default("").volatile(),
  anysearchTimeoutMs: z.number().min(1000).default(DEFAULT_ANYSEARCH_TIMEOUT_MS).volatile(),
  anysearchFallbackToHttp: z.boolean().default(true).volatile(),
  anysearchMaxChars: z.number().min(1000).default(DEFAULT_ANYSEARCH_MAX_CHARS).volatile()
})

/** 键集合（顺序 = schema 声明顺序），供测试与迁移脚本逐键核对。 */
export const CONFIG_KEYS = Object.keys(Config.dict)

/** 读取单个配置字段：volatile 字段是 {get()} 活引用，普通字段是裸值。 */
export function readField(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function" && !Array.isArray(value)) {
    return value.get()
  }
  return value
}

/** 把一行配置物化为普通值对象：策略工厂与启用判定只该看到裸值。 */
export function materializeConfig(row) {
  const out = {}
  const sourceRow = row === null || row === undefined ? {} : row
  for (const key of Object.keys(sourceRow)) {
    if (key === "__jsExpr") continue
    out[key] = readField(sourceRow[key])
  }
  return out
}
