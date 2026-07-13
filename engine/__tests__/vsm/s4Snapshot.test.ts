import { beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'

describe('GovernanceReport.s4 (P1.3)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
  })

  it('fresh governance reports an empty s4 snapshot', () => {
    const gov = new CyberneticsGovernance()
    expect(gov.getReport().s4).toEqual({
      scores: null,
      composite: null,
      reflectionCount: 0,
      taskType: 'simple_query',
      taskComplexity: 1,
    })
  })

  it('reflects recorded reflection scores and composite', () => {
    const gov = new CyberneticsGovernance()
    gov.getReflector().recordScores({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })
    const s4 = gov.getReport().s4
    expect(s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })
    expect(s4.composite).toBeCloseTo(7.25) // (7+6+8+(10-2))/4
    expect(s4.reflectionCount).toBe(1)
  })

  it('reflects per-turn task classification (type AND complexity)', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete({
      toolsCalled: 1,
      thinkingTokens: 0,
      totalTokens: 100,
      latencyMs: 500,
      response: 'a sufficiently long response so no summary-related machinery misfires here.',
      userMessage: 'refactor the system architecture of the payment module',
    })
    const s4 = gov.getReport().s4
    expect(s4.taskType).toBe('architectural')
    expect(s4.taskComplexity).toBe(8)
  })
})
