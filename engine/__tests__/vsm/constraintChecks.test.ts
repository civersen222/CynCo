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

  it('POSIWID report is Consistent when tool-class shares match the purpose model', () => {
    cc.setPurposeModel([['sourceEdit', 0.15], ['commit', 0.05], ['inspect', 0.8]])
    const r = cc.checkPurposeAlignment({ counts: [['sourceEdit', 150], ['commit', 50], ['inspect', 800]] })
    expect(r.verdict).toBe('Consistent')
    expect(r.dominantObserved).toBe('inspect')
  })

  it('POSIWID report is Contradicted and emits a drift event when the dominant behaviour has no stated share', () => {
    cc.setPurposeModel([['sourceEdit', 0.15], ['commit', 0.05], ['inspect', 0.8]])
    const r = cc.checkPurposeAlignment({ counts: [['revert', 600], ['inspect', 300], ['sourceEdit', 100]] })
    expect(r.verdict).toBe('Contradicted')
    const bus = getEventBus()
    const drifts = bus.replayFiltered(e => e.payload.kind === 'DriftDetected' && e.payload.metricName === 'posiwid')
    expect(drifts.length).toBeGreaterThan(0)
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

  // The live reading conversationLoop emits on governance.status: raw
  // `classifyCall` classes folded into the default purpose model.
  it('checkToolClassAlignment folds read-shaped Bash and CodeIndex into inspect', () => {
    const r = cc.checkToolClassAlignment(new Map([['inspect', 30], ['read', 20], ['codeIndex', 5], ['sourceEdit', 15], ['run', 20], ['commit', 5], ['write', 5]]))
    expect(r.dominantObserved).toBe('inspect')
    expect(r.verdict).toBe('Consistent')
    expect(r.support).toBe(100)
  })

  it('checkToolClassAlignment reads Contradicted when reverts dominate (a class the model gives no weight)', () => {
    const r = cc.checkToolClassAlignment({ revert: 60, inspect: 30, sourceEdit: 10 })
    expect(r.verdict).toBe('Contradicted')
    expect(r.dominantObserved).toBe('revert')
  })

  it('checkToolClassAlignment reads Drifting for the C8 wave-1 shape (828 of 931 inspect)', () => {
    const r = cc.checkToolClassAlignment({ inspect: 828, sourceEdit: 86, write: 17 })
    expect(r.verdict).toBe('Drifting')
    expect(r.dominantObserved).toBe('inspect')
  })

  it('checkToolClassAlignment is Insufficient under the 50-call support floor', () => {
    expect(cc.checkToolClassAlignment({ inspect: 10 }).verdict).toBe('Insufficient')
  })
})
