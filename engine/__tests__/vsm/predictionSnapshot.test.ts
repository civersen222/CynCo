import { beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'

describe('GovernanceReport.predictions (P1.2)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
  })

  it('fresh governance reports an empty prediction snapshot', () => {
    const gov = new CyberneticsGovernance()
    const p = gov.getReport().predictions
    expect(p).toEqual({ open: 0, completed: 0, stats: [] })
  })

  it('reflects opened and evaluated predictions with per-hypothesis stats', () => {
    const gov = new CyberneticsGovernance()
    const tracker = gov.getPredictionTracker()
    // H4 opens at consecutiveReadsSameFile >= 3 (checkExtendedTriggers), window 2
    tracker.checkExtendedTriggers(1, {
      contractCreated: false,
      consecutiveReadsSameFile: 3,
      thinkingTokensLastTurn: 0,
      s4ReflectionRan: false,
    })
    expect(gov.getReport().predictions.open).toBe(1)
    expect(gov.getReport().predictions.completed).toBe(0)

    // Window elapsed at turn 3 — evaluate
    tracker.evaluateOpen(3, gov.getReport(), ['Edit'])
    const p = gov.getReport().predictions
    expect(p.open).toBe(0)
    expect(p.completed).toBe(1)
    expect(p.stats.length).toBe(1)
    expect(p.stats[0].hypothesis).toBe('H4')
    expect(p.stats[0].total).toBe(1)
  })
})
