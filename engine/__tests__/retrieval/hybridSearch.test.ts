import { describe, expect, it } from 'bun:test'
import { reciprocalRankFusion } from '../../retrieval/hybridSearch.js'

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists — doc in both ranks highest', () => {
    // id 2 appears in both lists at rank 1; it should accumulate the most score
    const listA = [
      { id: 1, score: 0.9 },
      { id: 2, score: 0.8 },
      { id: 3, score: 0.7 },
    ]
    const listB = [
      { id: 2, score: 0.95 },
      { id: 4, score: 0.6 },
      { id: 5, score: 0.5 },
    ]

    const result = reciprocalRankFusion(listA, listB)

    // id 2 is rank-1 in both lists → highest fused score
    expect(result[0].id).toBe(2)
    // All unique ids present
    const ids = result.map((r) => r.id)
    expect(ids).toContain(1)
    expect(ids).toContain(3)
    expect(ids).toContain(4)
    expect(ids).toContain(5)
  })

  it('handles two empty rankers — returns empty array', () => {
    const result = reciprocalRankFusion([], [])
    expect(result).toEqual([])
  })

  it('handles one empty ranker — returns items from the non-empty list only', () => {
    const listA = [
      { id: 10, score: 1.0 },
      { id: 20, score: 0.5 },
    ]

    const resultA = reciprocalRankFusion(listA, [])
    expect(resultA.map((r) => r.id)).toEqual([10, 20])

    const resultB = reciprocalRankFusion([], listA)
    expect(resultB.map((r) => r.id)).toEqual([10, 20])
  })

  it('respects topK limit', () => {
    const listA = Array.from({ length: 20 }, (_, i) => ({ id: i, score: 20 - i }))
    const listB = Array.from({ length: 20 }, (_, i) => ({ id: i + 20, score: 20 - i }))

    const result = reciprocalRankFusion(listA, listB, 60, 5)
    expect(result.length).toBe(5)
  })

  it('scores decrease with rank position', () => {
    // With a single list, scores should be strictly decreasing
    const listA = [
      { id: 1, score: 1.0 },
      { id: 2, score: 0.9 },
      { id: 3, score: 0.8 },
    ]

    const result = reciprocalRankFusion(listA, [], 60, 10)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThan(result[i].score)
    }
  })

  it('uses custom k value', () => {
    const listA = [{ id: 1, score: 1.0 }]

    const resultDefault = reciprocalRankFusion(listA, [], 60, 1)
    const resultCustomK = reciprocalRankFusion(listA, [], 10, 1)

    // k=10 → 1/(10+1) ≈ 0.0909; k=60 → 1/(60+1) ≈ 0.0164 — custom k gives higher score
    expect(resultCustomK[0].score).toBeGreaterThan(resultDefault[0].score)
  })
})
