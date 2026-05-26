import { describe, it, expect } from 'vitest'
import { PredictionTracker, wilsonScore } from '../vsm/predictionTracker.js'
import type { GovernanceReport } from '../vsm/types.js'

describe('PredictionTracker', () => {
  const makeReport = (overrides: Partial<GovernanceReport> = {}): GovernanceReport => ({
    status: 'healthy',
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    s3s4Balance: 'balanced',
    algedonicAlerts: 0,
    stuckTurns: 0,
    consecutiveUnstable: 0,
    modelLatencyTrend: 'stable',
    toolSuccessRate: 0.8,
    agreementRatio: 0.9,
    observerDivergence: null,
    axiomHealth: { holding: 4, total: 4, violations: [] },
    ...overrides,
  })

  it('records H1 when variety is critical/overload', () => {
    const tracker = new PredictionTracker('test')
    tracker.checkTriggers(5, makeReport({ varietyBalance: 'overload' }), [])
    expect(tracker.openPredictions.length).toBe(1)
    expect(tracker.openPredictions[0].hypothesis).toBe('H1')
  })

  it('does not duplicate predictions in same window', () => {
    const tracker = new PredictionTracker('test')
    tracker.checkTriggers(5, makeReport({ varietyBalance: 'overload' }), [])
    tracker.checkTriggers(6, makeReport({ varietyBalance: 'overload' }), [])
    expect(tracker.openPredictions.length).toBe(1)
  })

  it('evaluates H1 after window', () => {
    const tracker = new PredictionTracker('test')
    tracker.checkTriggers(5, makeReport({ varietyBalance: 'overload' }), [])
    const failResults = [
      { tool: 'Edit', success: false },
      { tool: 'Bash', success: false },
      { tool: 'Write', success: false },
    ]
    tracker.evaluateOpen(8, makeReport(), failResults)
    expect(tracker.openPredictions.length).toBe(0)
    expect(tracker.completedPredictions.length).toBe(1)
    expect(tracker.completedPredictions[0].correct).toBe(true)
  })

  it('records H2 for S3/S4 imbalance', () => {
    const tracker = new PredictionTracker('test')
    tracker.checkTriggers(5, makeReport({ s3s4Balance: 's3_dominant' }), [])
    expect(tracker.openPredictions.some(p => p.hypothesis === 'H2')).toBe(true)
  })
})

describe('wilsonScore', () => {
  it('returns CI for 70% with 100 samples', () => {
    const [lo, hi] = wilsonScore(70, 100, 0.05)
    expect(lo).toBeGreaterThan(0.5)
    expect(hi).toBeLessThan(0.85)
  })

  it('returns [0, 1] for 0 samples', () => {
    const [lo, hi] = wilsonScore(0, 0, 0.05)
    expect(lo).toBe(0)
    expect(hi).toBe(1)
  })
})
