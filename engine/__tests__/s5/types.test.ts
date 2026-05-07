import { describe, it, expect } from 'bun:test'
import type { S5Input, S5Decision, RuleTier, S5Rule } from '../../s5/types.js'

describe('S5 extended types', () => {
  it('S5Input accepts new governance fields', () => {
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.5,
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:32b'],
      turnCount: 1,
      recentToolResults: [],
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
    }
    expect(input.varietyBalance).toBe('balanced')
    expect(input.homeostatStable).toBe(true)
  })

  it('S5Rule has id, tier, and evaluate', () => {
    const rule: S5Rule = {
      id: 'C1',
      tier: 'critical',
      name: 'Kill switch active',
      evaluate: (input: S5Input) => {
        if (input.governanceStatus === 'halted') {
          return { tools: ['Read', 'Glob', 'Grep', 'Ls'], reasoning: 'Halted — read-only mode' }
        }
        return null
      },
    }
    expect(rule.tier).toBe('critical')
    expect(rule.id).toBe('C1')
  })

  it('RuleTier values are critical, warning, info', () => {
    const tiers: RuleTier[] = ['critical', 'warning', 'info']
    expect(tiers).toHaveLength(3)
  })

  it('S5Decision has decisionId and ruleIds', () => {
    const d: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'test',
      decisionId: 'abc-123',
      ruleIds: ['C1', 'W2'],
    }
    expect(d.decisionId).toBe('abc-123')
    expect(d.ruleIds).toEqual(['C1', 'W2'])
  })
})
