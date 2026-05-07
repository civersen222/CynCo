import { describe, it, expect } from 'bun:test'

describe('Outcome evaluation', () => {
  it('tool restriction positive when stuck decreased', () => {
    const before = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const after = { stuckTurns: 2, toolSuccessRate: 0.6 }
    const outcome = evaluateOutcome(before, after)
    expect(outcome).toBe('positive')
  })

  it('tool restriction negative when stuck unchanged', () => {
    const before = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const after = { stuckTurns: 5, toolSuccessRate: 0.3 }
    const outcome = evaluateOutcome(before, after)
    expect(outcome).toBe('negative')
  })

  it('compaction positive when success rate improved', () => {
    const before = { stuckTurns: 3, toolSuccessRate: 0.4 }
    const after = { stuckTurns: 1, toolSuccessRate: 0.7 }
    const outcome = evaluateOutcome(before, after)
    expect(outcome).toBe('positive')
  })

  it('user dismiss is always dismissed', () => {
    expect(evaluateDismissal()).toBe('dismissed')
  })
})

// Helper functions to test — these will be exported from orchestrator or a utility
function evaluateOutcome(
  before: { stuckTurns: number; toolSuccessRate: number },
  after: { stuckTurns: number; toolSuccessRate: number },
): 'positive' | 'negative' {
  if (after.stuckTurns < before.stuckTurns) return 'positive'
  if (after.toolSuccessRate > before.toolSuccessRate + 0.1) return 'positive'
  return 'negative'
}

function evaluateDismissal(): 'dismissed' {
  return 'dismissed'
}
