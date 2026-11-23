# dsh-web-custom

一个 DSH bundle 接管整个 **web 能力缝**：原生 `web_search` / `web_fetch` 换成可插拔 provider（AnySearch 或任意 JSON 端点，抓取失败自动回落 HTTP），另附 CDP 与 Tavily 两个独立抓取工具，29 个配置项一张设置卡改完即生效。

一个包同时握着两个 provider 键：搜索与抓取不会各写一半而互相覆盖——**一个配置命名空间、一张设置卡、一次原子切换**。

## 为什么是一个包

宿主从 profile 补丁的 `web` 行选 provider：

```yaml
- id: web
  config:
    searchProvider: custom
    fetchProvider: anysearch
```

只写一半 config 的包，另一半得靠 profile 用户层补齐，下一次改动很容易把它冲掉。本包一次写全两键。同一能力缝上重复注册 provider id 会直接抛 `WEB_DUPLICATE_PROVIDER`，所以**同组 provider 不能由两个包分供**——切换天然是原子的。

## 能力

| 入口 | 由谁提供 | provider id | 说明 |
|---|---|---|---|
| `web_search`（原生） | AnySearch `/v1/search` 或任意 JSON 端点 | `custom` | 无 key 走匿名免费档；有 key 走 `Bearer` |
| `web_fetch`（原生） | AnySearch `/v1/extract`，失败回落原生 HTTP | `anysearch` | PDF / raw / 知乎等 422 场景直接 HTTP 直取 |
| `web_fetch_cdp` | CDP 浏览器（cloakbrowser） | — | 需要 JS 渲染的页面 |
| `web_fetch_tavily` | Tavily Extract API | — | 快、无需浏览器、需要 Tavily key |

## 要求

- DeepSeek Harness `>=0.1.2-alpha.3 <0.1.8 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.7-alpha.0 <0.1.8 || >=0.2.0-alpha.0 <0.3.0 || >=0.2.1-alpha.0 <0.3.0 || >=0.2.2-alpha.0 <0.3.0`
- Node.js `>=22`
- 零运行时依赖（peer-only；设置卡用官方 `@deepseek-ai/dsh-client-ui-primitives`）。

## 安装

先停宿主（bundle 与补丁只在启动时读取），然后在宿主里：

```bash
dsh plugin --profile desktop add /path/to/dsh-web-custom
# 发布后也可直接：add dsh-web-custom
```

随包 `cordis.patch.yml` 已写全两个 provider 键。重启宿主后打开插件的设置卡即可。

### 从早期拆分版升级

没装过 `dsh-web-fetch` / `dsh-web-search-custom` 的跳过本节。装过则必须在重启前删干净——它们与本包注册同一组 provider id，重复注册会让宿主加载失败（`WEB_DUPLICATE_PROVIDER`）：

1. `dsh plugin --profile desktop remove dsh-web-fetch`
2. `dsh plugin --profile desktop remove dsh-web-search-custom`
3. 从 profile 补丁里删除 `- id: web-fetch` / `- id: web-search-custom` 两行。
4. 确认 `- id: web` 行同时有 `searchProvider: custom` 与 `fetchProvider: anysearch`。

29 个配置字段见下方「配置」；老配置的迁移见「迁移既有配置」。

## 配置

单一命名空间 `web-custom`，29 字段全部 `.volatile()`（设置卡保存即时生效，无需重启）。卡片按 **搜索 / AnySearch / CDP / Tavily** 四组排列。

| 分组 | 字段 | 默认值 |
|---|---|---|
| 搜索 | `searchApi`、`searchUrl`、`searchApiKey`、`searchMaxResults`、`searchMethod`、`searchBody`、`searchHeaders`、`searchAuthHeader`、`searchAuthScheme`、`searchTimeoutMs`、`searchResultsPath`、`searchUrlField`、`searchTitleField`、`searchSnippetField`、`searchPublishedField` | `auto` / `https://api.anysearch.com/v1/search` / `''` / `10` / `GET` / `{"query":"{query}"}` / `{}` / `Authorization` / `Bearer` / `30000` / `results` / `url` / `title` / `content` / `publishedDate` |
| AnySearch Extract | `anysearchEnabled`、`anysearchEndpoint`、`anysearchApiKey`、`anysearchTimeoutMs`、`anysearchFallbackToHttp`、`anysearchMaxChars` | `true` / `https://api.anysearch.com/v1/extract` / `''` / `30000` / `true` / `100000` |
| CDP | `cdpEnabled`、`cdpEndpoint`、`cdpTimeoutMs`、`cdpWaitMs` | `true` / `http://127.0.0.1:9222` / `60000` / `2000` |
| Tavily | `tavilyEnabled`、`tavilyEndpoint`、`tavilyApiKey`、`tavilyTimeoutMs` | `false` / `https://api.tavily.com/extract` / `''` / `30000` |

`searchApiKey` 与 `anysearchApiKey` 刻意保留为两个字段：搜索的 `generic` 档可能指向 SearXNG 等第三方端点，强制共享会把两种 key 绑死；两处都填同一个 `as_sk_…` 完全没问题。

搜索侧环境变量覆盖：`WEB_SEARCH_CUSTOM_API`、`WEB_SEARCH_CUSTOM_URL`、`WEB_SEARCH_CUSTOM_API_KEY`、`WEB_SEARCH_CUSTOM_MAX_RESULTS`、`WEB_SEARCH_CUSTOM_HEADERS`、`WEB_SEARCH_CUSTOM_TIMEOUT_MS`。

## 迁移既有配置

`tools/migrate-config.mjs` 从早期拆分版留下的两行 config 合成 29 键新 config，默认不回显任何密钥值：

```bash
# 干跑：逐键报告（密钥只标「已设置/空」）
node tools/migrate-config.mjs --patch ~/.dsh/profiles/desktop/cordis.patch.yml

# 预检：旧行或旧键缺失时 exit 1
node tools/migrate-config.mjs --patch <patch> --check

# 生成含真实值的候选补丁（含密钥，用完删除）
node tools/migrate-config.mjs --patch <patch> --out web-custom-candidate.yml
```

映射规则：搜索侧 15 键加 `search` 前缀（`api` → `searchApi`、`timeoutMs` → `searchTimeoutMs`……）；抓取侧 14 键同名搬运。切换时先停宿主，删掉早期拆分版的两个包与两行补丁、贴入新行、装本包、再启宿主；验收通过前保留 patch 备份。

## 测试

```bash
pnpm install
npm test
```

套件：entry（声明面、29 字段 volatile、三处键集合一致）、host-integration（真 Cordis + WebRuntime + ToolRuntime + SettingsForms + 兼容闸）、search-provider、两个策略单测 + CDP 帧编解码 + AnySearch Extract 单测、client-smoke（双视图 / 只读态 / 暂存落盘 / whileServed 门控）。

## 已知陷阱

- **原子切换**：两个包同时提供同一能力缝会被 `WEB_DUPLICATE_PROVIDER` 挡下。
- **已配置但不可用**：`web` 行点名了本 provider 却 `available() === false`（如 `searchUrl` 为空）时，宿主抛 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不会回落。
- **关回落 + 空 Key**：`anysearchFallbackToHttp` 关闭且未填 `anysearchApiKey` 时，extract 档不可用，宿主对每次 `web_fetch` 都报同一个不回落错误。要么保持回落开启，要么把 Key 填上。
- **官方「Web 搜索」设置页**会整段覆写 `- id: web` 的 config；动过该页后务必复核两键。
- **两种抓取**：`web_fetch` 是宿主原生工具、由 `anysearch` provider 供数；`web_fetch_cdp` / `web_fetch_tavily` 是本插件注册的独立工具，报错前缀是 `web-custom`。

## 许可证

MIT
