import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import { initJournal } from '../../training/decisionJournal.js'
import type { GovernanceReport } from '../../vsm/types.js'
import type { OrchestratorInput } from '../../s5/orchestrator.js'

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

function makeInput(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    userMessage: 'fix the crash',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.2,
    governance: makeGovernance(),
    recentToolResults: [],
    availableModels: ['qwen3:8b'],
    turnCount: 2,
    ...overrides,
  }
}

describe('proactive surfacing — journal triple', () => {
  let dir: string
  const prev = process.env.LOCALCODE_S5_PROACTIVE_TOOLS

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cynco-journal-'))
    initJournal(dir)
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    else process.env.LOCALCODE_S5_PROACTIVE_TOOLS = prev
    rmSync(dir, { recursive: true, force: true })
  })

  function lastEntry(): any {
    const lines = readFileSync(join(dir, 's5-decisions.jsonl'), 'utf-8').trim().split('\n')
    return JSON.parse(lines[lines.length - 1])
  }

  it('journals (taskClass, loadedTools) as state and surfaceTools as action', async () => {
    process.env.LOCALCODE_S5_PROACTIVE_TOOLS = 'true'
    const orch = new S5Orchestrator(new RuleBasedS5())
    await orch.makeDecision(makeInput({ taskClass: 'debug', loadedTools: ['Read'] }))

    const entry = lastEntry()
    expect(entry.system).toBe('S5')
    // STATE half rides in input
    expect(entry.input.taskClass).toBe('debug')
    expect(entry.input.loadedTools).toEqual(['Read'])
    // ACTION half rides in decision — debug hints [Bash,Grep,Read] minus loaded Read
    expect(entry.decision.surfaceTools).toEqual(['Bash', 'Grep'])
  })

  it('journals an empty surfaceTools array when the flag is off', async () => {
    delete process.env.LOCALCODE_S5_PROACTIVE_TOOLS
    const orch = new S5Orchestrator(new RuleBasedS5())
    await orch.makeDecision(makeInput({ taskClass: 'debug', loadedTools: ['Read'] }))

    const entry = lastEntry()
    // State still recorded (harmless), but no tools surfaced → stable [] schema
    expect(entry.input.taskClass).toBe('debug')
    expect(entry.decision.surfaceTools).toEqual([])
  })
})
