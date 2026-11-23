/**
 * dsh-web-custom — 合并后的 host 入口：一个配置命名空间、两个 provider、两个独立工具。
 *
 * 合并自：
 *   - dsh-web-search-custom（搜索 provider id 'custom'，接管原生 web_search）
 *   - dsh-web-fetch（AnySearch Extract provider id 'anysearch'，接管原生 web_fetch；
 *     外加 web_fetch_cdp / web_fetch_tavily 两个独立工具）
 *
 * 架构决定（与两旧包一致，勿改）：
 *   - 搜索/抓取 provider 通过 ctx.web 能力缝注册，由 profile 的 web 行
 *     searchProvider: custom / fetchProvider: anysearch 选中；
 *   - 独立工具由 ctx.tools.register 注册，模型按工具描述自主选择；
 *   - web 服务缺席时本插件仍可加载（等待式注入），两个抓取工具照常可用；
 *   - 不新增 searchEnabled 之类开关：宿主对「已配置但 unavailable」的 provider 是
 *     直接抛错、不回落（dsh-web/lib/index.js:174），加开关等于埋必炸状态。
 */
import { defineTool } from "@deepseek-ai/dsh-tools"
import { Config, CONFIG_KEYS, materializeConfig, readField } from "./config.js"
import { makeSearchProvider, SEARCH_PROVIDER_ID } from "./search.js"
import { makeCdpStrategy } from "./strategies/cdp.js"
import { makeTavilyStrategy } from "./strategies/tavily.js"
import { ANYSEARCH_FETCH_PROVIDER_ID, makeAnySearchFetchProvider } from "./providers/anysearch.js"

export { Config, CONFIG_KEYS, materializeConfig, readField }
export { SEARCH_PROVIDER_ID, ANYSEARCH_FETCH_PROVIDER_ID }

export const name = "web-custom"
/** 设置命名空间 = 本插件在 cordis 组合树里的行 id；设置卡与 profile patch 引用它。 */
export const SETTINGS_NS = "web-custom"

/** tools 是硬依赖（注册工具）；settings / web 走 apply 内等待式注入。 */
export const inject = ["tools"]

/** 从策略 fetch 的返回（{sources, truncated}）投影为工具输出。 */
function projectResult(result) {
  const sources = (result.sources || []).map((s) => {
    const out = { url: s.url }
    if (s.title) out.title = s.title
    if (s.snippet) out.snippet = s.snippet
    if (s.content) out.content = s.content
    if (s.provider) out.provider = s.provider
    return out
  })
  return { sources, truncated: result.truncated || false }
}

function renderResult(result) {
  const lines = []
  if (result.sources.length === 0) {
    lines.push("[web-custom] 未获取到任何结果。")
  } else {
    result.sources.forEach((s, i) => {
      lines.push("### " + (i + 1) + ". " + (s.title || s.url))
      if (s.provider) lines.push("来源：" + s.provider)
      lines.push(s.url)
      if (s.snippet) lines.push(s.snippet)
      if (s.content && s.content !== s.snippet) lines.push(s.content)
      if (i < result.sources.length - 1) lines.push("")
    })
  }
  if (result.truncated) lines.push("[web-custom] 结果被截断。")
  return [{ type: "text", text: lines.join("\n") }]
}

/**
 * 为给定策略构建 defineTool 描述。策略在 execute 时才实例化，
 * 因此每次调用都读取最新的 current() 配置。
 */
function makeToolDef(strategyId, factory, enabledField, configReader) {
  return defineTool({
    name: "web_fetch_" + strategyId,
    description: strategyId === "cdp"
      ? "Fetch the rendered content of a URL via the CDP browser (cloakbrowser). Best for pages requiring JavaScript rendering, interactive apps, or direct browser-based scraping. Provide a URL (scheme optional)."
      : "Fetch page content of a specific URL via Tavily Extract API. Fast, no browser needed. URLs only — it cannot search: use web_search to find pages, then extract a result URL here. Requires a Tavily API key to be configured.",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: strategyId === "cdp"
          ? "The URL to fetch (e.g. https://example.com/page or example.com)."
          : "The URL to extract (e.g. https://example.com/page). Not a search box — pass a URL found via web_search."
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default 5, Tavily only)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", required: true },
                title: { type: "string" },
                snippet: { type: "string" },
                content: { type: "string" },
                provider: { type: "string" }
              }
            }
          },
          truncated: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => renderResult(value)
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // configReader 每次现取并解引用 volatile 活引用：设置页一保存即生效
      const cfg = configReader()
      let enabled = cfg[enabledField] === true
      if (!enabled && cfg[enabledField] !== false) {
        enabled = !!cfg[enabledField]
      }
      if (!enabled) {
        const cur = (() => {
          try { return JSON.stringify({ [enabledField]: cfg[enabledField], cdpEnabled: cfg.cdpEnabled, tavilyEnabled: cfg.tavilyEnabled }) }
          catch { return String(cfg[enabledField]) }
        })()
        throw new Error(
          "web-custom (" + strategyId + "): data source disabled (current " + cur + "). Enable it on the Plugins page → 通用 Web 获取与搜索（" + name + "）, or set " + SETTINGS_NS + "." + enabledField + ": true in the profile cordis patch; the form applies live, the patch needs a restart."
        )
      }
      const strategy = factory(cfg)
      if (!strategy.available()) {
        const hint = strategyId === "tavily" && !cfg.tavilyApiKey
          ? " (tavilyApiKey is empty — paste one from https://app.tavily.com)"
          : strategyId === "cdp" && !cfg.cdpEndpoint
          ? " (cdpEndpoint is empty)"
          : ""
        throw new Error("web-custom (" + strategyId + "): data source unavailable — strategy.available() returned false" + hint + ". Check the configuration on the Plugins page → 通用 Web 获取与搜索（" + name + ").")
      }
      try {
        const result = await strategy.fetch({
          url: String(args.url),
          ...(strategyId === "tavily" && args.maxResults !== undefined ? { maxResults: args.maxResults } : {})
        }, exec && exec.signal)
        return projectResult(result)
      } catch (err) {
        throw new Error("web-custom (" + strategyId + "): " + (err && err.message ? err.message : String(err)))
      }
    }
  })
}

/**
 * Cordis apply：声明设置命名空间，注册两个 web provider 与两个独立工具。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - web-custom 行配置；volatile 字段是 {get()} 活引用。
 */
export function apply(ctx, config = {}) {
  // 关闭宿主按 schema 自动生成的默认页——配置卡由 client 半注册进插件页 slots。
  ctx.inject(["settings"], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // 每次 execute 现取配置行并解引用 volatile 活引用（设置页保存即时生效）。
  const readConfig = () => materializeConfig(config)

  // provider 半：搜索 + 抓取。等待式注入（web 晚到也会回调；缺席时抓取工具照常可用），
  // 每个注册都交给 effect 回收，停用插件时一起摘除。
  ctx.inject(["web"], (wctx) => {
    const web = wctx.web
    if (!web) return
    if (typeof web.registerSearchProvider === "function") {
      wctx.effect(() => web.registerSearchProvider(makeSearchProvider(readConfig)), "web-custom: search provider")
    }
    if (typeof web.registerFetchProvider === "function") {
      wctx.effect(() => web.registerFetchProvider(makeAnySearchFetchProvider(readConfig)), "web-custom: fetch provider")
    }
  })

  // 为每个策略注册独立工具；只有 enabled 的策略在 execute 中才真正可用。
  // 传 thunk 而非值：快照会在设置页保存后过期，thunk 每次现读。
  // 注册统一纳入 ctx.effect（对齐 dsh-soul / dsh-fact-memory 惯例）：插件停用时工具随 effect 一并注销。
  for (const [name, factory, enabledKey] of [
    ["cdp", makeCdpStrategy, "cdpEnabled"],
    ["tavily", makeTavilyStrategy, "tavilyEnabled"]
  ]) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(makeToolDef(name, factory, enabledKey, readConfig))
      return () => dispose()
    })
  }
}
