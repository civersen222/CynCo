import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The ledger collector is a plain .mjs module used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { createMissionCollector, buildMissionRecord, missionCommitted, missionOutcome, waitIsOver, QUIET_MS } from '../../../scripts/cynco-ledger.mjs'

describe('cynco mission outcome ledger', () => {
  const syntheticStream = [
    { type: 'tool.start', toolName: 'Read' },
    { type: 'tool.complete', toolName: 'Read', isError: false },
    { type: 'governance.status', health: 'healthy', s3s4Balance: 'critical', toolSuccessRate: 1.0, stuckTurns: 0, varietyRatio: 9, varietyBalance: 'overload', algedonicAlerts: 0, axiomHealth: 'red', consecutiveUnstable: 3, agreementRatio: 0.0, suggestion: null },
    { type: 'control.signals', temperatureAdjust: -0.1, temperature: 0.6, bestOfNBudget: 1, widenToolSet: false },
    { type: 's5.decision', reasoning: 'homeostat unstable', contextAction: null, toolRestriction: 'read-only', modelSwitch: null, ruleIds: ['C7'], enforced: false, timestamp: 1 },
    { type: 'tool.start', toolName: 'Edit' },
    { type: 'tool.complete', toolName: 'Edit', isError: true, result: 'anchor not found' },
    { type: 'tool.start', toolName: 'Edit' },
    { type: 'tool.complete', toolName: 'Edit', isError: false },
    { type: 'governance.status', health: 'healthy', s3s4Balance: 'critical', toolSuccessRate: 0.75, stuckTurns: 1, varietyRatio: 8, varietyBalance: 'overload', algedonicAlerts: 1, axiomHealth: 'red', consecutiveUnstable: 4, agreementRatio: 0.0, suggestion: 'stuck' },
    { type: 'stream.token', text: 'ignored' },
  ]

  function collectAll() {
    let tick = 0
    const c = createMissionCollector(() => ++tick)
    for (const evt of syntheticStream) c.ingest(evt)
    return c
  }

  it('captures per-turn governance signal vectors including agreementRatio', () => {
    const c = collectAll()
    expect(c.turns.length).toBe(2)
    expect(c.turns[0].agreementRatio).toBe(0.0)
    expect(c.turns[0].consecutiveUnstable).toBe(3)
    expect(c.turns[1].stuckTurns).toBe(1)
    expect(c.turns[1].toolSuccessRate).toBe(0.75)
  })

  it('captures S5 decisions with per-rule attribution and enforcement flag', () => {
    const c = collectAll()
    expect(c.s5Decisions.length).toBe(1)
    expect(c.s5Decisions[0].ruleIds).toEqual(['C7'])
    expect(c.s5Decisions[0].enforced).toBe(false)
    expect(c.enforcedSeen).toBe(false)
  })

  it('flags enforcedSeen when a decision was enforced (F7 risk detector)', () => {
    const c = createMissionCollector()
    c.ingest({ type: 's5.decision', reasoning: 'crisis', ruleIds: ['C7'], enforced: true })
    expect(c.enforcedSeen).toBe(true)
  })

  it('counts tool usage and errors by name', () => {
    const c = collectAll()
    expect(c.toolStats.total).toBe(3)
    expect(c.toolStats.errors).toBe(1)
    expect(c.toolStats.byName).toEqual({ Read: 1, Edit: 2 })
  })

  it('captures control signals and ignores unrelated events', () => {
    const c = collectAll()
    expect(c.controlSignals.length).toBe(1)
    expect(c.controlSignals[0].temperature).toBe(0.6)
  })

  it('buildMissionRecord produces the schema-1 labeled record', () => {
    const c = collectAll()
    const rec = buildMissionRecord(c, {
      missionId: 'cynco-mission6-brief-123',
      briefFile: 'C:/tmp/cynco-mission6-brief.txt',
      marker: 'event log feed',
      cwd: 'C:\\Users\\civer\\civkings',
      dispatchedAt: '2026-07-11T22:00:00.000Z',
      durationS: 412,
      outcome: 'landed',
    })
    expect(rec.schema).toBe(1)
    expect(rec.outcome).toBe('landed')
    expect(rec.verified).toBeNull()
    expect(rec.turns.length).toBe(2)
    expect(rec.s5Decisions.length).toBe(1)
    expect(rec.toolStats.total).toBe(3)
    // Must be JSONL-safe: one line, round-trips
    const line = JSON.stringify(rec)
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual(rec)
  })

  it('handles legacy events missing the new fields (nulls, not crashes)', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', s3s4Balance: 'balanced', toolSuccessRate: 1, stuckTurns: 0, suggestion: null })
    c.ingest({ type: 's5.decision', reasoning: 'ok' })
    expect(c.turns[0].agreementRatio).toBeNull()
    expect(c.s5Decisions[0].ruleIds).toEqual([])
    expect(c.s5Decisions[0].enforced).toBeNull()
  })

  it('collects toolcall.transport events into the mission record (P1.8)', () => {
    const collector = createMissionCollector(() => 1000)
    collector.ingest({ type: 'toolcall.transport', stage: 'repaired', toolName: 'Read', detail: 'jsonrepair salvaged 40-char args' })
    collector.ingest({ type: 'toolcall.transport', stage: 'retried', toolName: 'Write', detail: 'Unexpected token' })
    collector.ingest({ type: 'toolcall.transport', stage: 'discarded', toolName: 'Write', detail: 'Unexpected token' })
    const record = buildMissionRecord(collector, {
      missionId: 'm1', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(record.toolTransport).toEqual([
      { t: 1000, stage: 'repaired', toolName: 'Read', detail: 'jsonrepair salvaged 40-char args' },
      { t: 1000, stage: 'retried', toolName: 'Write', detail: 'Unexpected token' },
      { t: 1000, stage: 'discarded', toolName: 'Write', detail: 'Unexpected token' },
    ])
  })

  it('governance.status predictions snapshot lands in the turn record (P1.2)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({
      type: 'governance.status',
      health: 'healthy',
      predictions: { open: 1, completed: 2, stats: [{ hypothesis: 'H4', total: 2, correct: 1, hitRate: 0.5, confidenceInterval: [0.1, 0.9], nullBaselineRate: 0.3, significantlyBetter: false }] },
    })
    expect(c.turns[0].predictions).toEqual({ open: 1, completed: 2, stats: [expect.objectContaining({ hypothesis: 'H4' })] })
  })

  it('governance.status without predictions records null (older engines)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].predictions).toBeNull()
  })

  it('governance.status s4 snapshot lands in the turn record (P1.3)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({
      type: 'governance.status',
      health: 'healthy',
      s4: { scores: { progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 }, composite: 7.25, reflectionCount: 1, taskType: 'debugging', taskComplexity: 5 },
    })
    expect(c.turns[0].s4).toEqual(expect.objectContaining({ composite: 7.25, reflectionCount: 1, taskType: 'debugging', taskComplexity: 5 }))
    expect(c.turns[0].s4.scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 2 })
  })

  it('governance.status without s4 records null (older engines)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].s4).toBeNull()
  })

  it('snapshot.taken attaches to the latest turn record (P1.4)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({ type: 'snapshot.taken', hash: 'abc123', prevHash: 'def456', filesChanged: 2, additions: 10, deletions: 3 })
    expect(c.turns[0].snapshot).toEqual({ hash: 'abc123', prevHash: 'def456', filesChanged: 2, additions: 10, deletions: 3 })
  })

  it('turns without a snapshot event carry snapshot: null; snapshot.taken before any turn does not crash', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'snapshot.taken', hash: 'abc123', prevHash: 'def456', filesChanged: 1, additions: 1, deletions: 0 })
    expect(c.turns.length).toBe(0) // ignored, no crash
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].snapshot).toBeNull()
  })

  it('governance.status carries varietyWindowed into the turn record; absent → null (P1.5)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy', varietyRatio: 5.5, varietyWindowed: 4 })
    c.ingest({ type: 'governance.status', health: 'healthy', varietyRatio: 5.5 })
    expect(c.turns[0].varietyWindowed).toBe(4)
    expect(c.turns[0].varietyRatio).toBe(5.5) // both series, side by side
    expect(c.turns[1].varietyWindowed).toBe(null)
  })

  it('governance.status carries the heterarchy snapshot into the turn record; absent → null (P1.6)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy', heterarchy: { context: 'exploration', commander: 'S4', shifted: true } })
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].heterarchy).toEqual({ context: 'exploration', commander: 'S4', shifted: true })
    expect(c.turns[1].heterarchy).toBe(null)
  })

  it('buildMissionRecord passes verified + verify detail through from meta (Phase 2b)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-verify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'landed',
      verified: true,
      verify: { command: 'pytest -q tests/smoke.py', exitCode: 0, timedOut: false, durationMs: 4200, outputTail: '3 passed' },
    })
    expect(rec.verified).toBe(true)
    expect(rec.verify.exitCode).toBe(0)
    expect(rec.verify.command).toBe('pytest -q tests/smoke.py')
  })

  it('buildMissionRecord without verified/verify stays null (manual-patch path unchanged)', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-noverify', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'timeout',
    })
    expect(rec.verified).toBeNull()
    expect(rec.verify).toBeNull()
  })

  // A wave that states behavioural rules is accepted only when a withheld
  // mutation set makes the repo's OWN tests go red. `verified` cannot carry
  // that: it is one check command's exit code. Measured on the real ledger —
  // record #33 (ui2b_brief) is landed + verified:true, and the withheld sweep
  // then killed only 14/15, which is why a ui2c wave had to exist at all. So
  // the record needs a SECOND, independent label slot, and it must be null
  // (unmeasured) rather than false or absent when no sweep has been run.
  it('buildMissionRecord carries a mutationSweep label independent of verified', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-sweep', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'landed',
      verified: true,
      verify: { command: 'python check.py', exitCode: 0, timedOut: false, durationMs: 10, outputTail: 'ok' },
      mutationSweep: {
        command: 'python C:/tmp/mutate_ui2.py',
        killed: 14,
        total: 15,
        survived: ['14'],
      },
    })
    expect(rec.verified).toBe(true)
    expect(rec.mutationSweep.killed).toBe(14)
    expect(rec.mutationSweep.total).toBe(15)
    expect(rec.mutationSweep.survived).toEqual(['14'])
    // the two labels disagree, and the record must be able to SAY they disagree
    expect(rec.mutationSweep.killed === rec.mutationSweep.total).toBe(false)
    const line = JSON.stringify(rec)
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual(rec)
  })

  it('no sweep run → mutationSweep is null (unmeasured), not false and not absent', () => {
    const c = createMissionCollector(() => 1000)
    const rec = buildMissionRecord(c, {
      missionId: 'm-nosweep', briefFile: 'b.md', marker: 'x', cwd: '.',
      dispatchedAt: 0, durationS: 1, outcome: 'landed', verified: true,
    })
    expect(rec.mutationSweep).toBeNull()
    expect('mutationSweep' in rec).toBe(true)
  })

  // The 34 records written before mutationSweep existed carried the key ABSENT,
  // while every record since carries it as null. Both mean "unmeasured", and a
  // scorer excluding on `=== null` would silently keep the absent ones — one
  // meaning with two encodings is how a default sneaks in. Backfilled to null;
  // this pins it so the split cannot reopen.
  it('every committed ledger record encodes unmeasured one way: the key present, value null', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const path = join(here, '..', '..', '..', 'benchmark', 'cynco-ledger', 'missions.jsonl')
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(rows.length).toBeGreaterThan(0)
    const absent = rows.filter((r) => !('mutationSweep' in r)).map((r) => r.missionId)
    expect(absent).toEqual([])
    // and no record may say "unmeasured" with a falsy non-null value
    const falsyNonNull = rows
      .filter((r) => r.mutationSweep !== null && !r.mutationSweep)
      .map((r) => r.missionId)
    expect(falsyNonNull).toEqual([])
  })

  it('turn records carry taskError + errorTrend from governance.status (P4.1)', () => {
    const c = createMissionCollector(() => 42)
    c.ingest({ type: 'governance.status', health: 'healthy', taskError: 0.5, errorTrend: 'rising' })
    expect(c.turns[0].taskError).toBe(0.5)
    expect(c.turns[0].errorTrend).toBe('rising')
  })

  it('turn records default taskError + errorTrend to null when absent (P4.1)', () => {
    const c = createMissionCollector(() => 42)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    expect(c.turns[0].taskError).toBeNull()
    expect(c.turns[0].errorTrend).toBeNull()
  })

  it('governance.session_fidelity lands as a top-level regulatorFidelity field (P4.3/4e)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({
      type: 'governance.session_fidelity',
      fidelity: { hadContract: true, resolutionRate: 0.75, finalTaskError: 0.25, contractReplacements: 1 },
    })
    const rec = buildMissionRecord(c, {
      missionId: 'm-fid', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(rec.regulatorFidelity).toEqual({ hadContract: true, resolutionRate: 0.75, finalTaskError: 0.25, contractReplacements: 1 })
  })

  it('absent session_fidelity → regulatorFidelity null on the record (P4.3/4e)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    const rec = buildMissionRecord(c, {
      missionId: 'm-nofid', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'timeout',
    })
    expect(rec.regulatorFidelity).toBeNull()
  })
})

// The driver's landing detector. It reported the OPPOSITE of what happened for
// UI Wave 6d: brief-dictated commit subject "R12: test_r12_..." carried no
// marker, so a landed + pushed + 973-green wave was headed for outcome
// "timeout". A driver that lies about the outcome poisons every record scored
// off this ledger, so the decision has a name and these tests.
describe('missionCommitted — did this mission commit anything?', () => {
  const MARKER = 'Wave 6d'
  const SHA = 'deadbee'

  it('a scoped log with commits but no marker is committed (the Wave 6d case)', () => {
    const log = 'c64d8e4 R12: test_r12_treasury_unsigned_on_surface\n'
    expect(log.includes(MARKER)).toBe(false) // the marker really is absent
    expect(missionCommitted(log, MARKER, SHA)).toBe(true)
  })

  it('an empty scoped log is not committed', () => {
    expect(missionCommitted('', MARKER, SHA)).toBe(false)
    expect(missionCommitted('\n  \n', MARKER, SHA)).toBe(false)
  })

  it('without a baseline SHA the log is unscoped, so the marker is required', () => {
    // `git log -3` can show commits that predate the mission; only the marker
    // separates them.
    const stale = 'aaa1111 fix: something from last week\nbbb2222 chore: older still\n'
    expect(missionCommitted(stale, MARKER, null)).toBe(false)
    expect(missionCommitted(`ccc3333 ${MARKER}: landed\n${stale}`, MARKER, null)).toBe(true)
  })
})

/**
 * UI Wave 7h: the run stopped after 107 seconds having completed its contract
 * but committed nothing, and the driver then sat for another 5298 seconds
 * before recording `outcome: "timeout"`. Both halves are wrong. Waiting cannot
 * help a run that has stopped talking, and "timeout" describes a run that ran
 * out of time rather than one that quit early with a dirty tree. The corpus
 * cannot learn the difference between those two if the ledger spells them the
 * same way.
 */
describe('when the driver stops waiting, and what it calls the result', () => {
  // The threshold the driver actually uses, not a copy of it — a duplicated
  // constant here would keep passing after the real one moved.
  const QUIET = QUIET_MS

  it('a run that goes quiet without committing ends the wait — it is not working', () => {
    // The exact Wave 7h shape: no commit, last message.complete long past.
    expect(waitIsOver({ landed: false, sawMessageComplete: true, msSinceActivity: QUIET })).toBe(true)
  })

  it('a quiet un-landed run is stopped_without_commit, never timeout', () => {
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true }))
      .toBe('stopped_without_commit')
  })

  it('a run still burning its budget with no quiet period is the only real timeout', () => {
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: QUIET })).toBe(false)
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false }))
      .toBe('timeout')
  })

  it('a tool call in flight is activity, however long the last message has been complete', () => {
    // tool.start resets sawMessageComplete; a long Bash must not read as quiet.
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: QUIET * 10 })).toBe(false)
  })

  it('quiet is a duration, not an event: a just-finished message is not yet quiet', () => {
    expect(waitIsOver({ landed: false, sawMessageComplete: true, msSinceActivity: QUIET - 1 })).toBe(false)
  })

  it('the landed path is unchanged — quiescence still gates verification', () => {
    expect(waitIsOver({ landed: true, sawMessageComplete: true, msSinceActivity: QUIET })).toBe(true)
    expect(waitIsOver({ landed: true, sawMessageComplete: true, msSinceActivity: 0 })).toBe(false)
    expect(missionOutcome({ landed: true, zeroToolCompletion: false, wentQuiet: true })).toBe('landed')
  })

  it('landed wins over every other label; zero-tool wins over stopping quietly', () => {
    expect(missionOutcome({ landed: true, zeroToolCompletion: true, wentQuiet: true })).toBe('landed')
    expect(missionOutcome({ landed: false, zeroToolCompletion: true, wentQuiet: true }))
      .toBe('zero_tool_fail')
  })
})
