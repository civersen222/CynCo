import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { initJournal } from '../../training/decisionJournal.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { GovernanceReport } from '../../vsm/types.js'

function baseGovernance(): GovernanceReport {
  return {
    status: 'healthy', s3s4Balance: 'balanced', modelLatencyTrend: 'stable',
    stuckTurns: 0, toolSuccessRate: 1.0,
    taskError: null, errorTrend: null, fingerprintAlarm: null,
    infoGain: null, progressRate: null, explorationState: null,
  } as unknown as GovernanceReport
}

describe('S5Orchestrator journal session id', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'journal-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('stamps the passed sessionId (not a timestamp) on the journal entry', async () => {
    initJournal(dir)
    const orch = new S5Orchestrator(new RuleBasedS5())
    await orch.makeDecision({
      userMessage: 'hi', activeWorkflow: null, currentPhase: null,
      contextUsagePercent: 0.5, governance: baseGovernance(),
      recentToolResults: [], availableModels: ['qwen3:8b'], turnCount: 1,
      sessionId: 'session-XYZ',
    })
    const file = join(dir, 's5-decisions.jsonl')
    expect(existsSync(file)).toBe(true)
    const line = readFileSync(file, 'utf-8').trim().split('\n')[0]
    expect(JSON.parse(line).sessionId).toBe('session-XYZ')
  })
})
