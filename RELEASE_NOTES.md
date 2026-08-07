# Unreleased — Upstream correctness and quality sync

- Added zero-config Exa MCP search and page fetching.
- Added Firecrawl keyless search and scrape support and Exa Contents page fetching.
- Wired backend success, latency, and result quality into `best-latency` scoring.
- Improved DuckDuckGo missing-package diagnostics and fixed empty round-robin selection.
- Added credential placeholder rejection and convenience environment variables for more backends.
- Added TypeScript checks, CI, and focused backend, scoring, SSRF, and reader tests.
- Preserved the local Trafilatura default, `readerPriority` semantics, output spillover, raw HTML fallback, and collapsed result rendering.

---

# Release v2.3.0 (web_read reader fallback with readerPriority)

## 🚀 New
- **Sofya** ([sofya.co](https://sofya.co)): adds a `web_search` backend (`POST /v1/search`, full extracted page content at `basic` depth) AND a `web_read` reader (`POST /v1/fetch`, 250+ site-specific parsers), both from a single API key.
- **Pluggable `web_read` reader**: `web_read` is no longer hardcoded to Jina. Choose `trafilatura` (default, local CLI), `jina` (free), or `sofya` via the top-level `"reader"` config setting, or per-call with the `reader` tool param.

## 🚀 New
- **Reader fallback with `readerPriority`**: `web_read` now supports a priority-ordered reader fallback list in `search.json`. When no explicit `reader` parameter is passed, readers are tried in `readerPriority` order until one succeeds.
- **`readerPriority` config**: Replaces the top-level `reader` setting. Example: `"readerPriority": ["trafilatura", "jina", "sofya"]`. Unset → single Trafilatura (no fallback, same as before).
- **Explicit `reader` param**: When passed, only that reader is used — no fallback.
- **Rendered result**: Failed readers are shown in both collapsed (`⚠ [reader failed: jina]`) and expanded (error preamble) views.

## 🔧 Breaking
- Removed top-level `"reader"` config setting. Use `"readerPriority"` instead.

## 🔧 Changes
- `types.ts`: Removed `reader` from `SearchConfig`. Added `readerPriority?: ("jina" | "sofya" | "trafilatura")[]`.
- `search-hub.ts`: Extracted `fetchWithReader()` helper. `web_read.execute` loops through readers with fallback. `renderResult` shows failed readers in collapsed/expanded views.
- `search.json.example`: Updated to `readerPriority`.
- `README.md`: Documented readerPriority, updated config example.
- `tests/web-read.test.ts`: 12 tests covering single-reader, priority fallback, partial priority, explicit param override, and aggregated error cases.

## 📊 Stats
- 12 new web-read tests (total: 82)
- Backend count unchanged (17)

---

# Release v2.2.0 (Sofya backend + pluggable web_read reader)

---

# Release v2.1.0 (4 new backends)

## 🚀 New Backends
- **Brave LLM Context** — pre-extracted AI-grounding chunks, token-budget aware. Same API key as Brave Search.
- **Linkup** — EU/GDPR-compliant AI-native search. x402 crypto payment support. $20/mo free credit.
- **You.com** — web + news search. Up to 100 results per call. Built-in news intent detection. $100 free credits.
- **fastCRW** — Firecrawl-compatible search + scrape. Self-hostable (AGPL-3.0). 500 free credits/mo.

## 📊 Stats
- 16 backends total (was 12)
- 65 tests passing (was 47)
- 27 `.ts` files (4 new adapters)

## 🔧 Changes
- `types.ts`: Added `braveLLM`, `linkup`, `youcom`, `fastcrw` to SearchConfig. Added `tokenBudget`, `depth`, `baseUrl` per-backend options.
- `registry.ts`: Registered 4 new BACKEND_DEFS with proper key resolution.
- `parsers.ts`: Added `parseBraveLLM`, `parseLinkup`, `parseYoucom`, `parseFastcrw`.
- `package.json`: Updated description to reflect 16 backends.

---

# Release v2.0.1 (fix broken 2.0.0 tarball)

**v2.0.0 was deprecated.** NPM tarball was missing module files due to restrictive `.npmignore`.

Features same as 2.0.0:
- Smart backend scoring (composite: success rate + latency + quality)
- Search result caching (LRU with TTL, configurable)
- DuckDuckGo v9.x metasearch (backend, region, timelimit)
- Per-backend config (timeout, maxResults, headers)
- Combine mode config option in search.json
- Modular architecture (20 files from 1 monolith)
- 21 new integration tests

Fixes:
- `.npmignore` now includes all extension module files
- Publish workflow skips if version already on registry
