/**
 * Per-decision outcome: the S5 corpus's missing label.
 *
 * This file used to define `evaluateOutcome` inside itself and assert against
 * its own copy — a comment said the real one "will be exported from orchestrator
 * or a utility", which never happened. It therefore passed no matter what the
 * orchestrator did. These tests drive S5Orchestrator directly and read the
 * journal off disk.
 *
 * The property under test: an outcome is a MEASUREMENT. When governance does not
 * report the numbers the verdict is `unknown` — never a default that happens to
 * look like a verdict. The old code used `?? 0` and `?? 1.0`, which made every
 * unreported turn compare a real "before" to an invented "after".
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { initJournal } from '../../training/decisionJournal.js'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import type { GovernanceReport } from '../../vsm/types.js'

// C-tier rules need a reason to fire; a doom loop gives one, so `lastDecision`
// is actually armed (it is only set when at least one rule fires).
function governance(over: Record<string, unknown> = {}): GovernanceReport {
  return {
    status: 'critical', s3s4Balance: 'balanced', modelLatencyTrend: 'stable',
    stuckTurns: 6, toolSuccessRate: 0.2,
    taskError: null, errorTrend: null, fingerprintAlarm: null,
    infoGain: null, progressRate: null, explorationState: null,
    ...over,
  } as unknown as GovernanceReport
}

describe('S5 per-decision outcome', () => {
  let dir: string
  let orch: S5Orchestrator

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outcome-'))
    initJournal(dir)
    orch = new S5Orchestrator(new RuleBasedS5())
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  const decide = (gov: GovernanceReport, contextUsagePercent = 0.5) => orch.makeDecision({
    userMessage: 'x', activeWorkflow: null, currentPhase: null,
    contextUsagePercent, governance: gov, recentToolResults: [],
    availableModels: ['qwen3:8b'], turnCount: 3, sessionId: 's1',
  })

  const journalLines = () =>
    readFileSync(join(dir, 's5-decisions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))

  it('reports positive when stuckTurns measurably fell', async () => {
    await decide(governance({ stuckTurns: 6 }))
    const res = orch.evaluateLastDecision({ stuckTurns: 2, toolSuccessRate: 0.2 })
    expect(res?.outcome).toBe('positive')
  })

  it('reports negative when nothing improved', async () => {
    await decide(governance({ stuckTurns: 6, toolSuccessRate: 0.2 }))
    const res = orch.evaluateLastDecision({ stuckTurns: 6, toolSuccessRate: 0.2 })
    expect(res?.outcome).toBe('negative')
  })

  it('reports unknown — not negative — when governance reports neither number', async () => {
    await decide(governance())
    // The regression this pins: `?? 0` made the missing stuckTurns read as 0,
    // which is less than the "before" of 6, so a turn with no evidence scored
    // POSITIVE. Fabricating either side fabricates the label.
    const res = orch.evaluateLastDecision({})
    expect(res?.outcome).toBe('unknown')
  })

  it('reports unknown when the decision-time baseline was never reported', async () => {
    // A context rule fires on contextUsagePercent alone, so a decision is pending
    // even though governance reported neither number to baseline against.
    await decide(governance({ stuckTurns: undefined, toolSuccessRate: undefined }), 0.95)
    const res = orch.evaluateLastDecision({ stuckTurns: 2, toolSuccessRate: 0.9 })
    // The "after" is fully measured here. It is still not a verdict, because
    // there is nothing to compare it to.
    expect(res?.outcome).toBe('unknown')
  })

  it('backfills the journal keyed on decisionId, carrying the raw before/after', async () => {
    const decision = await decide(governance({ stuckTurns: 6 }))
    orch.evaluateLastDecision({ stuckTurns: 1, toolSuccessRate: 0.2 })

    const [entry, backfill] = journalLines()
    expect(entry.decision.decisionId).toBe(decision.decisionId)
    expect(backfill._backfill).toBe(true)
    // decisionId, not entryTimestamp: makeJournalEntry stamps its own Date.now(),
    // so the orchestrator never learns the entry's timestamp and cannot key on it.
    expect(backfill.decisionId).toBe(decision.decisionId)
    expect(backfill.entryTimestamp).toBeUndefined()
    expect(backfill.outcome.outcome).toBe('positive')
    expect(backfill.outcome.measured).toBe(true)
    expect(backfill.outcome.stuckTurnsBefore).toBe(6)
    expect(backfill.outcome.stuckTurnsAfter).toBe(1)
  })

  it('records an unmeasured outcome rather than omitting it', async () => {
    await decide(governance())
    orch.evaluateLastDecision({})
    const backfill = journalLines()[1]
    // A missing line cannot distinguish "measured and bad" from "never measured".
    // Writing `measured: false` lets the exporter tell them apart.
    expect(backfill.outcome.outcome).toBe('unknown')
    expect(backfill.outcome.measured).toBe(false)
    expect(backfill.outcome.stuckTurnsAfter).toBeNull()
  })

  it('evaluates a decision once — the second call has nothing pending', async () => {
    await decide(governance({ stuckTurns: 6 }))
    expect(orch.evaluateLastDecision({ stuckTurns: 1, toolSuccessRate: 0.2 })?.outcome).toBe('positive')
    // Without this, one decision would be backfilled on every subsequent turn and
    // the corpus would count the same label many times.
    expect(orch.evaluateLastDecision({ stuckTurns: 1, toolSuccessRate: 0.2 })).toBeNull()
    expect(journalLines().filter(l => l._backfill)).toHaveLength(1)
  })

  it('returns null when no decision is pending', () => {
    expect(orch.evaluateLastDecision({ stuckTurns: 0, toolSuccessRate: 1 })).toBeNull()
  })
})
