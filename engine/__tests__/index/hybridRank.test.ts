import { describe, expect, it } from 'bun:test'
import { hybridRank } from '../../index/hybridRank.js'
import type { IndexResult } from '../../index/types.js'

function chunk(file: string, content: string, score: number): IndexResult {
  return {
    filePath: file,
    name: null,
    chunkType: 'function',
    startLine: 1,
    endLine: 10,
    content,
    score,
  }
}

describe('hybridRank', () => {
  it('promotes an exact-keyword chunk via the lexical signal even when its vector score is weak', () => {
    const keywordChunk = chunk('b.ts', 'function frobnicateWidget() { return 42 }', 0.1)
    const vectorChunk = chunk('a.ts', 'some unrelated helper code here', 0.9)

    // Vector retriever ranks the unrelated chunk first; the keyword chunk is last.
    const vectorResults = [vectorChunk, keywordChunk]
    // Lexical retriever surfaces only the chunk containing the rare token.
    const keywordResults = [keywordChunk]

    const fused = hybridRank(vectorResults, keywordResults, 'frobnicateWidget', 5)

    expect(fused[0].filePath).toBe('b.ts')
  })

  it('returns vector results unchanged when there is no lexical overlap', () => {
    const a = chunk('a.ts', 'alpha content', 0.9)
    const b = chunk('b.ts', 'beta content', 0.5)
    const fused = hybridRank([a, b], [], 'zzznomatch', 5)
    expect(fused.map(r => r.filePath)).toEqual(['a.ts', 'b.ts'])
  })

  it('respects topK', () => {
    const results = [
      chunk('a.ts', 'one', 0.9),
      chunk('b.ts', 'two', 0.8),
      chunk('c.ts', 'three', 0.7),
    ]
    const fused = hybridRank(results, [], 'anything', 2)
    expect(fused.length).toBe(2)
  })
})
