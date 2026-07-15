// P4.3/4(e): RegulatorFidelityTracker — did the contract predict the work?
// Session-scoped, measurement only. resolutionRate = (passed+failed)/countable
// of the FINAL contract; contractReplacements counts title rollovers.
import { describe, expect, it } from 'vitest'
import { RegulatorFidelityTracker } from '../../vsm/regulatorFidelity.js'
import type { ContractSnapshot } from '../../tools/contract.js'

function snap(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return { title: '', brief: '', active: false, complete: false, assertions: [], ...over }
}
const A = (status: 'pending' | 'passed' | 'failed' | 'skipped') => ({ text: 't', status })

describe('RegulatorFidelityTracker', () => {
  it('returns null when a contract was never active', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: false }))
    expect(t.getFidelity(null)).toBeNull()
  })

  it('all-passed contract → resolutionRate 1.0, hadContract true', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed'), A('passed')] }))
    const f = t.getFidelity(0)
    expect(f).not.toBeNull()
    expect(f!.hadContract).toBe(true)
    expect(f!.resolutionRate).toBe(1.0)
    expect(f!.finalTaskError).toBe(0)
    expect(f!.contractReplacements).toBe(0)
  })

  it('mixed passed/failed/pending → (passed+failed)/countable', () => {
    const t = new RegulatorFidelityTracker()
    // 2 passed + 1 failed + 1 pending; countable = 4 (none skipped) → 3/4 = 0.75
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed'), A('passed'), A('failed'), A('pending')] }))
    expect(t.getFidelity(0.25)!.resolutionRate).toBe(0.75)
  })

  it('skipped excluded from the denominator', () => {
    const t = new RegulatorFidelityTracker()
    // 1 passed + 1 skipped; countable = total - skipped = 1 → 1/1 = 1.0
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed'), A('skipped')] }))
    expect(t.getFidelity(0)!.resolutionRate).toBe(1.0)
  })

  it('resolutionRate null when countable is 0 (all skipped)', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: true, title: 'X', assertions: [A('skipped'), A('skipped')] }))
    expect(t.getFidelity(null)!.resolutionRate).toBeNull()
  })

  it('title change bumps contractReplacements once', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: true, title: 'X', assertions: [A('pending')] }))
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed')] })) // same title, no bump
    t.observe(snap({ active: true, title: 'Y', assertions: [A('pending')] })) // new title → +1
    expect(t.getFidelity(0)!.contractReplacements).toBe(1)
  })

  it('inactive→active-new-title counts one replacement', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed')] }))
    t.observe(snap({ active: false }))                                   // rollover gap
    t.observe(snap({ active: true, title: 'Z', assertions: [A('pending')] })) // new title → +1
    expect(t.getFidelity(0)!.contractReplacements).toBe(1)
  })

  it('finalTaskError is passed through, never re-read from the contract', () => {
    const t = new RegulatorFidelityTracker()
    t.observe(snap({ active: true, title: 'X', assertions: [A('passed')] }))
    expect(t.getFidelity(0.42)!.finalTaskError).toBe(0.42)
  })
})
