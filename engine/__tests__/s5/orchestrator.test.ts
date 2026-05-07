import { describe, expect, it } from 'bun:test'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { GovernanceReport } from '../../vsm/types.js'
import type { OrchestratorInput } from '../../s5/orchestrator.js'

function makeGovernance(overrides: Partial<GovernanceReport> = {}): GovernanceReport {
  return {
    status: 'healthy',
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    s3s4Balance: 'balanced',
    algedonicAlerts: 0,
    stuckTurns: 0,
    consecutiveUnstable: 0,
    modelLatencyTrend: 'stable',
    toolSuccessRate: 1.0,
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
