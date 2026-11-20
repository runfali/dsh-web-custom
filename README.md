# dsh-web-custom

One DSH bundle for the **web seam**: a search provider that takes over the native `web_search`, an extract provider that takes over `web_fetch`, and two standalone fetch tools (`web_fetch_cdp`, `web_fetch_tavily`).

Merged from [dsh-web-fetch](../dsh-web-fetch) and [dsh-web-search-custom](../dsh-web-search-custom). It replaces two bundles, two settings namespaces and two half-written `- id: web` patches with **one bundle, one config row, one settings card**.

## Why one bundle

The host picks providers from the `web` row of the profile patch:

```yaml
- id: web
  config:
    searchProvider: custom
    fetchProvider: anysearch
```

Previously each old bundle wrote only half of that config and the profile user layer had to complete the other key. Now one bundle writes both keys at once. A duplicate provider id on the same seam throws `WEB_DUPLICATE_PROVIDER` at load, so **the old and new bundles can never coexist** — switching must be atomic.

## Capabilities

| Surface | Who serves it | Provider id | Notes |
|---|---|---|---|
| `web_search` (native) | AnySearch `/v1/search` or any JSON endpoint | `custom` | Anonymous free tier without a key; `Bearer` with one |
| `web_fetch` (native) | AnySearch `/v1/extract`, falls back to plain HTTP | `anysearch` | PDF / raw files / zhihu return 422 from extract and are fetched directly |
| `web_fetch_cdp` | CDP browser (cloakbrowser) | — | Rendered pages, JS-heavy sites |
| `web_fetch_tavily` | Tavily Extract API | — | Fast, no browser, needs a Tavily key |

## Requirements

- DeepSeek Harness `>=0.1.2-alpha.3 <0.1.8 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.7-alpha.0 <0.1.8 || >=0.2.0-alpha.0 <0.3.0 || >=0.2.1-alpha.0 <0.3.0 || >=0.2.2-alpha.0 <0.3.0`
- Node.js `>=22`
- No runtime dependencies (peer-only; the client card uses the official `@deepseek-ai/dsh-client-ui-primitives`).

## Install

Stop the host first (it reads bundles and patches at boot). Then, from the host:

```bash
dsh plugin --profile desktop add /path/to/dsh-web-custom
# or, after publishing: add dsh-web-custom
```

Restart the host. Before restarting, remove the two legacy rows and their packages:

1. `dsh plugin --profile desktop remove dsh-web-fetch`
2. `dsh plugin --profile desktop remove dsh-web-search-custom`
3. Delete the `- id: web-fetch` / `- id: web-search-custom` rows from the profile patch.
4. Make sure the `- id: web` row carries both `searchProvider: custom` and `fetchProvider: anysearch`.

The included `cordis.patch.yml` already declares both. See [Migration](#migration) for the 29 config keys.

## Configuration

One namespace — `web-custom` — with 29 fields, all `.volatile()` (saved from the settings card applies live, no restart). The card groups them into **Search / AnySearch / CDP / Tavily**.

| Group | Fields | Defaults |
|---|---|---|
| Search | `searchApi`, `searchUrl`, `searchApiKey`, `searchMaxResults`, `searchMethod`, `searchBody`, `searchHeaders`, `searchAuthHeader`, `searchAuthScheme`, `searchTimeoutMs`, `searchResultsPath`, `searchUrlField`, `searchTitleField`, `searchSnippetField`, `searchPublishedField` | `auto` / `https://api.anysearch.com/v1/search` / `''` / `10` / `GET` / `{"query":"{query}"}` / `{}` / `Authorization` / `Bearer` / `30000` / `results` / `url` / `title` / `content` / `publishedDate` |
| AnySearch extract | `anysearchEnabled`, `anysearchEndpoint`, `anysearchApiKey`, `anysearchTimeoutMs`, `anysearchFallbackToHttp`, `anysearchMaxChars` | `true` / `https://api.anysearch.com/v1/extract` / `''` / `30000` / `true` / `100000` |
| CDP | `cdpEnabled`, `cdpEndpoint`, `cdpTimeoutMs`, `cdpWaitMs` | `true` / `http://10.200.0.5:9222` / `60000` / `2000` |
| Tavily | `tavilyEnabled`, `tavilyEndpoint`, `tavilyApiKey`, `tavilyTimeoutMs` | `false` / `https://api.tavily.com/extract` / `''` / `30000` |

`searchApiKey` and `anysearchApiKey` are intentionally separate: the `generic` search mode may point at a third-party JSON endpoint (SearXNG etc.). Filling both with the same `as_sk_…` key is fine.

Environment overrides for the search side (same names as the old bundle): `WEB_SEARCH_CUSTOM_API`, `WEB_SEARCH_CUSTOM_URL`, `WEB_SEARCH_CUSTOM_API_KEY`, `WEB_SEARCH_CUSTOM_MAX_RESULTS`, `WEB_SEARCH_CUSTOM_HEADERS`, `WEB_SEARCH_CUSTOM_TIMEOUT_MS`.

## Migration

`tools/migrate-config.mjs` reads the two legacy rows from the profile patch and emits the 29-key `web-custom` config. It never prints secret values:

```bash
# dry-run: per-key report (masked secrets, value presence only)
node tools/migrate-config.mjs --patch ~/.dsh/profiles/desktop/cordis.patch.yml

# preflight: exit 1 when a legacy row or key is missing
node tools/migrate-config.mjs --patch <patch> --check

# candidate patch with real values (contains secrets — delete after use)
node tools/migrate-config.mjs --patch <patch> --out web-custom-candidate.yml
```

Mapping rule: the 15 search keys gain a `search` prefix (`api` → `searchApi`, `timeoutMs` → `searchTimeoutMs`, …); the 14 fetch keys keep their names. Switch while the host is stopped: remove both old packages and rows, paste the new row, add this bundle, start the host. Keep the backup patch until the acceptance checks pass.

## Tests

```bash
pnpm install
npm test
```

Suites: entry (declaration surface, 29 volatile fields, key-set equality), host-integration (real Cordis + WebRuntime + ToolRuntime + SettingsForms + compatibility gate), search-provider, the two strategy units + CDP frame codec + AnySearch extract unit, and the client smoke test (dual view, read-only, staging, save landing).

## Known traps

- **Atomic switch**: loading old and new bundles together fails with `WEB_DUPLICATE_PROVIDER`.
- **Configured-but-unavailable**: if the `web` row names our provider but it reports unavailable (e.g. empty `searchUrl`), the host throws `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` instead of falling back.
- **Official "Web search" settings page** rewrites the whole `- id: web` config. Re-check both keys after touching that page.
- **Two fetch concepts**: `web_fetch` is the native tool served by the `anysearch` provider; `web_fetch_cdp` / `web_fetch_tavily` are separate tools registered by this plugin. Their errors name `web-custom`.

## License

MIT
