# engine/research

## Purpose
This package is the core of LocalCode's web-research capability: it routes a query to the right search engines by domain (`engineRouter.ts`), retries through a general-purpose fallback chain when an engine comes back empty or throws (`engineRouter.ts`), scores and deduplicates the combined results by keyword density/recency/authority/corroboration (`resultScorer.ts`), and chunks+embeds a finished research report into the project's vector store for later `CodeIndex` retrieval (`indexer.ts`). It is called by the `WebSearch` and `IndexResearch` tool implementations and by the `/research` and `web.search` command handlers in `engine/main.ts`. It must never throw an uncaught error back to those callers — every degraded path (no engines matched, all engines failed, one chunk's embed call rejected) returns an empty/partial result instead, because `main.ts` treats this package as best-effort: "Always emit result even if research engine fails — prevents wizard from freezing" (`engine/main.ts:1085`). No file here cites a specific F-number failure-log entry.

## Key files
| File | Role |
|---|---|
| `engineRouter.ts` | Ranks `SearchEngine`s by domain-keyword match against a query; runs a primary engine with a general-purpose fallback chain (searxng → duckduckgo → wikipedia) when it returns nothing. |
| `indexer.ts` | Chunks a saved research report and embeds+inserts each chunk into the project's `IndexStore`. |
| `resultScorer.ts` | Scores `SearchResult`s on keyword density, recency, source authority, and cross-source corroboration; deduplicates by normalized URL. |
| `types.ts` | Shared `SearchResult` and `SearchEngine` interfaces used across the package and its callers. |

## Important types & functions
- **`routeQuery`** (`engineRouter.ts:27`) — scores each candidate `SearchEngine` against `DOMAIN_KEYWORDS` for the query and returns the engines with score > 0, sorted best-first; `general`/`web`/`meta` domains always get at least a 0.5 floor score so a generic engine survives as fallback. Called by `webSearch.ts` and `main.ts`'s `web.search` handler.
- **`searchWithFallback`** (`engineRouter.ts:61`) — runs `primaryEngine.search()`, swallowing any thrown error into an empty array; if that's empty, walks `GENERAL_FALLBACK_ORDER` (skipping the primary itself) and returns the first non-empty fallback result, or `[]` if every engine fails. Called by `webSearch.ts` for each of the top-ranked engines and by `main.ts`.
- **`indexResearchReport`** (`indexer.ts:5`) — splits `content` into chunks via `chunkResearchReport` (`engine/index/researchChunker.ts`), embeds each with the given `EmbedClient`, and inserts it into `store`; a chunk whose embed call throws is logged and skipped rather than aborting the whole report. Called by `indexResearchTool` (`engine/tools/impl/indexResearch.ts`).
- **`scoreResults`** (`resultScorer.ts:10`) — assigns each result a 0–12 point score (keyword density 0–5, recency 0–2, source authority 0–3, corroboration 0–2) and returns the results sorted best-first. Called by `webSearch.ts` and `main.ts` after fanning out searches.
- **`deduplicateResults`** (`resultScorer.ts:88`) — collapses results by normalized URL (falling back to title if the URL is empty), keeping whichever duplicate has the higher `score`. Called immediately after `scoreResults` in both `webSearch.ts` and `main.ts`.
- **`SearchResult`** (`types.ts:1`) — the common shape (`title`, `url`, `snippet`, `source`, optional `relevance`/`score`/`metadata`) every engine's `.search()` must return and every scorer/router function consumes.
- **`SearchEngine`** (`types.ts:18`) — the interface each concrete engine (arxiv, github, wikipedia, duckduckgo, etc., implemented under `engine/research/engines/`) implements: `name`, `description`, `domains`, `search()`, `healthCheck()`.

## Data flow
1. `webSearch.ts` (or `main.ts`'s `web.search` handler) calls `routeQuery` (`engineRouter.ts:27`) to rank the initialized `SearchEngine`s by domain-keyword match against the query.
2. For the top 2 ranked engines, `searchWithFallback` (`engineRouter.ts:61`) runs the primary engine's `.search()` and, on empty/thrown results, tries `searxng` → `duckduckgo` → `wikipedia` in order until one returns results.
3. `scoreResults` (`resultScorer.ts:10`) scores every result from the fanned-out searches by keyword density, recency, source authority, and cross-source corroboration.
4. `deduplicateResults` (`resultScorer.ts:88`) collapses duplicate URLs, keeping the highest-scored copy, and the caller slices the result to the requested count.
5. Separately, once a report is written to disk, `indexResearchTool` calls `indexResearchReport` (`indexer.ts:5`), which chunks the markdown, embeds each chunk, and inserts it into the `IndexStore` so `CodeIndex` can retrieve it later.

## Gotchas
- `searchWithFallback` swallows the primary engine's own thrown error into `[]` (`engineRouter.ts:67`) before checking for emptiness, so a broken engine is indistinguishable from a query with genuinely no results — it silently falls through to the general chain instead of surfacing the failure. Pinned by `engine/__tests__/research/engines/fallback.test.ts` ("falls back to duckduckgo when primary returns empty", "tries multiple fallbacks in order", "returns empty when all engines fail").
- The fallback chain is fixed at `GENERAL_FALLBACK_ORDER = ['searxng', 'duckduckgo', 'wikipedia']` (`engineRouter.ts:55`) regardless of the query's routed domain — a failed `arxiv` search falls back to Wikipedia, not another academic engine.
- `indexResearchReport` keeps going when one chunk's embed call throws — it logs `[research] Failed to embed chunk ...` and skips that chunk rather than aborting the report, so the returned count can legitimately be less than the chunk count. Pinned by `engine/__tests__/research/indexer.test.ts` ("continues indexing if one chunk fails").
- `deduplicateResults` keys on a normalized URL (protocol/`www.`/trailing-slash stripped) and falls back to the raw `title` only when the URL is empty — two different pages with the same title but no URL would collide. Pinned by `engine/__tests__/research/resultScorer.test.ts` ("normalizes URLs for dedup").
- `routeQuery` returns an empty array only when the input `engines` list itself is empty; any engine tagged `general`/`web`/`meta` always scores at least 0.5, so in practice at least one engine is always returned once engines exist. Pinned by `engine/__tests__/research/engineRouter.test.ts` ("always includes general engines as fallback", "returns empty for empty engine list").
