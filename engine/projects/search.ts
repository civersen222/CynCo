/**
 * engine/projects/search.ts — one search function, three callers.
 *
 * Per project: vector kNN over the store (when it has vectors and we have an
 * embed client) and BM25 over every prose chunk of the requested kinds
 * (`IndexStore.keywordSearch` ANDs its terms and is useless for a sentence —
 * R3), fused by reciprocal rank. Across projects: the same per-project run
 * for every registry entry with the query embedded ONCE, merged by fused
 * score. A project that cannot be opened is named in `skipped`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BM25Index } from '../retrieval/bm25Index.js'
import { reciprocalRankFusion } from '../retrieval/hybridSearch.js'
import type { EmbedClient } from '../index/embedClient.js'
import type { IndexResult } from '../index/types.js'
import { readRegistry } from './registry.js'
import { readProject } from './layout.js'
import { openProjectStore } from './ingest.js'

export type SearchKind = 'knowledge' | 'artifact' | 'chat'
export type SearchHit = { slug: string; projectName: string; filePath: string; kind: SearchKind; heading: string; ordinal: number; passage: string; score: number }
export type SearchScope = { slug: string } | 'all'
export type SearchDeps = { home: string; embed: EmbedClient | null }
export type SearchResult = { hits: SearchHit[]; skipped: { slug: string; reason: string }[]; mode: 'hybrid' | 'keyword' }
export const RRF_K = 60
const ALL_KINDS: SearchKind[] = ['knowledge', 'artifact', 'chat']
const CANDIDATES = 20

/**
 * The 'all'-scope target list, read from the cache as it stands — NOT through
 * `readRegistry`, whose `isFresh` check would quietly rebuild a stale cache
 * (dropping a project whose folder just vanished) before the per-target
 * `existsSync` guard below ever gets a turn at it. A missing or unparsable
 * cache still falls back to `readRegistry` so a first run bootstraps it.
 */
function registeredTargets(home: string): { slug: string; name: string }[] {
  const p = join(home, 'registry.json')
  if (existsSync(p)) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')) as { projects?: { slug: string; name: string }[] }
      if (v && Array.isArray(v.projects)) return v.projects.map(e => ({ slug: e.slug, name: e.name }))
    } catch (e) {
      console.log(`[projects] registry.json unreadable for search, bootstrapping: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return readRegistry(home).registry.projects.map(e => ({ slug: e.slug, name: e.name }))
}

async function searchOne(deps: SearchDeps, slug: string, projectName: string, query: string, queryEmbedding: number[] | null, kinds: SearchKind[], limit: number, excludeFilePath?: string): Promise<SearchHit[]> {
  const dir = join(deps.home, slug)
  const store = openProjectStore(dir)
  try {
    const rows = store.allChunks(kinds).filter(r => r.filePath !== excludeFilePath)
    if (rows.length === 0) return []
    const byId = new Map<number, IndexResult>(rows.map(r => [r.id as number, r]))
    const bm25 = new BM25Index()
    for (const r of rows) bm25.add(r.id as number, `${r.name ?? ''} ${r.content}`)
    const lexical = bm25.search(query, CANDIDATES).map(x => ({ id: x.docId, score: x.score }))
    const vector = queryEmbedding && store.isVecEnabled
      ? store.search(queryEmbedding, CANDIDATES).filter(r => r.id != null && byId.has(r.id)).map(r => ({ id: r.id as number, score: r.score }))
      : []
    // No vector leg (no embed client, or this store has no vectors): rank by the
    // lexical score itself, not by rank position. A rank-based score (1/(k+rank))
    // is fine within one project's own result list — it is already BM25-sorted —
    // but collapses to the SAME value at the same rank across different projects
    // once fan-out concatenates and re-sorts by score, silently discarding which
    // project's top hit was actually the stronger match.
    const fused = vector.length ? reciprocalRankFusion(vector, lexical, RRF_K, limit) : lexical.slice(0, limit)
    return fused.map(f => {
      const r = byId.get(f.id)!
      return { slug, projectName, filePath: r.filePath, kind: r.chunkType as SearchKind, heading: r.name ?? '', ordinal: r.startLine, passage: r.content, score: f.score }
    })
  } finally {
    store.close()
  }
}

export async function searchProjects(deps: SearchDeps, q: { query: string; scope: SearchScope; kinds?: SearchKind[]; limit?: number; excludeFilePath?: string }): Promise<SearchResult> {
  const kinds = q.kinds?.length ? q.kinds : ALL_KINDS
  const limit = Math.max(1, Math.min(q.limit ?? 10, 50))
  const skipped: { slug: string; reason: string }[] = []
  let queryEmbedding: number[] | null = null
  if (deps.embed) {
    try { queryEmbedding = await deps.embed.embedQuery(q.query) } catch (e) {
      console.log(`[projects] query embedding unavailable, keyword only: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const targets: { slug: string; name: string }[] = []
  if (q.scope === 'all') {
    targets.push(...registeredTargets(deps.home))
  } else {
    const meta = readProject(deps.home, q.scope.slug)
    if (!meta) return { hits: [], skipped: [{ slug: q.scope.slug, reason: 'no such project' }], mode: queryEmbedding ? 'hybrid' : 'keyword' }
    targets.push({ slug: meta.slug, name: meta.name })
  }
  const hits: SearchHit[] = []
  for (const t of targets) {
    if (!existsSync(join(deps.home, t.slug, 'project.json'))) { skipped.push({ slug: t.slug, reason: 'project folder missing' }); continue }
    try {
      hits.push(...await searchOne(deps, t.slug, t.name, q.query, queryEmbedding, kinds, limit, q.excludeFilePath))
    } catch (e) {
      skipped.push({ slug: t.slug, reason: `index unreadable: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, limit), skipped, mode: queryEmbedding ? 'hybrid' : 'keyword' }
}
