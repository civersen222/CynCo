// P4.3: GovernanceReport carries fingerprintAlarm + infoGain + progressRate,
// recorded in the always-track zone and sealed per turn. Measurement only —
// no authority. Setup mirrors taskErrorReport.test.ts (P4.1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

describe('GovernanceReport P4.3 signals', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    globalContract.clear()
  })
  afterEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    globalContract.clear()
  })

  it('carries fingerprintAlarm after 3 identical tool calls', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 3; i++) {
      gov.onToolResult('Read', true, 10, '', { file_path: 'a.ts' })
    }
    expect(gov.getReport().fingerprintAlarm).toBe('identical')
  })

  it('carries infoGain after a turn touching a new file', () => {
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 10, '', { file_path: 'src/new.ts' })
    gov.onTurnComplete({ toolsCalled: 1, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    expect(gov.getReport().infoGain).toBe(1.0)
  })

  it('progressRate is null with no active contract', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete({ toolsCalled: 0, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    expect(gov.getReport().progressRate).toBeNull()
  })
})
