import { describe, expect, it } from 'bun:test'
import { S5Orchestrator, type OrchestratorInput } from '../../s5/orchestrator.js'
import type { S5Input, S5Decision, S5Interface } from '../../s5/types.js'
import type { GovernanceReport } from '../../vsm/types.js'

// Stub S5 that captures the normalized S5Input it receives.
class CapturingS5 implements S5Interface {
  name = 'CapturingS5'
  captured: S5Input | null = null
  async decide(input: S5Input): Promise<S5Decision> {
    this.captured = input
    return { contextAction: null, toolRestriction: null, modelSwitch: null, reasoning: 'stub' } as S5Decision
  }
}

const govReport: GovernanceReport = {
  status: 'healthy',
  taskError: null,
  errorTrend: null,
  fingerprintAlarm: null,
  infoGain: null,
  progressRate: null,
  explorationState: null,
  s3s4Balance: 'balanced',
  modelLatencyTrend: 'stable',
} as unknown as GovernanceReport

function baseOrchestratorInput(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    userMessage: 'test',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.5,
    governance: govReport,
    recentToolResults: [],
    availableModels: ['qwen3.6'],
    turnCount: 3,
    ...overrides,
  }
}

describe('promptDifficulty reaches S5Input', () => {
  it('forwards an explicit promptDifficulty to the S5 decision input', async () => {
    const s5 = new CapturingS5()
    const orch = new S5Orchestrator(s5)
    await orch.makeDecision(baseOrchestratorInput({ promptDifficulty: 'hard' }))
    expect(s5.captured?.promptDifficulty).toBe('hard')
  })

  it("defaults promptDifficulty to 'unknown' when not provided", async () => {
    const s5 = new CapturingS5()
    const orch = new S5Orchestrator(s5)
    await orch.makeDecision(baseOrchestratorInput())
    expect(s5.captured?.promptDifficulty).toBe('unknown')
  })
})
