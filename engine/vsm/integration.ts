import type { DecisionRecord } from '../decisions/logger.js'

export type VarietyReport = {
  balance: 'balanced' | 'underload' | 'overload'
  toolDistribution: Record<string, number>
  uniqueTools: number
  totalCalls: number
  shannonEntropy: number
}

export function computeVariety(records: DecisionRecord[], windowSize = 20): VarietyReport {
  const recent = records.slice(-windowSize)
  const dist: Record<string, number> = {}
  let total = 0

  for (const r of recent) {
    for (const tool of r.toolsCalled) {
      dist[tool] = (dist[tool] ?? 0) + 1
      total++
    }
  }

  if (total === 0) {
    return { balance: 'underload', toolDistribution: {}, uniqueTools: 0, totalCalls: 0, shannonEntropy: 0 }
  }

  let entropy = 0
  for (const count of Object.values(dist)) {
    const p = count / total
    if (p > 0) entropy -= p * Math.log2(p)
  }

  const uniqueTools = Object.keys(dist).length
  const maxEntropy = uniqueTools > 1 ? Math.log2(uniqueTools) : 1
  const ratio = entropy / maxEntropy

  let balance: VarietyReport['balance']
  if (ratio < 0.3) balance = 'underload'
  else if (ratio > 0.95) balance = 'overload'
  else balance = 'balanced'

  return { balance, toolDistribution: dist, uniqueTools, totalCalls: total, shannonEntropy: entropy }
}
