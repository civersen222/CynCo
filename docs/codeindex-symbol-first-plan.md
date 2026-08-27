# CodeIndex Symbol-First Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodeIndex answer exact-symbol queries with a definition card (full body + references) and fix the semantic path (query prefix, score floor, honest keyword fallback, hygiene, freshness), proving the win on replayed real queries.

**Architecture:** New `engine/index/symbolLookup.ts` (identifier extraction + symbol lookup + definition-card formatting) sits in front of the existing hybrid pipeline inside `ProjectIndexer`. Store gains `findByName` + a name index. Eval harness `scripts/codeindex-eval.mjs` replays real trajectory queries; BEFORE baseline is recorded before any pipeline change.

**Tech Stack:** Bun + bun:sqlite + sqlite-vec (existing), bun:test, Node ESM script for eval.

**Spec:** `docs/codeindex-symbol-first-plan.md` implements `docs/codeindex-symbol-first-spec.md` (commit 7841d59).

**House rules that bind this plan:** tests live in `engine/__tests__/index/`; specs/plans at `docs/` root (docs/superpowers/ is gitignored); web flow at the end (branch → push → PR → merge → pull); wire-check greps are the BLOCKING final step.

---

## File Structure

- Create: `scripts/codeindex-eval.mjs` — trajectory extraction, gold labels, replay, report.
- Create: `benchmark/codeindex-eval/results-2026-08-26-before.md` / `-after.md` — eval outputs (committed).
- Create: `engine/index/symbolLookup.ts` — `extractIdentifiers`, `lookupSymbol`, `formatDefinitionCard`.
- Modify: `engine/index/store.ts` — name index in BASE_SCHEMA, `findByName`, demoted `keywordSearch`.
- Modify: `engine/index/indexer.ts` — purge on open, `searchFormatted` (symbol → semantic → floor annotation), `refreshFromGitStatus`.
- Modify: `engine/index/embedClient.ts` — `embedQuery` (query-side task prefix).
- Modify: `engine/tools/impl/codeIndex.ts` — call `refreshFromGitStatus` + `searchFormatted`; new description.
- Modify: `engine/bridge/conversationLoop.ts:4253` — reindex trigger extended to ReplaceFunction + ApplyPatch.
- Tests: `engine/__tests__/index/findByName.test.ts`, `symbolLookup.test.ts`, `keywordSearchDemoted.test.ts`, `searchFormatted.test.ts`, `embedQueryPrefix.test.ts`, `hygienePurge.test.ts`, `freshness.test.ts`.

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b codeindex-symbol-first` (from up-to-date main, repo root `C:\Users\civer\localcode`).

### Task 1: Eval harness + BEFORE baseline (must precede all pipeline changes)

**Files:**
- Create: `scripts/codeindex-eval.mjs`
- Create: `benchmark/codeindex-eval/results-2026-08-26-before.md`

- [ ] **Step 1: Write the harness.** Node ESM, no deps. Structure:

```js
// scripts/codeindex-eval.mjs
// Replays real retrieval queries from mission trajectories against Grep and
// CodeIndex. Usage: node scripts/codeindex-eval.mjs [--label before|after] [--limit N]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'

const TRAJ_DIR = join(homedir(), '.cynco', 'trajectories')
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'before'

// 1. EXTRACT — schema v2: file is a dict; messages under d.messages.
//    Walk tool_use blocks (Grep/Glob/CodeIndex), pair tool_result by id,
//    keep { tool, input, resultText, cwd (from d.cwd ?? tool call), traj, seq }.
// 2. GOLD — for each Grep call: files present in its resultText that were
//    Read/Edit/ReplaceFunction targets within the NEXT 5 tool calls of the
//    same trajectory. No gold → excluded, counted as coverage loss.
// 3. CLASSIFY — symbol-class if any token matches
//    /[A-Za-z_][A-Za-z0-9_]*/ with (_ or camelCase hump or dunder); else conceptual.
// 4. REPLAY — skip queries whose repo cwd no longer exists locally.
//    (a) Grep: rg --files-with-matches -e <pattern> in cwd, top 3 files.
//    (b) CodeIndex: spawn `bun run scripts/codeindex-eval-worker.ts <cwd> <query>`
//        which imports ProjectIndexer, runs the CURRENT pipeline, prints top
//        file paths as JSON. (Worker keeps bun:sqlite out of the node process.)
// 5. METRIC — gold file ∈ top-3 file paths. Per class: hits/total for Grep
//    and CodeIndex. Also dump score of the top hit per query (for floor
//    calibration) and the 4 burned CodeIndex queries verbatim with their top-1.
// 6. REPORT — markdown table → benchmark/codeindex-eval/results-<date>-<label>.md
```

Also create `scripts/codeindex-eval-worker.ts` (bun): args `cwd query topK`; builds `ProjectIndexer(cwd)`, opens (never full-builds a missing index — print `{"skipped":"no index"}` so the harness excludes, don't spend an hour embedding foreign repos), runs `query({query, topK:3})`, prints `JSON.stringify({files: results.map(r=>r.filePath), scores: results.map(r=>r.score)})`.

- [ ] **Step 2:** Run `PYTHONIOENCODING=utf-8 node scripts/codeindex-eval.mjs --label before`. Expected: report written with coverage %, symbol/conceptual hit-rate table, burned-query top-1s. If C4 mission is still writing to `C:\Users\civer\civkings`, the worker only reads its index (WAL) — acceptable; if sqlite BUSY, the harness marks that repo skipped.
- [ ] **Step 3:** Sanity-read the report: Grep symbol-class hit rate should be well above CodeIndex's (that is the measured problem). If CodeIndex already wins, STOP and re-examine before building anything.
- [ ] **Step 4:** Commit: `git add scripts/codeindex-eval.mjs scripts/codeindex-eval-worker.ts benchmark/codeindex-eval/ && git commit -m "eval: codeindex replay harness + BEFORE baseline from real trajectories"`

### Task 2: `findByName` + name index

**Files:** Modify `engine/index/store.ts`; Test `engine/__tests__/index/findByName.test.ts`

- [ ] **Step 1: Failing test** (in-memory db path via tmpdir, mirror existing index tests):

```ts
import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'

function freshStore() { return new IndexStore(join(mkdtempSync(join(tmpdir(), 'ci-name-')), 'p.db')) }
const chunk = (name: string, file = 'gilded/orders.py') => ({
  filePath: file, chunkType: 'function', name, startLine: 10, endLine: 20,
  content: `def ${name}():\n    pass`, fileHash: 'h' })

describe('IndexStore.findByName', () => {
  it('exact match wins', () => {
    const s = freshStore()
    s.insertChunk(chunk('_bank_debt_lever'), [])
    s.insertChunk(chunk('other'), [])
    const hits = s.findByName('_bank_debt_lever', true)
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('_bank_debt_lever')
    expect(hits[0].score).toBe(1.0)
  })
  it('falls back to case-insensitive when exact pass empty', () => {
    const s = freshStore()
    s.insertChunk(chunk('PowerRowTitle'), [])
    expect(s.findByName('powerrowtitle', true)).toHaveLength(1)
  })
  it('empty for unknown name', () => {
    expect(freshStore().findByName('nope', true)).toHaveLength(0)
  })
})
```

- [ ] **Step 2:** Run `bun test engine/__tests__/index/findByName.test.ts` → FAIL (findByName not a function).
- [ ] **Step 3: Implement.** In BASE_SCHEMA add `CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);` (IF NOT EXISTS ⇒ existing dbs pick it up on next open). Add to IndexStore:

```ts
/** Exact-name definition lookup; case-insensitive second pass when exact is empty. */
findByName(name: string, caseSensitive = true): IndexResult[] {
  const map = (rows: any[]): IndexResult[] => rows.map(r => ({
    filePath: r.file_path, name: r.name, chunkType: r.chunk_type,
    startLine: r.start_line, endLine: r.end_line, content: r.content, score: 1.0,
  }))
  const exact = this.db.prepare('SELECT file_path, name, chunk_type, start_line, end_line, content FROM chunks WHERE name = ?').all(name) as any[]
  if (exact.length > 0 || caseSensitive === false) return map(exact)
  const ci = this.db.prepare('SELECT file_path, name, chunk_type, start_line, end_line, content FROM chunks WHERE LOWER(name) = LOWER(?)').all(name) as any[]
  return map(ci)
}
```

- [ ] **Step 4:** Run test → PASS. Run `bun test engine/__tests__/index/` → all green.
- [ ] **Step 5:** Commit: `git commit -am "index: name index + IndexStore.findByName for exact-symbol lookup"`

### Task 3: `extractIdentifiers`

**Files:** Create `engine/index/symbolLookup.ts`; Test `engine/__tests__/index/symbolLookup.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, it, expect } from 'bun:test'
import { extractIdentifiers } from '../../index/symbolLookup.js'

describe('extractIdentifiers', () => {
  it('finds snake_case and orders longest-first', () => {
    expect(extractIdentifiers('_gen_betrothal_offer function body'))
      .toEqual(['_gen_betrothal_offer'])          // 'function', 'body' are stopwords
  })
  it('finds camelCase', () => {
    expect(extractIdentifiers('where is powerRowTitle used')).toEqual(['powerRowTitle'])
  })
  it('keeps plain words >=3 chars that are not stopwords', () => {
    expect(extractIdentifiers('the ambitions ladder')).toEqual(['ambitions', 'ladder'])
  })
  it('drops stopwords and short tokens', () => {
    expect(extractIdentifiers('what is the def of a')).toEqual([])
  })
  it('dunder counts as identifier', () => {
    expect(extractIdentifiers('__init__ of Spy')).toEqual(['__init__', 'Spy'])
  })
})
```

- [ ] **Step 2:** Run → FAIL (module not found).
- [ ] **Step 3: Implement** in new `engine/index/symbolLookup.ts`:

```ts
import type { IndexStore } from './store.js'          // import type — no runtime cycle
import type { IndexResult } from './types.js'

const STOPWORDS = new Set(['the','and','for','def','class','function','body','where','what','how',
  'find','show','get','all','are','was','were','with','from','that','this','into','used','use',
  'code','file','files','line','lines','method','implementation','definition','of','in','is','a','an','to'])

const humpRe = /[a-z][A-Z]/

/** Identifier-looking tokens from a query, most specific (longest) first. */
export function extractIdentifiers(query: string): string[] {
  const tokens = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    const idLike = t.includes('_') || humpRe.test(t)
    if (idLike || (t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))) out.push(t)
  }
  return out.sort((a, b) => b.length - a.length)
}
```

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit: `git commit -am "index: extractIdentifiers — identifier candidates from queries, longest-first"`

### Task 4: Demote `keywordSearch` (AND over identifiers, never bare common words)

**Files:** Modify `engine/index/store.ts` keywordSearch; Test `engine/__tests__/index/keywordSearchDemoted.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'

function store() { return new IndexStore(join(mkdtempSync(join(tmpdir(), 'ci-kw-')), 'p.db')) }
const put = (s: IndexStore, name: string, content: string) => s.insertChunk({
  filePath: `x/${name}.py`, chunkType: 'function', name, startLine: 1, endLine: 5,
  content, fileHash: 'h' }, [])

describe('demoted keywordSearch', () => {
  it('no longer serves a chunk that merely contains a common word (the Spy bug)', () => {
    const s = store()
    put(s, 'Spy', 'class Spy:\n    def function_table(self): pass')
    // old behavior: OR over ["_gen_betrothal_offer","function","body"] matched Spy via "function"
    expect(s.keywordSearch('_gen_betrothal_offer function body')).toHaveLength(0)
  })
  it('requires ALL identifier-like terms', () => {
    const s = store()
    put(s, 'a', 'betrothal_offer accept handler here')
    put(s, 'b', 'betrothal_offer only')
    const hits = s.keywordSearch('betrothal_offer accept_handler')
    expect(hits.map(h => h.name)).toEqual(['a'])
  })
  it('single identifier still matches content (reference finding)', () => {
    const s = store()
    put(s, 'caller', 'x = _bank_debt_lever()')
    expect(s.keywordSearch('_bank_debt_lever')).toHaveLength(1)
  })
})
```

- [ ] **Step 2:** Run → FAIL (Spy case returns 1). **Step 3: Implement** — replace keywordSearch body:

```ts
/**
 * Keyword fallback. Demoted (2026-08-26): identifier-like terms are ANDed and
 * common words are dropped entirely — the OR-over-everything version served a
 * Spy class for "_gen_betrothal_offer function body" because "function"
 * matched. "No results" beats a wrong answer.
 */
keywordSearch(query: string, topK = 5): IndexResult[] {
  const { extractIdentifiers } = require('./symbolLookup.js')
  const terms: string[] = extractIdentifiers(query).map((t: string) => t.toLowerCase())
  if (terms.length === 0) return []
  const where = terms.map(() => `(LOWER(content) LIKE '%' || ? || '%' OR LOWER(name) LIKE '%' || ? || '%')`).join(' AND ')
  const params = terms.flatMap(t => [t, t])
  const rows = this.db.prepare(`
    SELECT file_path, name, chunk_type, start_line, end_line, content
    FROM chunks WHERE ${where} LIMIT ?
  `).all(...params, topK) as any[]
  return rows.map(r => ({
    filePath: r.file_path, name: r.name, chunkType: r.chunk_type,
    startLine: r.start_line, endLine: r.end_line, content: r.content, score: 0.5,
  }))
}
```

(`require` keeps it CJS-interop-safe under bun and avoids an import cycle at module top; `import type` in symbolLookup already prevents the reverse edge.)

- [ ] **Step 4:** Run new test + `bun test engine/__tests__/index/` → PASS (hybridDefault/hybridRank tests exercise keywordSearch — fix any that asserted the old OR behavior by updating them to identifier queries, noting it in the commit).
- [ ] **Step 5:** Commit: `git commit -am "index: keywordSearch demoted — AND over identifiers, common words never match alone"`

### Task 5: `lookupSymbol` + `formatDefinitionCard` (burned queries as fixtures)

**Files:** Modify `engine/index/symbolLookup.ts`; Test append to `engine/__tests__/index/symbolLookup.test.ts`

- [ ] **Step 1: Failing tests** (fixture = miniature civkings-like store reproducing burned query #1):

```ts
import { lookupSymbol, formatDefinitionCard } from '../../index/symbolLookup.js'
import { IndexStore } from '../../index/store.js'
// reuse store()/put() helpers style from Task 4 tests

describe('lookupSymbol', () => {
  it('burned query 1: "_gen_betrothal_offer function body" returns the definition, not Spy', () => {
    const s = store()
    put(s, 'Spy', 'class Spy:\n    def function_table(self): pass')          // the old wrong answer
    s.insertChunk({ filePath: 'gilded/marriage.py', chunkType: 'function', name: '_gen_betrothal_offer',
      startLine: 40, endLine: 62, content: 'def _gen_betrothal_offer(state):\n    ...', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'gilded/events.py', chunkType: 'function', name: 'accept_offer',
      startLine: 10, endLine: 20, content: 'offer = _gen_betrothal_offer(s)', fileHash: 'h' }, [])
    const r = lookupSymbol(s, '_gen_betrothal_offer function body')!
    expect(r.symbol).toBe('_gen_betrothal_offer')
    expect(r.definitions[0].filePath).toBe('gilded/marriage.py')
    expect(r.references.map(x => x.filePath)).toEqual(['gilded/events.py'])   // def chunk excluded
  })
  it('returns null when no identifier resolves', () => {
    expect(lookupSymbol(store(), 'overall game architecture')).toBeNull()
  })
  it('longest identifier wins over a shorter colliding one', () => {
    const s = store()
    put(s, 'name', 'def name(): pass')
    s.insertChunk({ filePath: 'a.py', chunkType: 'function', name: 'power_row_title',
      startLine: 1, endLine: 3, content: 'def power_row_title(ln): ...', fileHash: 'h' }, [])
    expect(lookupSymbol(s, 'power_row_title name')!.symbol).toBe('power_row_title')
  })
  it('multiple same-name defs ranked by remaining query terms', () => {
    const s = store()
    s.insertChunk({ filePath: 'a.py', chunkType: 'function', name: 'render',
      startLine: 1, endLine: 3, content: 'def render(map): draw the atlas', fileHash: 'h' }, [])
    s.insertChunk({ filePath: 'b.py', chunkType: 'function', name: 'render',
      startLine: 1, endLine: 3, content: 'def render(card): draw a dossier card', fileHash: 'h' }, [])
    const r = lookupSymbol(s, 'render dossier card')!
    expect(r.definitions[0].filePath).toBe('b.py')
  })
})

describe('formatDefinitionCard', () => {
  it('emits the card shape from the spec', () => {
    const card = formatDefinitionCard({
      symbol: '_bank_debt_lever',
      definitions: [{ filePath: 'gilded/orders.py', name: '_bank_debt_lever', chunkType: 'function',
        startLine: 78, endLine: 96, content: 'def _bank_debt_lever():\n    pass', score: 1.0 }],
      references: [{ filePath: 'gilded/chassis.py', name: null as any, chunkType: 'block',
        startLine: 436, endLine: 440, content: 'x = _bank_debt_lever()\nmore', score: 0.5 }],
    })
    expect(card).toContain('=== DEFINITION gilded/orders.py:78-96 (function _bank_debt_lever) ===')
    expect(card).toContain('def _bank_debt_lever():')
    expect(card).toContain('=== REFERENCES (1) ===')
    expect(card).toContain('gilded/chassis.py:436-440  x = _bank_debt_lever()')
  })
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** in `symbolLookup.ts`:

```ts
export interface SymbolLookupResult {
  symbol: string
  definitions: IndexResult[]
  references: IndexResult[]
}

/** BM25-lite ranking of same-name defs by the query terms other than the symbol. */
function rankDefs(defs: IndexResult[], query: string, symbol: string): IndexResult[] {
  const rest = extractIdentifiers(query).filter(t => t !== symbol).map(t => t.toLowerCase())
  if (rest.length === 0 || defs.length < 2) return defs
  const scoreOf = (d: IndexResult) =>
    rest.reduce((n, t) => n + (d.content.toLowerCase().includes(t) ? 1 : 0), 0)
  return [...defs].sort((a, b) => scoreOf(b) - scoreOf(a))
}

export function lookupSymbol(store: IndexStore, query: string): SymbolLookupResult | null {
  for (const candidate of extractIdentifiers(query)) {
    const defs = store.findByName(candidate)
    if (defs.length === 0) continue
    const defKeys = new Set(defs.map(d => `${d.filePath}:${d.startLine}`))
    const references = store.keywordSearch(candidate, 20)
      .filter(r => !defKeys.has(`${r.filePath}:${r.startLine}`))
      .slice(0, 10)
    return { symbol: candidate, definitions: rankDefs(defs, query, candidate), references }
  }
  return null
}

export function formatDefinitionCard(r: SymbolLookupResult): string {
  const parts: string[] = []
  for (const d of r.definitions) {
    parts.push(`=== DEFINITION ${d.filePath}:${d.startLine}-${d.endLine} (${d.chunkType} ${d.name}) ===`)
    parts.push(d.content)
  }
  parts.push(`=== REFERENCES (${r.references.length}) ===`)
  for (const ref of r.references) {
    parts.push(`${ref.filePath}:${ref.startLine}-${ref.endLine}  ${ref.content.split('\n')[0].trim()}`)
  }
  return parts.join('\n')
}
```

(Note: `rankDefs` is a term-count proxy, not full BM25 — the def sets are tiny (same-name collisions), and `hybridRank`'s BM25Index needs a corpus; the spec's intent is "remaining terms break ties", which this does testably. If the eval shows multi-def misrank, upgrade to BM25Index then.)

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit: `git commit -am "index: lookupSymbol + definition card — symbol queries answered with def+refs in one call"`

### Task 6: Query-side embed task prefix

**Files:** Modify `engine/index/embedClient.ts`, `engine/index/indexer.ts:235`; Test `engine/__tests__/index/embedQueryPrefix.test.ts`

- [ ] **Step 1: Failing test** (stub fetch, capture body — same pattern as `embedClient.test.ts`):

```ts
import { describe, it, expect, afterEach } from 'bun:test'
import { EmbedClient } from '../../index/embedClient.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function capture(): { texts: string[][] } {
  const captured = { texts: [] as string[][] }
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    captured.texts.push(body.input)
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })
  }) as any
  return captured
}

describe('embedQuery task prefix', () => {
  it('nomic-* gets search_query: prefix on queries only', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'nomic-embed-text')
    await c.embedQuery('ladder maths')
    expect(cap.texts[0][0]).toBe('search_query: ladder maths')
  })
  it('jina-code gets the retrieval instruction', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'jina-code-embeddings-0.5b')
    await c.embedQuery('ladder maths')
    expect(cap.texts[0][0]).toBe('Find the most relevant code snippet given the following query:\nladder maths')
  })
  it('unknown models get no prefix; embed() (document side) never prefixes', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'mystery-model')
    await c.embedQuery('q'); await c.embed('doc text')
    expect(cap.texts[0][0]).toBe('q'); expect(cap.texts[1][0]).toBe('doc text')
  })
})
```

(Note: env `LOCALCODE_EMBED_MODEL` overrides the constructor arg — unset it at test top if the runner env carries one.)

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** in EmbedClient:

```ts
/**
 * Embed a QUERY (asymmetric retrieval). nomic-embed-text documents
 * `search_query:` as required for queries; jina-code-embeddings uses a task
 * instruction. Documents keep their raw embedding — query-side prefix is the
 * documented usage and the eval before/after catches regressions empirically.
 */
async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  return this.embed(this.queryPrefix() + text, signal)
}

private queryPrefix(): string {
  if (this.model.startsWith('nomic-')) return 'search_query: '
  if (this.model.includes('jina-code')) return 'Find the most relevant code snippet given the following query:\n'
  return ''
}
```

In `indexer.ts` `query()`: change `await this.embedClient.embed(q.query)` → `await this.embedClient.embedQuery(q.query)`.

- [ ] **Step 4:** Run → PASS (plus existing embedClient tests green). **Step 5:** Commit: `git commit -am "index: query-side task prefix for nomic/jina asymmetric retrieval"`

### Task 7: Pipeline reorder + score floor (`searchFormatted`)

**Files:** Modify `engine/index/indexer.ts`, `engine/tools/impl/codeIndex.ts`; Test `engine/__tests__/index/searchFormatted.test.ts`

- [ ] **Step 1: Failing tests** (build a real ProjectIndexer over a tmp dir with 2 small .py files; embed stubbed to fail so the semantic leg degrades to keyword — deterministic):

```ts
describe('ProjectIndexer.searchFormatted', () => {
  it('symbol query returns a definition card', async () => {
    // tmp project: a.py defines power_row_title, b.py calls it; index() with fetch stubbed to 500
    const out = await indexer.searchFormatted({ query: 'power_row_title', topK: 5 })
    expect(out).toContain('=== DEFINITION a.py:')
    expect(out).toContain('=== REFERENCES (1) ===')
  })
  it('non-symbol query falls through to semantic/keyword path', async () => {
    const out = await indexer.searchFormatted({ query: 'zqx_nonexistent_sym', topK: 5 })
    expect(out).toBe('')                                   // empty ⇒ caller runs regex fallback
  })
  it('low-score semantic results carry the low-confidence prefix', async () => {
    // seed a store where keywordSearch (score 0.5 < floor? no — floor targets vector scores)
    // deterministic case: force results with score below SCORE_FLOOR via direct store insert + monkeypatched query
    const out = await indexer.searchFormatted({ query: 'ambitions ladder', topK: 5 })
    if (out) expect(out.startsWith('[low confidence — verify with Read]') || outTopScoreAboveFloor).toBeTrue()
  })
})
```

(The third test as written above is the intent; make it concrete by exporting `SCORE_FLOOR` and `annotateByScore(results, formatted)` as a pure function and unit-testing THAT instead of forcing scores through the full pipeline: `annotateByScore([{...score:0.2}], 'text')` → prefixed; `score 0.9` → untouched. Keyword-only results (flat 0.5 marker score) are ALWAYS prefixed — a demoted-fallback answer is by construction unverified.)

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** in `indexer.ts`:

```ts
import { lookupSymbol, formatDefinitionCard, extractIdentifiers } from './symbolLookup.js'

/**
 * Placeholder pending calibration (Task 11 recalibrates from the eval score
 * dump and cites the number here). Applies to the TOP result's native score:
 * vector similarity when the semantic leg answered, 0.5 marker when only the
 * demoted keyword fallback did (always below floor, deliberately).
 */
export const SCORE_FLOOR = 0.35
export const LOW_CONFIDENCE_PREFIX = '[low confidence — verify with Read]\n'

export function annotateByScore(results: IndexResult[], formatted: string): string {
  if (!formatted) return formatted
  const top = results[0]?.score ?? 0
  return top < SCORE_FLOOR || results.every(r => r.score === 0.5)
    ? LOW_CONFIDENCE_PREFIX + formatted
    : formatted
}
```

Add to ProjectIndexer:

```ts
/**
 * Full retrieval pipeline: symbol lookup → semantic hybrid → ''. The empty
 * string tells codeIndex.ts to run its regex fallback (existing behavior).
 */
async searchFormatted(q: IndexQuery): Promise<string> {
  const sym = lookupSymbol(this.store, q.query)
  if (sym) {
    let card = formatDefinitionCard(sym)
    // Weak single hit + wordy query ⇒ append semantic results (spec Risks).
    const nonIdTerms = q.query.split(/\s+/).length - extractIdentifiers(q.query).length
    if (sym.references.length < 2 && nonIdTerms >= 3) {
      const extra = await this.query(q)
      if (extra.length > 0) card += '\n\n=== SEMANTIC RESULTS ===\n' + this.formatResults(extra)
    }
    return card
  }
  const results = await this.query(q)
  return annotateByScore(results, this.formatResults(results))
}
```

In `codeIndex.ts` execute(): replace the `indexer.query(...)` block with:

```ts
if (indexer) {
  try {
    const output = await indexer.searchFormatted({ query, topK })
    if (output) return { output, isError: false }
  } catch (e) {
    console.log(`[CodeIndex] Query failed for "${query.slice(0, 40)}": ${e}`)
  }
}
```

- [ ] **Step 4:** Run new tests + full `bun test engine/__tests__/index/` → PASS. **Step 5:** Commit: `git commit -am "index: symbol-first pipeline — definition card, then semantic with score floor, then regex"`

### Task 8: Hygiene purge on open

**Files:** Modify `engine/index/indexer.ts` (constructor) + `engine/index/store.ts`; Test `engine/__tests__/index/hygienePurge.test.ts`

- [ ] **Step 1: Failing test:** seed a store (directly, via insertChunk) with a `SESSION_HANDOFF.md` row, a `..\\scratch\\x.py` traversal row, and a legit `a.py` row; construct `new ProjectIndexer(tmpProjectRoot)` over the same db path; assert only `a.py` remains (`store.getIndexedFiles()`), and vec/relationship rows for purged chunks are gone (insert a relationship on the .md chunk, assert relationships count 0).
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement.** Store gains:

```ts
/** Delete chunks (and vec/relationship rows) whose file_path fails `keep`. Returns purge count. */
purgeWhere(keep: (filePath: string) => boolean): number {
  let purged = 0
  for (const f of this.getIndexedFiles()) {
    if (!keep(f)) { this.removeFile(f); purged++ }
  }
  return purged
}
```

ProjectIndexer constructor, after store creation:

```ts
// Stale rows from before the isIndexableSource guard served markdown and
// out-of-tree paths as answers. Purge on open; say so once.
const purged = this.store.purgeWhere(isIndexableSource)
if (purged > 0) console.log(`[index] Purged ${purged} non-indexable files from the index`)
```

(`isIndexableSource` already includes the `isInsideProject` traversal check.)

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit: `git commit -am "index: purge non-indexable/out-of-tree rows on open — stale markdown can no longer answer"`

### Task 9: Mid-mission freshness

**Files:** Modify `engine/index/indexer.ts`, `engine/tools/impl/codeIndex.ts`, `engine/bridge/conversationLoop.ts:4253`; Test `engine/__tests__/index/freshness.test.ts`

- [ ] **Step 1: Failing test** for `refreshFromGitStatus`: tmp dir with `git init` + one committed indexed `a.py`; modify `a.py` on disk (new symbol `fresh_sym`), call `await indexer.refreshFromGitStatus()`, assert `store.findByName('fresh_sym')` now hits. Also: non-git tmp dir → resolves without throwing; untracked new `b.py` → indexed.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** in ProjectIndexer:

```ts
/**
 * Reindex anything git says changed since the stored hash. Runs at query time
 * so the index is never staler than the question being asked. Non-git cwd or
 * git failure ⇒ silent no-op (the hourly staleness rebuild still applies).
 */
async refreshFromGitStatus(): Promise<void> {
  let out: string
  try {
    out = execFileSync('git', ['status', '--porcelain'], {
      cwd: this.projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    })
  } catch { return }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    let rel = line.slice(3).trim().replace(/^"|"$/g, '')
    if (rel.includes(' -> ')) rel = rel.split(' -> ')[1]      // renames: index the new path
    rel = rel.replace(/\//g, sep)
    if (!isIndexableSource(rel)) continue
    try {
      const content = readFileSync(join(this.projectRoot, rel), 'utf-8')
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
      if (this.store.getFileHash(rel) !== hash) await this.reindexFile(rel)
    } catch { /* deleted or unreadable — removeFile handles deletions below */ }
  }
}
```

(add `sep` to the `path` import in indexer.ts). In `codeIndex.ts` execute(), immediately before `searchFormatted`:

```ts
try { await indexer.refreshFromGitStatus() } catch { /* freshness is best-effort */ }
```

In `conversationLoop.ts:4253` extend the trigger:

```ts
if (!result.isError && ['Edit', 'Write', 'MultiEdit', 'ReplaceFunction'].includes(toolName)) {
```

and after that block add the ApplyPatch case (no file_path — paths come from the diff):

```ts
if (!result.isError && toolName === 'ApplyPatch') {
  const paths = [...String(toolInput.patch ?? '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1])
  for (const p of paths) {
    try {
      const { ProjectIndexer } = await import('../index/indexer.js')
      const path = require('path')
      const indexer = new ProjectIndexer(this.executor['cwd'])
      await indexer.reindexFile(path.relative(this.executor['cwd'], path.resolve(this.executor['cwd'], p)))
      indexer.close()
    } catch { /* index not available — non-fatal */ }
  }
}
```

- [ ] **Step 4:** Run freshness test + index suite → PASS. **Step 5:** Commit: `git commit -am "index: query-time git-status refresh + reindex on ReplaceFunction/ApplyPatch"`

### Task 10: Tool description

**Files:** Modify `engine/tools/impl/codeIndex.ts`

- [ ] **Step 1:** Replace the description with:

```ts
description: 'Search the codebase. Give an exact identifier (function/class name) to get its DEFINITION with full body plus ranked references in one call — better than Grep for symbols. Or describe behaviour in words for semantic search. Falls back to regex. Use this BEFORE Read/Grep to find the right files.',
```

Update the `query` property description: `'An exact symbol name ("_bank_debt_lever", "power_row_title") or a natural-language description ("where wars are declared")'`.

- [ ] **Step 2:** `bun test engine/__tests__/` (any prompt-snapshot tests that pin the old string get updated in the same commit). **Step 3:** Commit: `git commit -am "codeindex: description teaches symbol-first usage"`

### Task 11: BLOCKING verification — wire-check, full suite, AFTER eval, floor calibration, web flow

- [ ] **Step 1: Wire-check greps (BLOCKING).** Each new symbol must be imported AND called from the live pipeline (not only tests). Run and record output:

```
grep -rn "findByName\|lookupSymbol\|formatDefinitionCard\|extractIdentifiers\|searchFormatted\|refreshFromGitStatus\|embedQuery\|purgeWhere\|annotateByScore\|SCORE_FLOOR" engine --include=*.ts -l
```

Required call sites: `findByName`/`formatDefinitionCard` ← symbolLookup.ts; `lookupSymbol`/`annotateByScore` ← indexer.ts searchFormatted; `searchFormatted`/`refreshFromGitStatus` ← codeIndex.ts execute; `embedQuery` ← indexer.ts query; `purgeWhere` ← indexer.ts constructor; `extractIdentifiers` ← store.ts keywordSearch + symbolLookup + indexer. Any symbol defined but not called outside tests = NOT DONE.

- [ ] **Step 2:** Full suite: `bun test engine/__tests__/ 2>&1 | tail -20` → green, no new failures vs main.
- [ ] **Step 3: AFTER eval:** `node scripts/codeindex-eval.mjs --label after` → `benchmark/codeindex-eval/results-2026-08-26-after.md`. Success gate from the spec: new CodeIndex top-3 file hit rate ≥ Grep's on symbol-class queries, AND the burned queries return the right file top-1 (where the repo exists). If the gate fails, diagnose (score dump, per-query misses) and fix before proceeding — do not ship a loss.
- [ ] **Step 4: Calibrate SCORE_FLOOR** from the AFTER score dump (value separating gold hits from misses); update the constant + its comment with the number and the eval file cited; re-run `bun test engine/__tests__/index/` + regenerate the after report if the floor changed behavior.
- [ ] **Step 5: Commit + web flow:** commit remaining changes with the wire-check grep output and the before/after table in the commit message body. Then: push branch, `gh pr create` (summary = eval table), merge on GitHub, `git pull` on main. Report to user with the before/after table.
- [ ] **Step 6:** Update `docs/cynco-failure-log.md`? No — this is engine work, not a CynCo mission failure; skip. Report CodeIndex adoption change at the next C4 wave verdict per standing memory.

---

## Self-Review (done at write time)

- **Spec coverage:** §1→Tasks 2/3/5; §2→Tasks 4/6/7; §3→Task 8; §4→Task 9; §5→Task 1 (+Task 11 AFTER); §6→Tasks 10/11. No gaps.
- **Placeholder scan:** SCORE_FLOOR=0.35 is explicitly a calibration placeholder with a dedicated recalibration step (Task 11 Step 4) — intentional, not a TBD.
- **Type consistency:** `IndexResult` used throughout (filePath/name/chunkType/startLine/endLine/content/score); `SymbolLookupResult` defined Task 5, consumed Task 7; `searchFormatted` name consistent Tasks 7/9/11.
- **Known judgment calls recorded inline:** rankDefs term-count proxy instead of BM25Index (Task 5 note); require() to dodge import cycle (Task 4 note); eval worker never full-builds foreign repos (Task 1).

