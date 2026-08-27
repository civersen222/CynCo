/**
 * Symbol-first retrieval: exact-identifier lookup ahead of semantic search.
 *
 * Measured motivation (benchmark/codeindex-eval/results-2026-08-27-before.md):
 * ~85% of real mission Grep queries are exact-symbol lookups, and the old
 * pipeline routed them through cosine similarity like prose — 63% top-3 vs
 * Grep's 92% on symbol-class queries, and a literal Spy class served for
 * "_gen_betrothal_offer function body". A symbol query should return the
 * definition (full body, file:line) plus ranked references in one call —
 * an answer Grep structurally cannot give.
 */
import type { IndexStore } from './store.js'   // import type — no runtime cycle with store.ts
import type { IndexResult } from './types.js'

const STOPWORDS = new Set(['the', 'and', 'for', 'def', 'class', 'function', 'body', 'where', 'what', 'how',
  'find', 'show', 'get', 'all', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'into', 'used', 'use',
  'code', 'file', 'files', 'line', 'lines', 'method', 'implementation', 'definition', 'of', 'in', 'is', 'a', 'an', 'to'])

const humpRe = /[a-z][A-Z]/

/**
 * Identifier-looking tokens from a query, most specific (longest) first.
 * A token qualifies if it contains `_` or a camelCase hump (structurally an
 * identifier), or is ≥3 chars and not a query-filler stopword.
 */
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

export interface SymbolLookupResult {
  symbol: string
  definitions: IndexResult[]
  references: IndexResult[]
}

/**
 * Rank same-name definitions by the query terms other than the symbol
 * (term-count proxy for BM25 — def sets are tiny same-name collisions; the
 * remaining terms only need to break the tie).
 */
function rankDefs(defs: IndexResult[], query: string, symbol: string): IndexResult[] {
  const rest = extractIdentifiers(query).filter(t => t !== symbol).map(t => t.toLowerCase())
  if (rest.length === 0 || defs.length < 2) return defs
  const scoreOf = (d: IndexResult): number =>
    rest.reduce((n, t) => n + (d.content.toLowerCase().includes(t) ? 1 : 0), 0)
  return [...defs].sort((a, b) => scoreOf(b) - scoreOf(a))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Module-level constants (TREASURY_LABELS, ACCEPT_SCORE) have no named chunk,
 * so findByName never fires for them. A chunk whose content assigns the
 * candidate at line start is its definition in every way that matters.
 * Measured: both eval misses of this shape pointed at the defining module,
 * while keyword rowid order served their test files instead.
 */
function assignmentDefs(store: IndexStore, candidate: string): IndexResult[] {
  const re = new RegExp(`^\\s*${escapeRe(candidate)}\\s*[:=][^=]`, 'm')
  return store.keywordSearch(candidate, 50)
    .filter(h => re.test(h.content))
    .map(h => ({ ...h, score: 1.0 }))
}

/**
 * References ordered file-diverse: one chunk per referencing file before any
 * file repeats, non-definition files first. Retrieval is scored per FILE in
 * top-k — five rowid-adjacent chunks from one test file used to fill every
 * slot while the actual second file (registry.py, 2026-08-27 eval) was cut.
 */
function diverseReferences(refs: IndexResult[], defFiles: Set<string>, cap: number): IndexResult[] {
  const byFile = new Map<string, IndexResult[]>()
  for (const r of refs) {
    if (!byFile.has(r.filePath)) byFile.set(r.filePath, [])
    byFile.get(r.filePath)!.push(r)
  }
  const files = [...byFile.keys()].sort((a, b) => (defFiles.has(a) ? 1 : 0) - (defFiles.has(b) ? 1 : 0))
  const out: IndexResult[] = []
  for (let round = 0; out.length < cap; round++) {
    let served = false
    for (const f of files) {
      const chunk = byFile.get(f)![round]
      if (!chunk) continue
      out.push(chunk)
      served = true
      if (out.length >= cap) break
    }
    if (!served) break
  }
  return out
}

/**
 * Resolve the most specific identifier in `query` to its definition chunks and
 * referencing chunks. Two passes over the identifiers (longest-first): named
 * definitions beat assignment-style ones for ANY candidate; null when nothing
 * resolves — the caller falls through to semantic search.
 */
export function lookupSymbol(store: IndexStore, query: string): SymbolLookupResult | null {
  const candidates = extractIdentifiers(query)
  for (const named of [true, false]) {
    for (const candidate of candidates) {
      const defs = named ? store.findByName(candidate) : assignmentDefs(store, candidate)
      if (defs.length === 0) continue
      const defKeys = new Set(defs.map(d => `${d.filePath}:${d.startLine}`))
      const references = diverseReferences(
        store.keywordSearch(candidate, 50).filter(r => !defKeys.has(`${r.filePath}:${r.startLine}`)),
        new Set(defs.map(d => d.filePath)),
        10,
      )
      return { symbol: candidate, definitions: rankDefs(defs, query, candidate), references }
    }
  }
  return null
}

/** The one-call answer: full definition bodies, then reference sites one line each. */
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
