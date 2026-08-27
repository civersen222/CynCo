# CodeIndex Symbol-First Retrieval — Design

**Date:** 2026-08-26
**Status:** approved (user picked approach A; success bar: "win on real queries")

## Problem

CodeIndex is the engine's semantic code-search tool. Across the 60 newest mission
trajectories the model called Grep 295 times, Glob 19, CodeIndex 4 — despite the
system prompt calling CodeIndex mandatory and moment-of-mistake nudges riding on
Grep output. The adoption failure is a quality failure:

- **~85% of real Grep queries are exact-symbol lookups** (`_BANK_DEBT`,
  `power_row_title`, `can_place_informant`). Grep answers these with a 14%
  no-match rate. CodeIndex routes them through cosine similarity like prose.
- **All 4 real CodeIndex calls returned garbage.** Measured failure chain:
  `"_gen_betrothal_offer function body"` → vector search empty → keyword
  fallback (`store.ts keywordSearch`) ORs every term ≥3 chars via LIKE with a
  flat 0.5 score and no ranking → any chunk containing the word "function"
  qualifies → a `Spy` class is served with a straight face. A markdown file
  (`SESSION_HANDOFF.md`) was also served, despite `isIndexableSource` — stale
  rows from before that guard existed.
- Queries are embedded raw with no task prefix (nomic-embed-text documents
  `search_query:` as required; jina-code has an equivalent instruction format).
- No score floor: a 0.23 answer is served identically to a 0.95 answer.
- Freshness: `reindexFile` fires only for Edit/Write/MultiEdit
  (conversationLoop.ts:4253) — files created by Bash, ApplyPatch, or
  ReplaceFunction are invisible until a full rebuild (>5-file delta or 1h age).

## Goal

Make CodeIndex decisively better than Grep on the query mix the model actually
produces. A symbol query must return the definition (full body, file:line) plus
ranked references in one call — an answer Grep structurally cannot give (it
cannot tell a definition from its 40 call sites, and its output demands a
follow-up Read).

**Success gate:** on the replayed real-query set, new CodeIndex top-3 file hit
rate ≥ Grep's on symbol-class queries, and the 4 burned queries return the
right file top-1 (where the repo exists locally).

## Non-goals

- No LSP servers for def/refs (option B, rejected as 10x scope for marginal
  gain on this query mix; the existing lspManager diagnostics stay as-is).
- No crawl-tool restriction/forcing (task #39 option C is a separate decision,
  only worth taking after this quality work).
- No new daemon, no new storage backend.

## Design

### 1. Symbol lookup layer (`engine/index/symbolLookup.ts` + store support)

The `chunks` table already stores `name`, `chunk_type`, `file_path`,
`start_line`, `end_line`, `content` per chunk. Add:

- `CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name)` in
  `store.ts` BASE_SCHEMA.
- `IndexStore.findByName(name: string, caseSensitive: boolean): IndexResult[]`
  — exact match on `name` (then `LOWER(name)` when the exact pass is empty).
- `extractIdentifiers(query: string): string[]` — tokens matching
  `/[A-Za-z_][A-Za-z0-9_]*/` that look like identifiers: contain `_`, or
  camelCase hump, or dunder, or length ≥ 3 and not an English stopword
  (the/and/for/def/class/function/body/where/what/how...). Ordered longest
  first — the most specific identifier wins.
- `lookupSymbol(store, query)` — for each candidate identifier in order, run
  `findByName`; first identifier with hits wins. Returns
  `{ definitions: IndexResult[], references: IndexResult[], symbol: string }`.
  References = `keywordSearch(symbol)` hits minus the definition chunks,
  capped at 10. Multiple same-name definitions are all returned, ranked by
  BM25 of the remaining query terms against chunk content.

### 2. Query pipeline (`ProjectIndexer.query`, `codeIndex.ts`)

Order: symbol lookup → semantic hybrid → regex fallback (existing).

- Symbol hit → format a **definition card**:

  ```
  === DEFINITION gilded/orders.py:78-96 (function _bank_debt_lever) ===
  <full chunk content>
  === REFERENCES (4) ===
  gilded/chassis.py:436-436  <first line of the referencing chunk>
  ```

- No symbol hit → today's hybrid RRF with two fixes:
  - **Task prefix:** queries embedded as `search_query: <q>` when the embed
    model is nomic-*; jina-code models use their documented query instruction.
    Documents keep their existing embedding (re-embedding the corpus is a
    rebuild-time concern; prefix only applies to queries, which is where the
    asymmetry matters for these models).
  - **Score floor:** results below the floor are prefixed `[low confidence —
    verify with Read]` instead of served straight. Floor calibrated from the
    eval set (the value that separates gold hits from misses on the replayed
    queries), stored as a named constant with the calibration number cited.
- Keyword fallback (`keywordSearch`) is demoted: it requires ALL identifier-like
  terms to match (AND over identifiers, OR over the rest), never bare common
  words. If that leaves nothing, say so — "no results" beats a wrong `Spy`.

### 3. Index hygiene (purge + guard)

On `ProjectIndexer` open/build: delete chunk rows (and their vec/relationship
rows) whose `file_path` fails `isIndexableSource` or escapes the project root.
Log the purge count once. Guard test seeds a store with a `.md` row and a
traversal row and asserts both are gone after open.

### 4. Mid-mission freshness

- Extend the reindex trigger in conversationLoop to ApplyPatch and
  ReplaceFunction (same `file_path` input shape).
- At CodeIndex query time: run `git status --porcelain` in the cwd (fast;
  non-git cwd → skip). Any modified/untracked path that `isIndexableSource`
  accepts and whose hash differs from the stored one → `reindexFile` before
  answering. The index is then never staler than the current query.

### 5. Eval harness (`scripts/codeindex-eval.mjs`)

- Extracts every Grep/Glob/CodeIndex tool_use + paired tool_result from
  `~/.cynco/trajectories/*.messages.json` (schema v2: top-level dict,
  `messages` list).
- Gold label per Grep query: the files that appeared in its result AND were
  Read/Edited within the next 5 tool calls of the same trajectory. Queries with
  no gold label are excluded from scoring (reported as coverage).
- Classifies queries: symbol-class (any identifier-like token) vs conceptual.
- Replays each query against the repo it targeted (skip repos that no longer
  exist locally) through (a) Grep as originally invoked, (b) the new
  CodeIndex pipeline. Metric: gold file present in top-3 results.
- Output: per-class hit-rate table, before/after, written to
  `benchmark/codeindex-eval/results-<date>.md`. The BEFORE run is the
  baseline recorded prior to any pipeline change.

### 6. Wiring and verification

- `codeIndexTool.description` updated: symbol queries are first-class
  ("give an exact identifier to get its definition and references in one
  call; or describe behaviour in words for semantic search").
- Tests: unit tests per new function (extractIdentifiers, findByName,
  lookupSymbol, definition-card formatting, AND-keyword fallback, purge,
  freshness reindex, prefix selection); the two burned queries reproduced as
  fixtures.
- BLOCKING final step: wire-check grep for every new symbol proving each is
  imported and called from the live pipeline; eval before/after table
  produced and cited.

## Risks

- **Common-word symbol collisions** (`name`, `world`): mitigated by
  longest-identifier-first ordering and the stopword list; a symbol hit still
  shows file:line so a wrong hit is self-evident, and semantic results are
  appended when the definition card is a single weak hit (< 2 references and
  query has ≥ 3 non-identifier terms).
- **Eval gold-label noise**: auto-labels are approximate; coverage is
  reported so the number is honest about its base.
- **Embed prefix mismatch with already-embedded corpus**: query-side prefix is
  the documented usage for asymmetric retrieval on these models; eval
  before/after catches any regression empirically.
