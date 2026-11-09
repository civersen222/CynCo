import { describe, it, expect } from 'vitest'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import type { OrchestratorInput } from '../../s5/orchestrator.js'
import type { S5Input, S5Decision, S5Interface } from '../../s5/types.js'
import type { GovernanceReport } from '../../vsm/types.js'

/**
 * The loop hands the orchestrator the trust scorer's demoted tools
 * (`demotedTools: this.executor.getToolScorer?.()?.getDemotedTools()`), and
 * `S5Input.demotedTools` exists to carry them to the rules. `makeDecision`
 * hardcoded `demotedTools: []`, so the field the loop filled never arrived —
 * and `OrchestratorInput` did not even declare it, which is how the strict
 * type-check (A1) found it.
 */
function governance(): GovernanceReport {
  return {
    status: 'healthy', varietyBalance: 'balanced', varietyRatio: 1.0, varietyWindowed: 0,
    taskError: null, errorTrend: null, fingerprintAlarm: null, infoGain: null, progressRate: null, explorationState: null,
    s3s4Balance: 'balanced', algedonicAlerts: 0, algedonicAlertsTotal: 0, signalsVersion: 2, stuckTurns: 0, consecutiveUnstable: 0,
    modelLatencyTrend: 'stable', toolSuccessRate: 1.0, agreementRatio: 1.0, observerDivergence: null,
    axiomHealth: { holding: 0, total: 0, violations: [] }, recentToolNames: [],
    predictions: { open: 0, completed: 0, stats: [] },
    s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
    heterarchy: { context: 'normal', commander: 'S3', shifted: false },
    tokPerSec: 0,
  } as GovernanceReport
}

describe('S5Orchestrator forwards the demoted tools', () => {
  it('the S5 implementation sees what the loop passed, not an empty list', async () => {
    let seen: S5Input | null = null
    const capture: S5Interface = {
      name: 'capture',
      async decide(input: S5Input): Promise<S5Decision> {
        seen = input
        return { workflow: null, advancePhase: null, model: null, tools: null, contextAction: 'none', spawnAgent: null, priority: 'balanced', reasoning: 'captured' }
      },
    }
    const input: OrchestratorInput = {
      userMessage: 'edit the file', activeWorkflow: null, currentPhase: null, contextUsagePercent: 0.2,
      governance: governance(), recentToolResults: [], availableModels: ['m'], turnCount: 2,
      demotedTools: ['Bash', 'ApplyPatch'],
    }
    await new S5Orchestrator(capture).makeDecision(input)
    expect(seen!.demotedTools).toEqual(['Bash', 'ApplyPatch'])
  })
})
