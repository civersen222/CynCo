import { describe, expect, it, beforeEach } from 'bun:test'
import { FeedbackControlIntegration } from '../../vsm/feedbackControl.js'

describe('FeedbackControlIntegration', () => {
  let fc: FeedbackControlIntegration

  beforeEach(() => {
    fc = new FeedbackControlIntegration()
  })

  it('recommends compression when context > 80%', () => {
    const actions = fc.update(0.85, 0.1, 1.0, 0.9)
    expect(actions.shouldCompress).toBe(true)
    expect(actions.compressionUrgency).toBeGreaterThan(0)
  })

  it('does not recommend compression when context < 70%', () => {
    const actions = fc.update(0.3, 0.1, 1.0, 0.9)
    expect(actions.shouldCompress).toBe(false)
  })

  it('PID adjusts approval when rate is too low', () => {
    // Approval rate = 50% (target is 80%) → should ease restrictions
    const actions = fc.update(0.5, 0.1, 1.0, 0.5)
    expect(actions.approvalAdjustment).toBeGreaterThan(0) // positive = ease
  })

  it('PID tightens when approval rate is too high but failures are high', () => {
    // Approval rate = 100% but we feed that through → PID should tighten
    const actions = fc.update(0.5, 0.1, 1.0, 1.0)
    expect(actions.approvalAdjustment).toBeLessThan(0) // negative = tighten
  })

  it('detects viability violation and records the adaptation step in the trace', () => {
    // Context at 90% (above 85% bound) → not viable; the legacy continuous
    // instance steps on every out-of-bounds observation, and the trace is
    // the only surviving record of it (perturbedParameters had no reader).
    const actions = fc.update(0.9, 0.0, 1.0, 0.8)
    expect(actions.isViable).toBe(false)
    expect(actions.viabilityMargin).toBeLessThan(0)
    expect(actions.adaptationTrace.length).toBeGreaterThan(0)
  })

  it('system is viable with normal metrics', () => {
    const actions = fc.update(0.5, 0.1, 1.0, 0.8)
    expect(actions.isViable).toBe(true)
    expect(actions.adaptationTrace.length).toBe(0)
  })

  it('checkModelFidelity returns 1.0 for identical distributions', () => {
    const dist = [0.5, 0.3, 0.2]
    expect(fc.checkModelFidelity(dist, dist)).toBeCloseTo(1.0, 5)
  })

  it('isGoodRegulator returns true for high-fidelity model', () => {
    const system = [0.5, 0.3, 0.2]
    expect(fc.isGoodRegulator(system, system)).toBe(true)
  })

  it('isGoodRegulator returns false for divergent model', () => {
    const system = [0.5, 0.3, 0.2]
    const model = [0.1, 0.1, 0.8]
    expect(fc.isGoodRegulator(system, model, 0.95)).toBe(false)
  })

  it('exposes the ultrastable adaptation trace and margin', () => {
    const before = fc.update(0.5, 0.1, 1.0, 0.9)
    expect(before.adaptationTrace.length).toBe(0)
    expect(before.viabilityMargin).toBeGreaterThan(0)
    const after = fc.update(0.95, 0.1, 1.0, 0.9) // context above the 0.85 bound
    expect(after.adaptationTrace.length).toBe(1)
    expect(after.adaptationTrace[0].violations).toEqual(['ev0'])
    expect(after.adaptationTrace[0].restoredAfter).toBeNull()
    expect(after.viabilityMargin).toBeLessThan(0)
  })
})
