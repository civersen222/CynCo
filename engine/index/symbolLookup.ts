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

const isStructuralId = (t: string): boolean => t.includes('_') || humpRe.test(t)

/**
 * Only constant-looking names may resolve via assignment: plain lowercase
 * words match ordinary local assignments everywhere (`wars = ...` hijacked a
 * whole replay from the coverage fallback), while the module constants the
 * assignment leg exists for are structural or ALL_CAPS.
 */
const isConstLike = (t: string): boolean => isStructuralId(t) || (t.length >= 3 && t === t.toUpperCase())

/**
 * No candidate has a definition, but the query names 2+ structural identifiers
 * (grep-alternation shape: `garrison_stub\|heir_picker_rows\|seed_42`). The
 * file covering the MOST distinct identifiers is almost certainly the answer —
 * the 2026-08-27 eval's gold test file contained all three while single-symbol
 * lookup chased each in isolation. Prose queries never reach here: plain words
 * are not structural, and <2 identifiers returns null (semantic fallback).
 */
function coverageLookup(store: IndexStore, candidates: string[]): SymbolLookupResult | null {
  const ids = candidates.filter(isStructuralId)
  if (ids.length < 2) return null
  const covered = new Map<string, Set<string>>()
  const firstChunk = new Map<string, IndexResult>()
  for (const id of ids) {
    // filesContaining, not keywordSearch: one row per FILE, so a chunk-heavy
    // file cannot hoard every slot and hide the file covering more identifiers.
    for (const hit of store.filesContaining(id, 50)) {
      if (!covered.has(hit.filePath)) covered.set(hit.filePath, new Set())
      covered.get(hit.filePath)!.add(id)
      if (!firstChunk.has(hit.filePath)) firstChunk.set(hit.filePath, hit)
    }
  }
  const ranked = [...covered.entries()].sort((a, b) => b[1].size - a[1].size)
  if (ranked.length === 0 || ranked[0][1].size < 2) return null
  return {
    symbol: ids.join(' '),
    definitions: [],
    references: ranked.slice(0, 10).map(([file]) => firstChunk.get(file)!),
  }
}

/**
 * Resolve the identifiers in `query` to definition chunks and referencing
 * chunks. EVERY candidate that resolves contributes its definitions (longest
 * candidate first — all 3 CI-only misses of the 2026-08-27 after-eval were
 * grep alternations where the second symbol's defining file never surfaced).
 * Per candidate: named definitions, else assignment-style; capped at 2 defs
 * each (rankDefs picks the ones matching the rest of the query — `__init__`
 * alone would flood the card) and 6 total. References follow the primary
 * (longest resolving) candidate. Nothing resolves ⇒ coverage fallback, then
 * null — the caller falls through to semantic search.
 */
export function lookupSymbol(store: IndexStore, query: string): SymbolLookupResult | null {
  const candidates = extractIdentifiers(query)
  const resolved: { candidate: string; defs: IndexResult[] }[] = []
  for (const candidate of candidates) {
    const named = store.findByName(candidate)
    const defs = named.length > 0 ? named : isConstLike(candidate) ? assignmentDefs(store, candidate) : []
    if (defs.length > 0) resolved.push({ candidate, defs: rankDefs(defs, query, candidate).slice(0, 2) })
  }
  if (resolved.length === 0) return coverageLookup(store, candidates)

  const definitions = resolved.flatMap(r => r.defs).slice(0, 6)
  const defKeys = new Set(definitions.map(d => `${d.filePath}:${d.startLine}`))
  const primary = resolved[0].candidate
  const references = diverseReferences(
    store.keywordSearch(primary, 50).filter(r => !defKeys.has(`${r.filePath}:${r.startLine}`)),
    new Set(definitions.map(d => d.filePath)),
    10,
  )
  return { symbol: primary, definitions, references }
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
