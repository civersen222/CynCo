// engine/__tests__/vsm/heterarchySnapshot.test.ts
// P1.6: GovernanceReport carries the per-turn heterarchy state — context
// classification, commander, and whether command shifted this turn. The
// classification itself pre-existed (cyberneticsGovernance.ts:428, wired all
// along); this closes the effect arc: nothing was persisted before.
import { beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'

const turnMetrics = (toolsCalled: number) => ({
  toolsCalled,
  thinkingTokens: 0,
  totalTokens: 100,
  latencyMs: 500,
  response: 'a sufficiently long response so no summary machinery misfires here.',
})

describe('GovernanceReport.heterarchy (P1.6)', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
  })

  it('fresh governance reports the S3-normal defaults, unshifted', () => {
    const gov = new CyberneticsGovernance()
    expect(gov.getReport().heterarchy).toEqual({
      context: 'normal',
      commander: 'S3',
      shifted: false,
    })
  })

  it('early turns classify as exploration → S4 commands, shift recorded once', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete(turnMetrics(1)) // turnCount=1 ≤ 2 → exploration → S4
    expect(gov.getReport().heterarchy).toEqual({
      context: 'exploration',
      commander: 'S4',
      shifted: true, // S3 → S4
    })
    gov.onTurnComplete(turnMetrics(1)) // turnCount=2 ≤ 2 → exploration again
    expect(gov.getReport().heterarchy.shifted).toBe(false) // S4 → S4
  })

  it('heavy tool use past the opening turns classifies as routine → S1 commands', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete(turnMetrics(1)) // turn 1: exploration
    gov.onTurnComplete(turnMetrics(1)) // turn 2: exploration
    gov.onTurnComplete(turnMetrics(5)) // turn 3: >3 tools → routine → S1
    expect(gov.getReport().heterarchy).toEqual({
      context: 'routine',
      commander: 'S1',
      shifted: true, // S4 → S1
    })
  })
})
