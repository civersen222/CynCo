import { BM25Index } from '../retrieval/bm25Index.js'
import { reciprocalRankFusion, type RankedItem } from '../retrieval/hybridSearch.js'
import type { IndexResult } from './types.js'

const keyOf = (r: IndexResult): string => `${r.filePath}:${r.startLine}:${r.endLine}`

/**
 * Fuse vector and lexical retrieval results via BM25 + Reciprocal Rank Fusion.
 *
 * `vectorResults` must already be ordered best-first (the vector store returns
 * them that way). RRF combines the two rankings by position, so the raw score
 * scales of the two retrievers don't need to be comparable.
 */
export function hybridRank(
  vectorResults: IndexResult[],
  keywordResults: IndexResult[],
  query: string,
  topK: number,
): IndexResult[] {
  // Assign a stable integer id to each unique candidate chunk (RRF/BM25 key on numbers).
  const byId = new Map<number, IndexResult>()
  const idByKey = new Map<string, number>()
  let nextId = 0
  const idFor = (r: IndexResult): number => {
    const k = keyOf(r)
    let id = idByKey.get(k)
    if (id === undefined) {
      id = nextId++
      idByKey.set(k, id)
      byId.set(id, r)
    }
    return id
  }

  // Vector ranking — preserve the order the store returned.
  const vectorRanked: RankedItem[] = vectorResults.map(r => ({ id: idFor(r), score: r.score }))

  // Lexical ranking — BM25 over the union of both candidate sets.
  const bm25 = new BM25Index()
  for (const r of [...vectorResults, ...keywordResults]) {
    bm25.add(idFor(r), `${r.name ?? ''} ${r.content}`)
  }
  const lexicalRanked: RankedItem[] = bm25
    .search(query, Math.max(topK * 4, 20))
    .map(x => ({ id: x.docId, score: x.score }))

  const fused = reciprocalRankFusion(vectorRanked, lexicalRanked, 60, topK)
  return fused
    .map(f => byId.get(f.id))
    .filter((r): r is IndexResult => r !== undefined)
}
