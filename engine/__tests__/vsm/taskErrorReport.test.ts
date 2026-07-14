// P4.1: GovernanceReport carries taskError + errorTrend, sealed per turn from
// the REAL globalContract. Must survive ablation — measurement organ, not
// authority organ (Phase 3 needs the series from ablated runs too). Pattern
// copied from varietyWindowedReport.test.ts (P1.5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

const TURN = {
  toolsCalled: 1,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 500,
  response: 'a sufficiently long response so no summary machinery misfires.',
}

describe('GovernanceReport.taskError/errorTrend (P4.1)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    globalContract.clear()
  })
  afterEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    globalContract.clear()
  })

  it('no contract → null; live contract → unmet fraction that falls as assertions pass', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBeNull()
    expect(gov.getReport().errorTrend).toBeNull()

    globalContract.create('demo', 'brief', ['a1', 'a2'])
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
    expect(gov.getReport().errorTrend).toBe('flat') // first observation seeds the EMA

    globalContract.assertPass(0, 'done')
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(0.5)
  })

  it('still measures when ablated (_ABLATION_VSM_DISABLED=1)', () => {
    process.env._ABLATION_VSM_DISABLED = '1'
    const gov = new CyberneticsGovernance()
    globalContract.create('demo', 'brief', ['a1'])
    // Ablated onTurnComplete returns early — but only AFTER the seal.
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
  })

  it('report values are per-turn sealed, not live reads', () => {
    const gov = new CyberneticsGovernance()
    globalContract.create('demo', 'brief', ['a1'])
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(1)
    // Contract state changes mid-turn — report must not move until next seal.
    globalContract.assertPass(0)
    expect(gov.getReport().taskError).toBe(1)
    gov.onTurnComplete(TURN)
    expect(gov.getReport().taskError).toBe(0)
  })
})
