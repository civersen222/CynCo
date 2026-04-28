import { describe, expect, it, beforeEach } from 'bun:test'
import { ConstraintChecksIntegration } from '../../vsm/constraintChecks.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId, TrendDirection } from '../../cybernetics-core/src/index.js'
import { BeerViolationError } from '../../cybernetics-core/src/constraints/index.js'

describe('ConstraintChecksIntegration', () => {
  let cc: ConstraintChecksIntegration

  beforeEach(() => {
    resetEventBus()
    cc = new ConstraintChecksIntegration(new NodeId())
  })

  it('checkAutonomy returns null when all constraints satisfied', () => {
    expect(cc.checkAutonomy(true, true, true)).toBeNull()
  })

  it('checkAutonomy returns violations when constraints broken', () => {
    const violations = cc.checkAutonomy(false, true, true)
    expect(violations).not.toBeNull()
    expect(violations!.length).toBe(1)
  })

  it('autonomy violation emits domain event', () => {
    cc.checkAutonomy(false, false, true)
    const bus = getEventBus()
    const events = bus.replayFiltered(e => e.payload.kind === 'AutonomyViolation')
    expect(events.length).toBe(2) // two violations
  })

  it('POSIWID check passes when outputs match purpose', () => {
    const outputs = ['I helped fix the coding bug', 'Refactored the function']
    expect(cc.checkPurposeAlignment(outputs)).toBe(true)
  })

  it('POSIWID check fails when outputs diverge from purpose', () => {
    const outputs = ['recipe for chocolate cake', 'weather forecast for tokyo']
    expect(cc.checkPurposeAlignment(outputs)).toBe(false)
  })

  it('freedom is viable in normal range', () => {
    const { freedom, viable } = cc.calculateFreedom(15, 5) // 10/15 = 0.67
    expect(freedom.freedomRatio).toBeGreaterThan(0.2)
    expect(freedom.freedomRatio).toBeLessThanOrEqual(0.8)
    expect(viable).toBe(true)
  })

  it('freedom is not viable when over-constrained', () => {
    const { viable } = cc.calculateFreedom(15, 14) // only 1 tool allowed
    expect(viable).toBe(false) // freedom ratio ~0.07
  })

  it('freedom is not viable when under-constrained', () => {
    const { viable } = cc.calculateFreedom(15, 0) // all tools allowed
    expect(viable).toBe(false) // freedom ratio = 1.0 > 0.8
  })

  it('S4 Trend validates observation language', () => {
    const trend = cc.validateS4Trend('tools', TrendDirection.Rising, 0.5, 'Tool failure rate is increasing')
    expect(trend.direction).toBe(TrendDirection.Rising)
  })

  it('S4 Trend rejects recommendation language', () => {
    expect(() => {
      cc.validateS4Trend('tools', TrendDirection.Rising, 0.5, 'We should use fewer tools')
    }).toThrow(BeerViolationError)
  })
})
