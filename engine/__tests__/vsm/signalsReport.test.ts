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

  it('carries explorationState=thrashing after high-variety, error-flat turns', () => {
    const gov = new CyberneticsGovernance()
    globalContract.create('t', 'b', ['a0', 'a1'])
    // 4+ turns, each a distinct (tool,args) fingerprint → variety high; a
    // never-resolving contract holds taskError flat → errorTrend 'flat'.
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 10, '', { file_path: `f${i}.ts` })
      gov.onTurnComplete({ toolsCalled: 1, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    }
    // Deterministic: 2 pending assertions → taskError 1.0 every turn → CUSUM
    // never alarms → errorTrend 'flat'; 5 distinct fingerprints → variety ratio
    // 1.0 ≥ 0.6 at turn 5 ≥ 4 → classifyExploration(5, 5, 'flat') = 'thrashing'.
    expect(gov.getReport().explorationState).toBe('thrashing')
  })

  it('explorationState is null before the 4-turn floor', () => {
    const gov = new CyberneticsGovernance()
    globalContract.create('t', 'b', ['a0'])
    gov.onToolResult('Read', true, 10, '', { file_path: 'f0.ts' })
    gov.onTurnComplete({ toolsCalled: 1, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    expect(gov.getReport().explorationState).toBeNull()
  })

  it('getSessionFidelity is null when no contract was ever active', () => {
    const gov = new CyberneticsGovernance()
    gov.onTurnComplete({ toolsCalled: 0, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    expect(gov.getSessionFidelity()).toBeNull()
  })

  it('getSessionFidelity returns the struct after a contract session, even when ablated', () => {
    process.env._ABLATION_VSM_DISABLED = '1'
    const gov = new CyberneticsGovernance()
    globalContract.create('t', 'b', ['a0'])
    gov.onTurnComplete({ toolsCalled: 0, thinkingTokens: 0, totalTokens: 100, latencyMs: 5, response: 'r', userMessage: 'u' })
    const fid = gov.getSessionFidelity()
    expect(fid).not.toBeNull()
    expect(fid!.hadContract).toBe(true)
  })
})
