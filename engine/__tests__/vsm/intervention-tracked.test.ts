/**
 * C2 wiring tests — InterventionTracker is fed by CyberneticsGovernance.
 *
 * Closed-loop contract: when a per-turn intervention flag is set (nudge,
 * temperature, contract) or tools are restricted, onTurnComplete records that
 * intervention against the turn's outcome (non-stuck = success). Exposed via
 * getInterventionTracker() for the decision logger.
 */

import { test, expect, describe } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { InterventionTracker } from '../../vsm/interventionTracker.js'

const turn = (overrides: Partial<{
  toolsCalled: number
  thinkingTokens: number
  totalTokens: number
  latencyMs: number
  response: string
  userMessage: string
}> = {}) => ({
  toolsCalled: 0,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 1000,
  response: '',
  userMessage: 'test',
  ...overrides,
})

describe('intervention tracking wiring', () => {
  test('getInterventionTracker returns an InterventionTracker', () => {
    const governance = new CyberneticsGovernance()
    expect(governance.getInterventionTracker()).toBeInstanceOf(InterventionTracker)
  })

  test('nudge intervention is recorded on turn completion', () => {
    const governance = new CyberneticsGovernance()

    governance.markNudgeInjected()
    governance.onTurnComplete(turn())

    const history = governance.getInterventionTracker().getHistory()
    const nudge = history.filter(r => r.type === 'nudge')
    expect(nudge.length).toBe(1)
    // A single fresh turn is not stuck → intervention counted as success.
    expect(nudge[0].success).toBe(true)
  })

  test('temperature intervention is recorded on turn completion', () => {
    const governance = new CyberneticsGovernance()

    governance.markTemperatureLowered()
    governance.onTurnComplete(turn())

    const history = governance.getInterventionTracker().getHistory()
    expect(history.some(r => r.type === 'temperature')).toBe(true)
  })

  test('tool-restriction intervention is recorded while tools are restricted', () => {
    const governance = new CyberneticsGovernance()

    governance.setToolsRestricted(true)
    governance.onTurnComplete(turn())

    const history = governance.getInterventionTracker().getHistory()
    expect(history.some(r => r.type === 'toolRestriction')).toBe(true)
  })

  test('no intervention flag → nothing recorded', () => {
    const governance = new CyberneticsGovernance()

    governance.onTurnComplete(turn())

    expect(governance.getInterventionTracker().getHistory().length).toBe(0)
  })

  test('ablated governance records no interventions', () => {
    process.env._ABLATION_VSM_DISABLED = '1'
    try {
      const governance = new CyberneticsGovernance()
      governance.markNudgeInjected()
      governance.onTurnComplete(turn())
      expect(governance.getInterventionTracker().getHistory().length).toBe(0)
    } finally {
      delete process.env._ABLATION_VSM_DISABLED
    }
  })
})
