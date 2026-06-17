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
    promptDifficulty: 'unknown',
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

  // Real incident (2026-06-12 morning-brief): C7 hardcoded coding tools in a
  // read-only mission run whose pinned set was [Mfl, WebSearch, WebFetch, Read]
  // — the intersection left ZERO tools and the run halted at stuck 15.
  it('restricts to available-but-unused tools when activeToolNames is provided', () => {
    const result = C7.evaluate(makeInput({
      governance: {
        stuckTurns: 6,
        toolSuccessRate: 1.0,
        recentToolNames: ['Mfl', 'Mfl', 'Mfl', 'Mfl', 'Mfl'],
        activeToolNames: ['Mfl', 'WebSearch', 'WebFetch', 'Read'],
      },
    }) as any)
    expect(result).not.toBeNull()
    expect(result!.tools).toEqual(['WebSearch', 'WebFetch', 'Read'])
  })

  it('coding session: excludes the spammed read tools, keeps action tools', () => {
    const result = C7.evaluate(makeInput({
      governance: {
        stuckTurns: 5,
        toolSuccessRate: 1.0,
        recentToolNames: ['Read', 'Grep', 'Read'],
        activeToolNames: ['Read', 'Grep', 'Edit', 'Write', 'Bash'],
      },
    }) as any)
    expect(result).not.toBeNull()
    expect(result!.tools).toEqual(['Edit', 'Write', 'Bash'])
  })

  it('returns null instead of an empty restriction when every available tool was recently used', () => {
    const result = C7.evaluate(makeInput({
      governance: {
        stuckTurns: 8,
        toolSuccessRate: 1.0,
        recentToolNames: ['Mfl', 'WebSearch'],
        activeToolNames: ['Mfl', 'WebSearch'],
      },
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
