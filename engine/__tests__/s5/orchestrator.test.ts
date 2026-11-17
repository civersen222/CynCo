import { describe, expect, it } from 'bun:test'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { GovernanceReport } from '../../vsm/types.js'
import type { OrchestratorInput } from '../../s5/orchestrator.js'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeGovernance(overrides: Partial<GovernanceReport> = {}): GovernanceReport {
  return {
    status: 'healthy',
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    varietyWindowed: 0,
    taskError: null,
    errorTrend: null,
    fingerprintAlarm: null,
    infoGain: null,
    progressRate: null,
    explorationState: null,
    s3s4Balance: 'balanced',
    algedonicAlerts: 0,
    stuckTurns: 0,
    consecutiveUnstable: 0,
    modelLatencyTrend: 'stable',
    toolSuccessRate: 1.0,
    agreementRatio: 1.0,
    observerDivergence: null,
    axiomHealth: { holding: 0, total: 0, violations: [] },
    recentToolNames: [],
    predictions: { open: 0, completed: 0, stats: [] },
    s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
    heterarchy: { context: 'normal' as const, commander: 'S3', shifted: false },
    ...overrides,
  }
}

function makeOrchestratorInput(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    userMessage: 'write some tests',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.4,
    governance: makeGovernance(),
    recentToolResults: [],
    availableModels: ['qwen3:8b'],
    turnCount: 3,
    ...overrides,
  }
}

describe('S5Orchestrator', () => {
  it('maps governance report to S5Input and returns a decision', async () => {
    const orchestrator = new S5Orchestrator(new RuleBasedS5())
    const decision = await orchestrator.makeDecision(makeOrchestratorInput())
    expect(decision).toBeDefined()
    expect(decision.reasoning).toBeTruthy()
    expect(decision.contextAction).toBe('none')
  })

  it('logs decision history and caps at 100 entries', async () => {
    const orchestrator = new S5Orchestrator(new RuleBasedS5())
    // Fill beyond cap
    for (let i = 0; i < 105; i++) {
      await orchestrator.makeDecision(makeOrchestratorInput({ turnCount: i }))
    }
    expect(orchestrator.decisionHistory.length).toBe(100)
  })

  it('supports swapping the S5 implementation at runtime', async () => {
    const orchestrator = new S5Orchestrator(new RuleBasedS5())
    expect(orchestrator.currentS5Name).toBe('RuleBasedS5')

    // Create a mock S5 with a different name
    const mockS5 = {
      name: 'MockS5',
      decide: async () => ({
        workflow: null,
        advancePhase: null,
        model: 'llama3:8b',
        tools: null,
        contextAction: 'none' as const,
        spawnAgent: null,
        priority: 'balanced' as const,
        reasoning: 'mock decision',
      }),
    }

    orchestrator.setS5(mockS5)
    expect(orchestrator.currentS5Name).toBe('MockS5')

    const decision = await orchestrator.makeDecision(makeOrchestratorInput())
    expect(decision.model).toBe('llama3:8b')
    expect(decision.reasoning).toBe('mock decision')
  })
})

// Until 2026-11-17 the orchestrator kept per-rule weights: moved by each measured outcome and
// by every denied approval (keyed by the approval's request id, not a rule), written to
// `training/s5-weights.json` at session end, and read by nothing. Removed on the owner's
// decision (row 20, F233 c). What a decision's outcome was is in the decision journal.
describe('the orchestrator keeps no rule weights', () => {
  it('constructing one, deciding and judging the decision write nothing under the home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-s5-home-'))
    const before = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try {
      const orchestrator = new S5Orchestrator(new RuleBasedS5())
      const decision = await orchestrator.makeDecision(makeOrchestratorInput({ contextUsagePercent: 0.95 }))
      expect(decision.ruleIds).toContain('C3')
      const judged = orchestrator.evaluateLastDecision({ stuckTurns: 0, toolSuccessRate: 1 })
      expect(judged?.outcome).toBe('negative') // measured, and nothing improved: still an outcome
      expect(readdirSync(home)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.CYNCO_HOME
      else process.env.CYNCO_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('has no weight methods left to call', () => {
    const orchestrator = new S5Orchestrator(new RuleBasedS5()) as unknown as Record<string, unknown>
    expect(orchestrator.saveWeights).toBeUndefined()
    expect(orchestrator.recordDismissal).toBeUndefined()
  })
})
