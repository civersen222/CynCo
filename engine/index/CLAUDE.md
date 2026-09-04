# engine/index

## Purpose
The code index: a SQLite-backed store (`sqlite-vec` when available) plus an embedding client, symbol-first lookup, BM25/RRF hybrid ranking, and a PageRank repo map. It answers "what defines X" and "what's semantically related to Y" for the CodeIndex tool, the research indexer, the vibe controller, and the conversation loop's context injection. It must never index a file outside the project tree, silently degrade retrieval without logging why, or leave a SQLite handle open past a process shutdown (Windows pins the whole directory on an open handle).

## Key files
| File | Role |
|---|---|
| `chunker.ts` | Regex-based chunker (Python/TS/generic) plus tree-sitter-first `chunkFileAsync`; also extracts import/extends relationships. |
| `embedClient.ts` | Dual-dialect (ollama `/api/embed` / openai `/v1/embeddings`) embedding HTTP client with model fallback, deadline racing, and endpoint resolution. |
| `hybridRank.ts` | Fuses vector and keyword `IndexResult` lists via BM25 + Reciprocal Rank Fusion. |
| `indexer.ts` | `ProjectIndexer`: build/incremental-reindex/query/searchFormatted/repo-map, plus the open-indexer registry. |
| `repoMapBuilder.ts` | Resolves import specifiers to indexed files and builds the PageRank `RepoGraph` for the repo map. |
| `researchChunker.ts` | Heading-based chunker for research reports (markdown-shaped, not source code). |
| `store.ts` | `IndexStore`: SQLite schema, path normalization, vector/keyword/name search, metadata. |
| `symbolLookup.ts` | Symbol-first retrieval: identifier extraction, definition/reference resolution, definition-card formatting. |
| `types.ts` | Shared `Chunk`, `IndexResult`, `IndexQuery`, `Relationship` types. |

## Important types & functions
- **`ProjectIndexer`** (`indexer.ts:148`) — owns the store + embed client for one project; `index()`, `query()`, `searchFormatted()`, `buildRepoMap()`, `reindexFile()`, `refreshFromGitStatus()`. Constructed by `codeIndex.ts`, `vibe/controller.ts`, `conversationLoop.ts`, `main.ts`.
- **`closeAllIndexers`** (`indexer.ts:142`) — closes every `ProjectIndexer` registered in the module-level `openIndexers` set; called from `main.ts` shutdown and test teardown.
- **`IndexStore`** (`store.ts:48`) — SQLite store: schema init, `search`/`keywordSearch`/`findByName`/`filesContaining`, `insertChunk`/`insertRelationship`, `purgeWhere`, meta get/set.
- **`lookupSymbol`** (`symbolLookup.ts:154`) — resolves query identifiers to definition chunks plus file-diverse references; falls back to `coverageLookup` (`symbolLookup.ts:120`) when no name resolves. Called by `ProjectIndexer.searchFormatted`.
- **`hybridRank`** (`hybridRank.ts:14`) — fuses vector-ordered and BM25-ranked candidates via RRF; called by `ProjectIndexer.query`.
- **`capRepoMap`** (`indexer.ts:40`) — truncates a repo-map string to ~maxTokens on a line boundary; called by `conversationLoop.ts` when injecting the repo map into context.
- **`EmbedClient`** (`embedClient.ts:90`) — `embed`/`embedBatch`/`embedQuery`/`embedWithDeadline`, dialect probing, fallback-model swap; used by `ProjectIndexer` and `research/indexer.ts`.
- **`chunkFileAsync`** (`chunker.ts:195`) — tries the tree-sitter chunker, falls back to regex `chunkFile` (`chunker.ts:6`); used by `ProjectIndexer.index`/`reindexFile`.
- **`isIndexableSource`** (`indexer.ts:73`) / **`isInsideProject`** (`indexer.ts:57`) — gate what the index will ever store; shared by `walkFiles`, `reindexFile`, `refreshFromGitStatus`, and the on-open `purgeWhere` sweep.

## Data flow
Query path:
1. `codeIndexTool`, `vibe/controller.ts`, or `conversationLoop.ts` call `ProjectIndexer.searchFormatted` (`indexer.ts:319`).
2. `searchFormatted` calls `lookupSymbol` (`symbolLookup.ts:154`); a resolving identifier returns `formatDefinitionCard` (`symbolLookup.ts:176`) — full definition body plus reference sites.
3. If no symbol resolves, `ProjectIndexer.query` (`indexer.ts:283`) embeds the query via `EmbedClient.embedQuery` (`embedClient.ts:120`), then calls `IndexStore.search` (`store.ts:170`, vector) and `IndexStore.keywordSearch` (`store.ts:225`, lexical).
4. Results fuse through `hybridRank` (`hybridRank.ts:14`); output is rendered by `ProjectIndexer.formatResults` (`indexer.ts:380`) and confidence-tagged by `annotateByScore` (`indexer.ts:28`).

Build path:
5. `ProjectIndexer.index` (`indexer.ts:184`) calls `listProjectFiles` (`indexer.ts:107`), hashing each file and skipping ones whose hash matches `IndexStore.getFileHash` (`store.ts:164`).
6. Changed files run through `chunkFileAsync` (`chunker.ts:195`) → `EmbedClient.embedBatch` (`embedClient.ts:172`) → `IndexStore.insertChunk`/`insertRelationship` (`store.ts:141`, `store.ts:157`).
7. `refreshFromGitStatus` (`indexer.ts:396`) reruns steps 5-6 at query time for anything `git status` shows dirty or that changed between the recorded `indexed_head` and current `HEAD`.

## Gotchas
- An open `ProjectIndexer` pins its project directory on Windows via the live SQLite handle (`rmSync` throws `EPERM`); `closeAllIndexers()` (`indexer.ts:142`) exists to release every registered instance — pinned by `engine/__tests__/index/indexerClose.test.ts`.
- `symbolLookup.ts` only `import type`s `store.ts` (`symbolLookup.ts:12`) — no runtime cycle. A prior `require('./symbolLookup.js')` from `store.ts` resolved under Bun but not vitest, which "kept 21 index tests permanently red" (`store.ts:4-8`).
- The `ProjectIndexer` constructor purges non-indexable rows via `IndexStore.purgeWhere(isIndexableSource)` (`indexer.ts:169`) on every open — stale markdown and out-of-tree paths (e.g. `SESSION_HANDOFF.md`) used to be served as answers; pinned by `engine/__tests__/index/hygienePurge.test.ts`.
- `IndexStore.keywordSearch` (`store.ts:225`) ANDs identifier-like terms and drops query-filler words — the un-demoted OR version served a `Spy` class for a query that merely contained the word "function"; pinned by `engine/__tests__/index/keywordSearchDemoted.test.ts`.
- Stored file paths are always forward-slash; `migrateMixedSeparators` (`store.ts:94`) collapses "separator twin" duplicate rows on open — pinned by `engine/__tests__/index/pathNormalization.test.ts`.
- `SCORE_FLOOR = 0.35` (`indexer.ts:24`) is calibrated against a measured eval score dump, not arbitrary — do not change it without rerunning `benchmark/codeindex-eval`.
- Resolve the embedding endpoint with `embedBaseUrlFor` (`embedClient.ts:46`), never `config.baseUrl` directly — under the llama.cpp provider the chat URL has no embedding route.
