import { describe, it, expect } from 'bun:test'
import { ALL_RULES } from '../../s5/ruleBasedS5.js'

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    turnCount: 20,
    contextUsagePercent: 0.5,
    modelLatencyTrend: 'stable',
    s3s4Balance: 'balanced',
    varietyBalance: 'balanced',
    homeostatStable: true,
    homeostatConsecutiveUnstable: 0,
    driftDetected: false,
    driftDirection: null,
    performanceHealth: 'healthy',
    productivityRatio: 0.8,
    recommendedToolMode: null,
    heterarchyAuthority: null,
    agreementRatio: 1.0,
    observerDivergence: null,
    demotedTools: [],
    recentToolResults: [],
    availableModels: ['qwen3:8b'],
    governance: { stuckTurns: 0, toolSuccessRate: 1.0, recentToolNames: [] },
    ...overrides,
  }
}

describe('C7: stuck loop — restrict to unused tools', () => {
  const C7 = ALL_RULES.find(r => r.id === 'C7')!

  it('exists and is critical tier', () => {
    expect(C7).toBeDefined()
    expect(C7.tier).toBe('critical')
  })

  it('fires when stuckTurns >= 5 with 100% tool success', () => {
    const result = C7.evaluate(makeInput({
      governance: {
        stuckTurns: 7,
        toolSuccessRate: 1.0,
        recentToolNames: ['Read', 'Read', 'Read', 'Read', 'Read'],
      },
    }) as any)
    expect(result).not.toBeNull()
    expect(result!.tools).toBeDefined()
    expect(result!.tools).toContain('Edit')
    expect(result!.tools).toContain('Write')
    expect(result!.tools).toContain('Bash')
  })

  it('does not fire when stuckTurns < 5', () => {
    const result = C7.evaluate(makeInput({
      governance: { stuckTurns: 3, toolSuccessRate: 1.0, recentToolNames: ['Read'] },
    }) as any)
    expect(result).toBeNull()
  })
})

describe('W3: fires on stuck alone', () => {
  const W3 = ALL_RULES.find(r => r.id === 'W3')!

  it('fires when stuckTurns >= 5 even with 100% tool success', () => {
    const result = W3.evaluate(makeInput({
      governance: { stuckTurns: 7, toolSuccessRate: 1.0, recentToolNames: [] },
    }) as any)
    expect(result).not.toBeNull()
    expect(result!.revert).toBe(true)
  })

  it('does not fire when stuckTurns < 5', () => {
    const result = W3.evaluate(makeInput({
      governance: { stuckTurns: 2, toolSuccessRate: 0.3, recentToolNames: [] },
    }) as any)
    expect(result).toBeNull()
  })
})
