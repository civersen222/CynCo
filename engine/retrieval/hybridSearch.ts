export type RankedItem = { id: number; score: number }

/**
 * Reciprocal Rank Fusion — merges two ranked lists into one by combining
 * rank-based scores. Items appearing in both lists accumulate scores from both.
 *
 * Score formula per list: 1 / (k + rank), where rank is 1-indexed position.
 *
 * @param listA  First ranked list (descending by score)
 * @param listB  Second ranked list (descending by score)
 * @param k      Smoothing constant (default 60)
 * @param topK   Maximum results to return (default 10)
 */
export function reciprocalRankFusion(
  listA: RankedItem[],
  listB: RankedItem[],
  k: number = 60,
  topK: number = 10,
): RankedItem[] {
  const scores = new Map<number, number>()

  for (let i = 0; i < listA.length; i++) {
    const { id } = listA[i]
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
  }

  for (let i = 0; i < listB.length; i++) {
    const { id } = listB[i]
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
  }

  const fused: RankedItem[] = []
  for (const [id, score] of scores) {
    fused.push({ id, score })
  }

  fused.sort((a, b) => b.score - a.score)

  return fused.slice(0, topK)
}
