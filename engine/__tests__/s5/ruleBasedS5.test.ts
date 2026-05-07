import { describe, expect, it } from 'bun:test'
import { RuleBasedS5, ALL_RULES } from '../../s5/ruleBasedS5.js'
import type { S5Input } from '../../s5/types.js'

function baseInput(overrides: Partial<S5Input> = {}): S5Input {
  return {
    userMessage: 'test',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.5,
    governanceStatus: 'healthy',
    s3s4Balance: 'balanced',
    modelLatencyTrend: 'stable',
    availableModels: ['qwen3:32b'],
    turnCount: 5,
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
    ...overrides,
  }
}

describe('RuleBasedS5 — Hardened 20-rule engine', () => {
  const s5 = new RuleBasedS5()

  it('has correct type shape — name and decide()', () => {
    expect(s5.name).toBe('RuleBasedS5')
    expect(typeof s5.decide).toBe('function')
  })

  it('exports ALL_RULES with 18 rules (6 critical + 7 warning + 5 info)', () => {
    expect(Array.isArray(ALL_RULES)).toBe(true)
    expect(ALL_RULES.length).toBe(18)
    const criticals = ALL_RULES.filter(r => r.tier === 'critical')
    const warnings = ALL_RULES.filter(r => r.tier === 'warning')
    const infos = ALL_RULES.filter(r => r.tier === 'info')
    expect(criticals.length).toBe(6)
    expect(warnings.length).toBe(7)
    expect(infos.length).toBe(5)
  })

  // ─── Critical rules ────────────────────────────────────────

  describe('C1: Kill switch (halted)', () => {
    it('restricts to read-only tools and ruleIds contains C1', async () => {
      const decision = await s5.decide(baseInput({ governanceStatus: 'halted' }))
      expect(decision.tools).toEqual(['Read', 'Glob', 'Grep', 'Ls'])
      expect(decision.ruleIds).toContain('C1')
    })
  })

  describe('C2: Consecutive failures in same tool', () => {
    it('excludes Bash when 3+ Bash failures', async () => {
      const decision = await s5.decide(baseInput({
        recentToolResults: [
          { tool: 'Bash', success: false },
          { tool: 'Bash', success: false },
          { tool: 'Bash', success: false },
        ],
      }))
      expect(decision.tools).not.toBeNull()
      expect(decision.tools).not.toContain('Bash')
      expect(decision.ruleIds).toContain('C2')
    })
  })

  describe('C3: Context overflow', () => {
    it('triggers compact at 92% context usage', async () => {
      const decision = await s5.decide(baseInput({ contextUsagePercent: 0.92 }))
      expect(decision.contextAction).toBe('compact')
      expect(decision.ruleIds).toContain('C3')
    })
  })

  describe('C4: Doom loop', () => {
    it('excludes tool with 3+ identical consecutive failing calls', async () => {
      const decision = await s5.decide(baseInput({
        recentToolResults: [
          { tool: 'Edit', success: false },
          { tool: 'Edit', success: false },
          { tool: 'Edit', success: false },
        ],
      }))
      expect(decision.tools).not.toBeNull()
      expect(decision.tools).not.toContain('Edit')
      expect(decision.ruleIds).toContain('C4')
    })
  })

  describe('C6: Variety critical', () => {
    it('restricts to top 5 tools when varietyBalance is critical', async () => {
      const decision = await s5.decide(baseInput({
        varietyBalance: 'critical',
        recentToolResults: [
          { tool: 'Read', success: true },
          { tool: 'Read', success: true },
          { tool: 'Grep', success: true },
          { tool: 'Edit', success: true },
          { tool: 'Write', success: true },
          { tool: 'Bash', success: true },
          { tool: 'Glob', success: true },
          { tool: 'Git', success: false },
        ],
      }))
      expect(decision.tools).not.toBeNull()
      expect(decision.tools!.length).toBeLessThanOrEqual(5)
      expect(decision.ruleIds).toContain('C6')
    })
  })

  // ─── Warning rules ─────────────────────────────────────────

  describe('W1: Context pressure', () => {
    it('triggers warn at 78% context usage', async () => {
      const decision = await s5.decide(baseInput({ contextUsagePercent: 0.78 }))
      expect(decision.contextAction).toBe('warn')
      expect(decision.ruleIds).toContain('W1')
    })
  })

  describe('W2: Model switch suggestion', () => {
    it('suggests model switch with rising latency and 2+ models', async () => {
      const decision = await s5.decide(baseInput({
        modelLatencyTrend: 'rising',
        turnCount: 6,
        availableModels: ['qwen3:32b', 'qwen3:8b'],
      }))
      expect(decision.model).not.toBeNull()
      expect(decision.ruleIds).toContain('W2')
    })
  })

  describe('W3: Revert recommendation', () => {
    it('recommends revert with stuck 6 turns and 30% success', async () => {
      const total = 10
      const successes = 3
      const failures = total - successes
      const results = [
        ...Array(successes).fill({ tool: 'Read', success: true }),
        ...Array(failures).fill({ tool: 'Bash', success: false }),
      ]
      const decision = await s5.decide(baseInput({
        governance: { stuckTurns: 6, toolSuccessRate: 0.3 },
        recentToolResults: results,
      }))
      expect(decision.revert).toBe(true)
      expect(decision.ruleIds).toContain('W3')
    })
  })

  describe('W5: Homeostatic instability', () => {
    it('rebalances priority when unstable 4+ times and S3 dominant', async () => {
      const decision = await s5.decide(baseInput({
        homeostatStable: false,
        homeostatConsecutiveUnstable: 4,
        s3s4Balance: 's3_dominant',
      }))
      expect(decision.priority).toBe('s4')
      expect(decision.ruleIds).toContain('W5')
    })
  })

  describe('W6: S3/S4 imbalance', () => {
    it('boosts s3 priority when S4 dominant for 8+ turns', async () => {
      const decision = await s5.decide(baseInput({
        s3s4Balance: 's4_dominant',
        turnCount: 8,
      }))
      expect(decision.priority).toBe('s3')
      expect(decision.ruleIds).toContain('W6')
    })
  })

  // ─── Defaults / healthy state ──────────────────────────────

  describe('Healthy defaults', () => {
    it('returns no restrictions and balanced priority for healthy input', async () => {
      const decision = await s5.decide(baseInput())
      expect(decision.tools).toBeNull()
      expect(decision.contextAction).toBe('none')
      expect(decision.priority).toBe('balanced')
      expect(decision.revert).toBeFalsy()
      expect(decision.model).toBeNull()
    })
  })

  // ─── Decision shape ────────────────────────────────────────

  describe('Decision metadata', () => {
    it('every decision has ruleIds array and decisionId string', async () => {
      const healthyDecision = await s5.decide(baseInput())
      expect(Array.isArray(healthyDecision.ruleIds)).toBe(true)
      expect(typeof healthyDecision.decisionId).toBe('string')
      expect(healthyDecision.decisionId!.length).toBeGreaterThan(0)

      const criticalDecision = await s5.decide(baseInput({ governanceStatus: 'halted' }))
      expect(Array.isArray(criticalDecision.ruleIds)).toBe(true)
      expect(typeof criticalDecision.decisionId).toBe('string')
      expect(criticalDecision.decisionId!.length).toBeGreaterThan(0)
    })

    it('always provides a non-empty reasoning string', async () => {
      const cases: Partial<S5Input>[] = [
        {},
        { contextUsagePercent: 0.95 },
        { governanceStatus: 'halted' },
        { s3s4Balance: 's4_dominant', turnCount: 8 },
      ]
      for (const override of cases) {
        const decision = await s5.decide(baseInput(override))
        expect(decision.reasoning.length).toBeGreaterThan(0)
      }
    })
  })

  // ─── Combination logic ─────────────────────────────────────

  describe('Rule combination', () => {
    it('C3 compact overrides W1 warn when both fire', async () => {
      // context at 95% triggers both C3 (>=0.90 → compact) and W1 (>=0.75 → warn)
      // compact is stronger than warn
      const decision = await s5.decide(baseInput({ contextUsagePercent: 0.95 }))
      expect(decision.contextAction).toBe('compact')
      expect(decision.ruleIds).toContain('C3')
    })

    it('multiple rules can fire and all appear in ruleIds', async () => {
      const decision = await s5.decide(baseInput({
        contextUsagePercent: 0.92,
        s3s4Balance: 's4_dominant',
        turnCount: 8,
      }))
      expect(decision.ruleIds).toContain('C3')
      expect(decision.ruleIds).toContain('W6')
    })
  })
})
