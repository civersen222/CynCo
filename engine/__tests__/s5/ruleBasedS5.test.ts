import { describe, expect, it } from 'bun:test'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

function makeInput(overrides: Partial<S5Input> = {}): S5Input {
  return {
    userMessage: 'help me fix this bug',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.5,
    recentToolResults: [],
    governanceStatus: 'healthy',
    s3s4Balance: 'balanced',
    modelLatencyTrend: 'stable',
    availableModels: ['qwen3:8b'],
    turnCount: 5,
    ...overrides,
  }
}

describe('RuleBasedS5', () => {
  it('has correct type shape — name and decide()', () => {
    const s5 = new RuleBasedS5()
    expect(s5.name).toBe('RuleBasedS5')
    expect(typeof s5.decide).toBe('function')
  })

  it('returns no-op for healthy nominal state', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput())
    expect(decision.contextAction).toBe('none')
    expect(decision.tools).toBeNull()
    expect(decision.priority).toBe('balanced')
    expect(decision.reasoning).toBeTruthy()
  })

  it('recommends compact at 85% context usage', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ contextUsagePercent: 0.85 }))
    expect(decision.contextAction).toBe('compact')
  })

  it('warns at 95% context usage', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ contextUsagePercent: 0.95 }))
    expect(decision.contextAction).toBe('warn')
  })

  it('boosts S3 priority when S4 is dominant', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ s3s4Balance: 's4_dominant' }))
    expect(decision.priority).toBe('s3')
  })

  it('boosts S4 priority when S3 is dominant', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ s3s4Balance: 's3_dominant' }))
    expect(decision.priority).toBe('s4')
  })

  it('does NOT restrict tools when governance is critical', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ governanceStatus: 'critical' }))
    // Critical governance injects system prompt signals but does NOT strip tools.
    // The model needs all tools to recover from critical states.
    expect(decision.tools).toBeNull()
  })

  it('restricts tools to Read-only when governance is halted', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({ governanceStatus: 'halted' }))
    expect(decision.tools).toEqual(['Read'])
  })

  it('restricts Bash on 3+ recent tool failures', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({
      recentToolResults: [
        { tool: 'Bash', success: false },
        { tool: 'Bash', success: false },
        { tool: 'Bash', success: false },
      ],
    }))
    expect(decision.tools).not.toBeNull()
    expect(decision.tools).not.toContain('Bash')
  })

  it('recommends revert when critical + stuck + snapshot available', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({
      governanceStatus: 'critical',
      snapshotAvailable: true,
      governance: {
        status: 'critical', varietyBalance: 'balanced', s3s4Balance: 'balanced',
        stuckTurns: 6, toolSuccessRate: 0.5, algedonicAlerts: 0,
      },
    }))
    expect(decision.revert).toBe(true)
  })

  it('does NOT recommend revert when snapshot unavailable', async () => {
    const s5 = new RuleBasedS5()
    const decision = await s5.decide(makeInput({
      governanceStatus: 'critical',
      snapshotAvailable: false,
      governance: {
        status: 'critical', varietyBalance: 'balanced', s3s4Balance: 'balanced',
        stuckTurns: 6, toolSuccessRate: 0.5, algedonicAlerts: 0,
      },
    }))
    expect(decision.revert).toBeFalsy()
  })

  it('always provides a non-empty reasoning string', async () => {
    const s5 = new RuleBasedS5()
    const cases: Partial<S5Input>[] = [
      {},
      { contextUsagePercent: 0.95 },
      { governanceStatus: 'critical' },
      { governanceStatus: 'halted' },
      { s3s4Balance: 's4_dominant' },
      { recentToolResults: [{ tool: 'Bash', success: false }, { tool: 'Bash', success: false }, { tool: 'Bash', success: false }] },
    ]
    for (const override of cases) {
      const decision = await s5.decide(makeInput(override))
      expect(decision.reasoning.length).toBeGreaterThan(0)
    }
  })
})
