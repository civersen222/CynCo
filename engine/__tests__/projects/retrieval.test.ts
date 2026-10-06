import { describe, it, expect } from 'bun:test'
import { buildRetrievalBlock, citationsUsed, retrievalShare, RETRIEVAL_TAG, MAX_PASSAGES } from '../../projects/retrieval.js'
import type { SearchHit } from '../../projects/search.js'

const hit = (n: number, words = 50): SearchHit => ({ slug: 'p', projectName: 'P', filePath: `knowledge/f${n}.md`, kind: 'knowledge', heading: `H${n}`, ordinal: n, passage: Array.from({ length: words }, (_, i) => `w${n}_${i}`).join(' '), score: 1 / n })

describe('retrievalShare', () => {
  it('defaults to 0.15 and clamps', () => {
    expect(retrievalShare({})).toBe(0.15)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: '0.3' })).toBe(0.3)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: '9' })).toBe(0.5)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: 'x' })).toBe(0.15)
  })
})

describe('buildRetrievalBlock', () => {
  it('numbers passages, cites file › heading (ordinal) and stops at the budget', () => {
    const b = buildRetrievalBlock([hit(1), hit(2), hit(3)], 1000)
    if (!b) throw new Error('expected a block')
    expect(b.text.startsWith(RETRIEVAL_TAG)).toBe(true)
    expect(b.text).toContain('[1] knowledge/f1.md › H1 (1)')
    expect(b.citations).toEqual([
      { n: 1, filePath: 'knowledge/f1.md', heading: 'H1', ordinal: 1 },
      { n: 2, filePath: 'knowledge/f2.md', heading: 'H2', ordinal: 2 },
      { n: 3, filePath: 'knowledge/f3.md', heading: 'H3', ordinal: 3 },
    ])
    const tight = buildRetrievalBlock([hit(1, 300), hit(2, 300), hit(3, 300)], 500)
    if (!tight) throw new Error('expected a block')
    expect(tight.citations.length).toBe(1)
  })
  it('caps at MAX_PASSAGES and returns null for no hits', () => {
    expect(MAX_PASSAGES).toBe(8)
    const many = buildRetrievalBlock(Array.from({ length: 12 }, (_, i) => hit(i + 1, 5)), 100_000)
    expect(many?.citations).toHaveLength(8)
    expect(buildRetrievalBlock([], 1000)).toBeNull()
  })
})

describe('citationsUsed', () => {
  it('returns the citations whose [n] appears in the reply, in order, once each', () => {
    const cits = buildRetrievalBlock([hit(1), hit(2), hit(3)], 10_000)!.citations
    expect(citationsUsed('Use epoxy [2]. Sand first [1] and again [2].', cits).map(c => c.n)).toEqual([2, 1])
    expect(citationsUsed('no citations here', cits)).toEqual([])
  })
})
