# engine/retrieval

## Purpose
Standalone algorithms for code search and code-graph ranking, consumed by `engine/index/` — never called directly by TUI, CLI, or agent code. `treeSitterChunker.ts` parses a source file into AST-aware chunks (functions, classes, class methods, module-level constants, import blocks); `bm25Index.ts` and `hybridSearch.ts` power lexical + vector fusion ranking; `repoMap.ts` builds a symbol reference graph and PageRanks it. This package must never assume tree-sitter grammars are available — callers (`engine/index/chunker.ts`) depend on `treeSitterChunk` returning `null` on unsupported/failed parses so they can fall back to a regex chunker. It was reshaped by the 2026-08-27 eval, which found that class methods past the 80-line class chunk cap (the `wed_match`/`marriages.py:209` case) and module-level constants (`TREASURY_LABELS`/`ACCEPT_SCORE`-style) were silently missing from chunk output.

## Key files
| File | Role |
|---|---|
| `treeSitterChunker.ts` | Parses a file with web-tree-sitter into named AST chunks (functions, classes, class methods, module constants, import blocks) with import relationships |
| `bm25Index.ts` | In-memory BM25 lexical index (add/remove/search) used as the lexical leg of hybrid ranking |
| `hybridSearch.ts` | Reciprocal Rank Fusion of two ranked lists (vector + lexical) into one |
| `repoMap.ts` | `RepoGraph`: definition/reference graph with seeded (personalized) PageRank over symbol nodes |

## Important types & functions
- **`CHUNKER_VERSION`** (`treeSitterChunker.ts:20`) — version string bumped whenever chunk emission shape changes; read by `engine/index/indexer.ts` to force a one-time re-chunk of unchanged-hash files after a chunker upgrade.
- **`treeSitterChunk`** (`treeSitterChunker.ts:116`) — async, parses `filePath`/`content` via tree-sitter, returns `ASTChunk[]` or `null` for unsupported extensions/failed grammar load; called by `engine/index/chunker.ts`'s `chunkFileAsync`, which falls back to the regex `chunkFile` when it returns `null` or throws.
- **`ASTChunk`** (`treeSitterChunker.ts:8`) — `Chunk` (from `../index/types.js`) extended with optional `relationships` (import edges) and `signature` fields; the return element type of `treeSitterChunk`.
- **`ChunkRelationship`** (`treeSitterChunker.ts:6`) — `{ targetFile, relType: 'imports' }`; populated only on the synthetic `import_block` chunk.
- **`BM25Index`** (`bm25Index.ts:17`) — class with `add`/`remove`/`search(query, topK)` implementing Okapi BM25 (K1=1.5, B=0.75); instantiated fresh per query in `engine/index/hybridRank.ts`.
- **`reciprocalRankFusion`** (`hybridSearch.ts:14`) — merges two descending-score `RankedItem[]` lists via `1/(k+rank)` per list (default `k=60`), returns top `topK`; called by `hybridRank` in `engine/index/hybridRank.ts` to fuse vector and BM25 rankings.
- **`RankedItem`** (`hybridSearch.ts:1`) — `{ id: number; score: number }`, the input/output element type for `reciprocalRankFusion`.
- **`RepoGraph`** (`repoMap.ts:14`) — class holding definitions (`addDefinition`) and reference edges (`addReference`), plus `pageRank(seedFiles, topK, iterations=20, damping=0.85)` for seeded PageRank; built by `buildRepoGraph` in `engine/index/repoMapBuilder.ts`.
- **`RankedDefinition`** (`repoMap.ts:1`) — `{ file, name, kind, score }`, the return element type of `RepoGraph.pageRank`.

## Data flow
1. `engine/index/chunker.ts`'s `chunkFileAsync` calls `treeSitterChunk(filePath, content)` (`treeSitterChunker.ts:116`); on `null`/throw it falls back to the regex `chunkFile`.
2. `treeSitterChunk` lazily inits the tree-sitter WASM runtime (`ensureInitialized`) and loads the per-extension grammar (`loadLanguage`), then parses `content` into an AST via `ParserClass`/`LanguageClass`.
3. Walking the root node's top-level children, it collects import nodes for a merged `import_block` chunk (with `ChunkRelationship[]` extracted by `extractImportTarget`), emits named `function`/`class`/`module` chunks via the internal `push` helper (each capped at 80 lines from its start line), and for every class also calls `pushClassMethods` to emit each method as its own named `function` chunk regardless of the class chunk's cap.
4. `engine/index/indexer.ts` stores the resulting chunks and, at full build, records `CHUNKER_VERSION` as `chunker_version` metadata; on incremental refresh it compares stored `chunker_version` to `CHUNKER_VERSION` and force-re-chunks every indexed file once if stale.
5. At query time, `engine/index/hybridRank.ts` builds a fresh `BM25Index` over candidate chunks, ranks the query lexically (`BM25Index.search`) alongside a vector ranking, and fuses both lists with `reciprocalRankFusion` (`hybridSearch.ts:14`).
6. Separately, `engine/index/repoMapBuilder.ts`'s `buildRepoGraph` feeds indexed definitions and relationships into a `RepoGraph`, then `RepoGraph.pageRank` (seeded by files relevant to the query) produces `RankedDefinition[]` for the repo map shown to the caller.

## Gotchas
- `treeSitterChunk` returning `null` is a normal, expected signal (unsupported extension or missing grammar) — callers must treat it as "fall back to regex chunking," not as an error.
- `CHUNKER_VERSION` must be bumped whenever chunk emission shape changes: an already-indexed file's content hash is unchanged, so without a version bump `refreshFromGitStatus`'s hash-compare never re-chunks it and old chunk sets live forever. Pinned by `engine/__tests__/index/freshness.test.ts` ("re-chunks unchanged files when the chunker version is stale", "records the chunker version at full build").
- Class methods past the 80-line class-chunk cap are NOT dropped: `pushClassMethods` emits every method in a class body as its own named `function` chunk independent of the class chunk's line cap (the `wed_match`, `marriages.py:209` 2026-08-27 eval miss). Pinned by `engine/__tests__/retrieval/treeSitterChunker.test.ts` ("a Python method past the 80-line class cap is a named function chunk", "a TypeScript class method is a named function chunk").
- Module-level assignments (Python `expression_statement` assignments, TS `lexical_declaration`/`variable_declaration`) get their own named `module` chunk — without this, `findByName` never fires for constants like `TREASURY_LABELS`/`ACCEPT_SCORE` (another 2026-08-27 eval miss). Pinned by `engine/__tests__/retrieval/treeSitterChunker.test.ts` ("a Python module-level constant is a named chunk", "a bare TS top-level const is a named chunk").
- Every emitted chunk (function/class/module/import_block) is capped at `startLine + 79` (80 lines) via `Math.min(rawEnd, startLine + 79)` in `push` and the import-block builder — a chunk's `content` can be truncated relative to the underlying AST node.
- `loadLanguage` and the WASM runtime path are resolved via each package's explicit `exports` subpath (`web-tree-sitter/web-tree-sitter.wasm`, `tree-sitter-wasm/<lang>/tree-sitter-<lang>.wasm`) rather than via `package.json`, because Node's strict exports enforcement under vitest blocks resolving `package.json` directly.
- `RepoGraph.addReference` silently no-ops if either endpoint node hasn't been added via `addDefinition` first — it does not create implicit nodes.
