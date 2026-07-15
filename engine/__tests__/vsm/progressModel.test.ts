import { describe, it, expect } from 'vitest'
import { ProgressModel } from '../../vsm/progressModel.js'
import type { ContractSnapshot } from '../../tools/contract.js'

function snap(passed: number, total: number, title = 't', active = true): ContractSnapshot {
  return {
    title,
    brief: '',
    active,
    complete: passed === total,
    assertions: Array.from({ length: total }, (_, i) => ({
      text: `a${i}`,
      status: i < passed ? ('passed' as const) : ('pending' as const),
    })),
  }
}

describe('ProgressModel (P4.3)', () => {
  it('null without an active contract', () => {
    let s = snap(0, 0, 't', false)
    const m = new ProgressModel(() => s)
    m.onTurnComplete(2000)
    expect(m.snapshot().progressRate).toBeNull()
  })

  it('newly-passed assertions per 1k tokens', () => {
    let s = snap(0, 4)
    const m = new ProgressModel(() => s)
    m.onTurnComplete(1000) // baseline turn: 0 passed
    s = snap(2, 4)
    m.onTurnComplete(4000) // +2 passed over 4000 tokens
    expect(m.snapshot().progressRate).toBe(0.5)
  })

  it('no new passes → 0 (contract active, tokens spent)', () => {
    let s = snap(1, 4)
    const m = new ProgressModel(() => s)
    m.onTurnComplete(1000)
    m.onTurnComplete(1000)
    expect(m.snapshot().progressRate).toBe(0)
  })

  it('contract replacement (passed drop) resets the baseline', () => {
    let s = snap(3, 4)
    const m = new ProgressModel(() => s)
    m.onTurnComplete(1000)
    s = snap(1, 5, 'new task') // replaced contract: fewer passed
    m.onTurnComplete(1000)
    // Baseline reset: this turn's 1 passed counts as fresh progress
    expect(m.snapshot().progressRate).toBe(1.0)
  })

  it('zero tokens → null', () => {
    let s = snap(1, 4)
    const m = new ProgressModel(() => s)
    m.onTurnComplete(0)
    expect(m.snapshot().progressRate).toBeNull()
  })
})
