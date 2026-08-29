import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The ledger collector is a plain .mjs module used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { createMissionCollector, buildMissionRecord, missionCommitted, missionOutcome, waitIsOver, waitExitReason, gateDisposition, historyRewrite, gradedHeadSuspect, QUIET_MS } from '../../../scripts/cynco-ledger.mjs'
import { readLedger, shardPaths, shardIndex, activeShardPath, ledgerCount } from '../../../scripts/cynco-ledger-shards.mjs'

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

  // 150 of 226 rows cannot be swept at all, and not because sweeping them is
  // hard: nothing on the row says which commits the mission produced. The driver
  // knows — it reads HEAD before dispatch and prints it — and then throws it
  // away. Without a base..head pair, scripts/cynco-mutation-sweep.py has no diff
  // to mutate, so the row stays UNMEASURED forever and the labeling rule
  // (correctly) excludes it. This field is the difference between a ledger that
  // can be labeled later and one that can only be labeled now.
  describe('commitRange — the base..head pair a derived sweep needs', () => {
    const meta = {
      missionId: 'm-range', briefFile: 'b.md', marker: 'x', cwd: '/repo',
      dispatchedAt: 0, durationS: 1, outcome: 'landed' as const,
    }

    it('records the dispatch base and the final head, so the diff is recoverable', () => {
      const c = createMissionCollector(() => 1000)
      const rec = buildMissionRecord(c, { ...meta, baselineSha: 'aaa111', finalSha: 'bbb222' })
      expect(rec.commitRange).toEqual({ base: 'aaa111', head: 'bbb222' })
    })

    // A mission that committed nothing has base === head. That is a real,
    // measurable answer ("empty diff, nothing to mutate"), and it must not be
    // confusable with "the driver could not read the repo".
    it('a mission that committed nothing records base === head, not null', () => {
      const c = createMissionCollector(() => 1000)
      const rec = buildMissionRecord(c, { ...meta, baselineSha: 'aaa111', finalSha: 'aaa111' })
      expect(rec.commitRange).toEqual({ base: 'aaa111', head: 'aaa111' })
    })

    // gitHead() returns null rather than guessing when it cannot read the repo.
    // Half a range is not a range: a base with no head cannot be diffed, and
    // recording `{base, head: null}` invites a caller to substitute HEAD-now,
    // which would sweep every commit made since by anything.
    it('an unreadable base or head makes the whole range null, never half of one', () => {
      const c = createMissionCollector(() => 1000)
      expect(buildMissionRecord(c, { ...meta, baselineSha: null, finalSha: 'bbb222' }).commitRange).toBeNull()
      expect(buildMissionRecord(c, { ...meta, baselineSha: 'aaa111', finalSha: null }).commitRange).toBeNull()
    })

    // The 226 rows already on disk have no range and never will. They must read
    // as UNMEASURED-and-unsweepable, which is what null says, and the key must
    // be present so a reader can tell the two encodings apart — the same
    // one-meaning-two-encodings trap mutationSweep already fell into once.
    it('is present-and-null when the driver did not supply one', () => {
      const c = createMissionCollector(() => 1000)
      const rec = buildMissionRecord(c, meta)
      expect(rec.commitRange).toBeNull()
      expect('commitRange' in rec).toBe(true)
    })

    it('survives the JSONL round trip', () => {
      const c = createMissionCollector(() => 1000)
      const rec = buildMissionRecord(c, { ...meta, baselineSha: 'aaa111', finalSha: 'bbb222' })
      expect(JSON.parse(JSON.stringify(rec)).commitRange).toEqual({ base: 'aaa111', head: 'bbb222' })
    })
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
    // Across every shard: an invariant checked on only the frozen head would
    // stop covering the records that are still being written.
    const rows = readLedger()
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

  // F33. The two datasets this program produces could not be joined. A mission
  // lands here with its governance vector and its verified/mutationSweep labels;
  // the same run lands in ~/.cynco/rewards/<taskId>.reward.json with the scalar
  // the model is trained on. The taskId was minted inside conversationLoop and
  // emitted to nothing, so "which reward belongs to which mission" had no
  // answer — and the reward for UI Wave 8 (0.983) could not be set beside that
  // mission's real verdict (3 of 16 DoD items undone) by any query.
  it('trajectory.task_started lands the taskId on the record so rewards can be joined (F33)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'trajectory.task_started', taskId: 'task-735f144e', model: 'qwen' })
    c.ingest({ type: 'governance.status', health: 'healthy' })
    const rec = buildMissionRecord(c, {
      missionId: 'm-join', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(rec.taskIds).toEqual(['task-735f144e'])
  })

  // Plural, and in order. A mission is one dispatched command today, but the
  // engine starts a fresh task on every user message, so a session that is
  // steered mid-run produces several reward files. A scalar field would keep
  // one of them and silently drop the rest, which is the same class of quiet
  // default this ledger exists to refuse.
  it('several tasks in one mission all land, in order (F33)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'trajectory.task_started', taskId: 'task-aaa', model: 'qwen' })
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({ type: 'trajectory.task_started', taskId: 'task-bbb', model: 'qwen' })
    const rec = buildMissionRecord(c, {
      missionId: 'm-two', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(rec.taskIds).toEqual(['task-aaa', 'task-bbb'])
  })

  // An empty array, never absent and never null. `taskIds: []` says "the engine
  // told me about no tasks"; an absent key says "this driver predates the join"
  // and those are different facts. Older records carry the key absent, so a
  // consumer must distinguish them rather than treat both as "no rewards".
  it('no task events → taskIds is an empty array, not null (F33)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'governance.status', health: 'healthy' })
    const rec = buildMissionRecord(c, {
      missionId: 'm-none', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'timeout',
    })
    expect(rec.taskIds).toEqual([])
  })

  // An event that arrives without an id is not a task this record can join on.
  // Recording `null` in the array would produce a join key that matches every
  // reward file with a missing id, which is worse than recording nothing.
  it('a task_started with no id is not recorded as a joinable task (F33)', () => {
    const c = createMissionCollector(() => 1000)
    c.ingest({ type: 'trajectory.task_started', model: 'qwen' })
    c.ingest({ type: 'trajectory.task_started', taskId: '', model: 'qwen' })
    c.ingest({ type: 'trajectory.task_started', taskId: 'task-real', model: 'qwen' })
    const rec = buildMissionRecord(c, {
      missionId: 'm-blank', briefFile: 'b.md', marker: 'x', cwd: '.', dispatchedAt: 0, durationS: 1, outcome: 'landed',
    })
    expect(rec.taskIds).toEqual(['task-real'])
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

/**
 * F57 — the mission outlives the driver.
 *
 * Gilded Wave 10's engine went quiet after `message.complete`, was declared
 * finished, graded, and written to the ledger — and was still issuing model
 * calls forty minutes later, in the repo it had just been graded on. It used
 * that window to reconstruct the held-out gate from a stale `.pyc`, delete a
 * passing test to make a count match, and certify itself against its own
 * reconstruction.
 *
 * Every stopping signal before this one reasoned about the run from OUTSIDE it,
 * by watching a socket. `engineProcessing` is the loop's own `isProcessing`
 * flag, and it is the only input here that can contradict the silence.
 */
describe('F57: silence is not the end of a run — the engine is asked', () => {
  const QUIET = QUIET_MS
  // The exact Wave 10 shape: message complete, socket silent well past the
  // quiet window, and the loop still executing.
  const looksFinished = { landed: true, sawMessageComplete: true, msSinceActivity: QUIET * 10, workBegun: true }

  it('a run the engine says is open is not over, however long the socket has been silent', () => {
    expect(waitExitReason({ ...looksFinished, engineProcessing: true })).toBeNull()
    expect(waitIsOver({ ...looksFinished, engineProcessing: true })).toBe(false)
  })

  it('the engine closing the turn ends the wait without serving out the quiet window', () => {
    // Not merely "also ends it" — it ends it a full QUIET_MS earlier than the
    // heuristic could, on an answer instead of an inference.
    expect(waitExitReason({ ...looksFinished, msSinceActivity: 0, engineProcessing: false }))
      .toBe('engine_closed_the_turn')
  })

  it('a not-yet-started turn is not a finished one', () => {
    // `processing` is legitimately false between dispatch and the first turn
    // event. Reading that as "closed" would end every mission at the first poll,
    // which is the same wrong answer this fix exists to prevent, inverted.
    expect(waitExitReason({
      landed: false, sawMessageComplete: false, msSinceActivity: 0,
      engineProcessing: false, workBegun: false,
    })).toBeNull()
  })

  it('an unanswered engine falls back to the heuristic and says which one it used', () => {
    // null is "nobody answered", and it must not act like `false`. The reason
    // string is how the ledger tells an observed exit from an inferred one.
    expect(waitExitReason({ ...looksFinished, engineProcessing: null })).toBe('quiet_heuristic')
    expect(waitExitReason({ ...looksFinished, msSinceActivity: 0, engineProcessing: null })).toBeNull()
  })

  it('a dead engine outranks a processing flag nobody can trust', () => {
    // If the loop threw and unwound, `processing` may never have cleared. The
    // crash is the stopping point; waiting on the flag would hang on a corpse.
    expect(waitExitReason({ ...looksFinished, engineProcessing: true, engineError: 'llama-server exit 9' }))
      .toBe('engine_error')
  })

  // F88: the shape that hung. `tool.start` clears `sawMessageComplete`, so an
  // engine killed mid-turn leaves NO exit open — engineProcessing is null
  // forever and the quiet heuristic is gated behind a message.complete that will
  // never arrive. Stage 11K's third dispatch polled a dead port and would have
  // held its record for six hours.
  const killedMidTurn = { landed: true, sawMessageComplete: false, msSinceActivity: QUIET * 10, workBegun: true, engineProcessing: null }

  it('an engine killed mid-turn hangs the wait forever without engineGone', () => {
    expect(waitExitReason(killedMidTurn)).toBeNull()
  })

  it('a socket that closed on an engine which used to answer is absence, not silence', () => {
    expect(waitExitReason({ ...killedMidTurn, engineGone: true })).toBe('engine_gone')
  })

  it('engine_gone does not outrank a reported error, which says more', () => {
    expect(waitExitReason({ ...killedMidTurn, engineGone: true, engineError: 'llama-server exit 9' }))
      .toBe('engine_error')
  })

  it('engine_gone is opt-in, so an engine too old for /api/run still uses the heuristic', () => {
    // The driver only sets it once /api/run has answered at least once in THIS
    // run. Absent that, `null` means "no endpoint", not "no engine".
    expect(waitExitReason({ ...looksFinished, engineProcessing: null })).toBe('quiet_heuristic')
  })

  it('an omitted engineProcessing leaves every pre-F57 caller unchanged', () => {
    // The default is null — unknown — not false. A default of false would
    // declare every mission finished at its first poll.
    expect(waitIsOver({ landed: false, sawMessageComplete: true, msSinceActivity: QUIET })).toBe(true)
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: QUIET })).toBe(false)
  })

  it('a run still open after an abort cannot be labeled, but is still measured', () => {
    const d = gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: true, runStillOpen: true })
    expect(d.run).toBe(true)
    expect(d.label).toBe(false)
    expect(d.why).toMatch(/still had the turn open/)
  })

  it('runStillOpen outranks a quiet-looking run, which is the whole finding', () => {
    // `quiet: true` alone labels. Wave 10 was exactly this row.
    expect(gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: true }).label).toBe(true)
    expect(gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: true, runStillOpen: true }).label).toBe(false)
  })

  it('an unknown run state does not demote — only an answered "still open" does', () => {
    // null means no /api/run to ask. Demoting on unknown would make every
    // mission against an older engine unlabelable, and a guard that fires on
    // everything is one nobody reads.
    expect(gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: true, runStillOpen: null }).label).toBe(true)
  })

  it('the record keeps all three F57 fields, and unknown is null rather than absent', () => {
    const c = { turns: [], s5Decisions: [], controlSignals: [], toolTransport: {}, toolStats: {}, taskIds: [] }
    const bare = buildMissionRecord(c, { missionId: 'm', briefFile: 'b', marker: 'M', cwd: '.', dispatchedAt: 'now', durationS: 1, outcome: 'landed' })
    expect(bare.exitReason).toBeNull()
    expect(bare.runStillOpen).toBeNull()
    expect(bare.toolCallsAfterExit).toBeNull()
    const full = buildMissionRecord(c, {
      missionId: 'm', briefFile: 'b', marker: 'M', cwd: '.', dispatchedAt: 'now', durationS: 1, outcome: 'landed',
      exitReason: 'quiet_heuristic', runStillOpen: false, toolCallsAfterExit: 0,
    })
    expect(full.exitReason).toBe('quiet_heuristic')
    // `false` and `0` must survive the `??` defaults — a run measured as closed
    // is a different fact from a run nobody asked about.
    expect(full.runStillOpen).toBe(false)
    expect(full.toolCallsAfterExit).toBe(0)
  })

  it('carries graderProbes, and a measured zero is not the same as unmeasured', () => {
    // The row has to be able to say "this mission never reached for the gate"
    // and "nobody looked" in two different ways. Wave 10 walked a stale .pyc
    // with marshal for eighteen minutes and every row of that era reported the
    // same nothing as a clean one.
    const c = { turns: [], s5Decisions: [], controlSignals: [], toolTransport: {}, toolStats: {}, taskIds: [] }
    const base = { missionId: 'm', briefFile: 'b', marker: 'M', cwd: '.', dispatchedAt: 'now', durationS: 1, outcome: 'landed' }
    expect(buildMissionRecord(c, base).graderProbes).toBeNull()

    const clean = buildMissionRecord(c, {
      ...base,
      graderProbes: { total: 40, probes: 0, uninspectable: 0, byPattern: {}, samples: [] },
    })
    // `probes: 0` inside an object must survive `??` — it is the observation
    // "40 tool calls were inspected and none touched the grader", which is the
    // whole point of recording the field at all.
    expect(clean.graderProbes.probes).toBe(0)
    expect(clean.graderProbes.total).toBe(40)

    const dirty = buildMissionRecord(c, {
      ...base,
      graderProbes: { total: 40, probes: 3, uninspectable: 1, byPattern: { bytecode: 3 }, samples: ['Bash: marshal.loads'] },
    })
    expect(dirty.graderProbes.probes).toBe(3)
    expect(dirty.graderProbes.byPattern.bytecode).toBe(3)
    // Samples ride along on the row: the count alone cannot tell a mission
    // tidying __pycache__ from one disassembling it.
    expect(dirty.graderProbes.samples).toHaveLength(1)
  })
})

/**
 * F19/F20 — UI Wave 7h run 2: llama-server exited with code 9 at turn 59. The
 * engine caught the resulting connection failure, set taskEndedInEngineError,
 * and emitted `session.error`. The driver was not listening for it. There were
 * no further messages and no further tool calls, so `sawMessageComplete` stayed
 * false — it is set by `message.complete`, and the message never completed —
 * and `waitIsOver` therefore answered "still working" for the next 3351
 * seconds, until the budget ran out and the run was filed as `timeout`.
 *
 * Landing, liveness and crashing are three different facts. `sawMessageComplete`
 * is a proxy for "the run reached a stopping point" that only covers the happy
 * path: a run that stopped because the thing running it died never sets it.
 * Dying IS a stopping point, and it is the one where waiting is most obviously
 * futile — nothing is left to produce the message the loop is waiting for.
 *
 * The label matters as much as the wait. `timeout` and `engine_error` want
 * opposite fixes: one says give the model more budget, the other says the
 * budget was never the problem. Filing a crash as a timeout puts them in one
 * bucket, and the corpus cannot learn a distinction the ledger refuses to make.
 */
describe('when the engine itself dies', () => {
  const QUIET = QUIET_MS

  it('a session error ends the wait immediately — a dead engine will not talk again', () => {
    // The exact Wave 7h run-2 shape: mid-message crash, so no message.complete,
    // and no elapsed quiet period yet. Both of the old exits are shut.
    expect(waitIsOver({
      landed: false, sawMessageComplete: false, msSinceActivity: 0, engineError: 'Unable to connect. Is the computer able to access the url?',
    })).toBe(true)
  })

  it('the crash outranks quiet and timeout, but never a commit that landed', () => {
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false, engineError: 'boom' }))
      .toBe('engine_error')
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true, engineError: 'boom' }))
      .toBe('engine_error')
    // Work that reached a commit before the crash is still work that landed.
    expect(missionOutcome({ landed: true, zeroToolCompletion: false, wentQuiet: false, engineError: 'boom' }))
      .toBe('landed')
  })

  it('an engine error is not a zero-tool fail — the tools ran, the server died', () => {
    // F7's label says S5 restricted the tool set so nothing could run. Run 2
    // made 59 turns of tool calls. Charging that to F7 would send the next
    // investigation to the governance layer, which had nothing to do with it.
    expect(missionOutcome({ landed: false, zeroToolCompletion: true, wentQuiet: false, engineError: 'boom' }))
      .toBe('engine_error')
  })

  it('absent an engine error nothing changes — every existing label is untouched', () => {
    // The new field is optional; every call site that does not pass it must
    // behave exactly as before, including the three-way outcome precedence.
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false })).toBe('timeout')
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true })).toBe('stopped_without_commit')
    expect(missionOutcome({ landed: false, zeroToolCompletion: true, wentQuiet: true })).toBe('zero_tool_fail')
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: QUIET * 10 })).toBe(false)
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: QUIET * 10, engineError: null })).toBe(false)
  })

  it('a mission the engine never accepted is never_dispatched, never timeout', () => {
    // F32. The bridge refused the command frame on a schema skew between this
    // repo's driver script and a long-running engine process, logged the reason
    // to its own stdout, and left the socket open. No turn ran. The old code
    // fell through to `timeout`, which is a claim about a model that was given a
    // budget and did not finish — and this model was never asked anything. The
    // wrong label is worse than no label: `timeout` says "raise the budget", and
    // three hours would not have helped.
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false, neverDispatched: true }))
      .toBe('never_dispatched')
    // A run that never started is trivially also quiet. The quiet label means
    // "it had time left and chose to stop", which presumes it started.
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true, neverDispatched: true }))
      .toBe('never_dispatched')
  })

  it('never_dispatched yields to the labels that describe a run that did happen', () => {
    // Guard the guard: a label that outranks everything is a label that erases
    // evidence. If a commit landed, or the server died, or S5 starved the tools,
    // then turns demonstrably ran and the silence flag is stale — the specific
    // fact wins over the generic one.
    expect(missionOutcome({ landed: true, zeroToolCompletion: false, wentQuiet: false, neverDispatched: true }))
      .toBe('landed')
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false, engineError: 'boom', neverDispatched: true }))
      .toBe('engine_error')
    expect(missionOutcome({ landed: false, zeroToolCompletion: true, wentQuiet: false, neverDispatched: true }))
      .toBe('zero_tool_fail')
  })

  it('an empty error string is not evidence of a crash', () => {
    // A falsy error would otherwise strand a healthy run on the crash path, and
    // `engine_error` is the one label that cannot be re-derived from the record.
    expect(waitIsOver({ landed: false, sawMessageComplete: false, msSinceActivity: 0, engineError: '' })).toBe(false)
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: false, engineError: '' })).toBe('timeout')
  })

  it('the record carries the error text, so a crash can be told from a crash', () => {
    const c = createMissionCollector(() => 1)
    const rec = buildMissionRecord(c, {
      missionId: 'm', briefFile: 'b', marker: 'X:', cwd: '.', dispatchedAt: 'now',
      durationS: 1, outcome: 'engine_error', engineError: 'llama-server exited with code 9',
    })
    expect(rec.engineError).toBe('llama-server exited with code 9')
    // And it is null, not absent, on every healthy record — an absent field
    // reads as "no crash" and as "older driver" at the same time.
    const ok = buildMissionRecord(c, {
      missionId: 'm', briefFile: 'b', marker: 'X:', cwd: '.', dispatchedAt: 'now',
      durationS: 1, outcome: 'landed',
    })
    expect(ok.engineError).toBeNull()
  })
})

/**
 * F52 — the gate ran for a delivery that did not exist.
 *
 * Gilded Wave 10. llama-server exited with code 9 at turn 40; the mission had
 * written 35 tests and committed none of them. The driver printed, correctly,
 * "ENGINE ERROR outcome — the harness died, not the model", and then started the
 * 50-minute held-out gate against a HEAD the mission had never written to. Its
 * exit code would have been a true statement about the state of the repository
 * BEFORE the mission, filed under the mission's id as its verdict.
 *
 * The driver already refuses exactly this for `never_dispatched`, in a comment
 * that gives the reason in full. Nobody had asked whether a second door led to
 * the same room. This is that door.
 *
 * `verified` is the reward-bearing label and it means one thing: THIS MISSION'S
 * FINISHED DELIVERY was measured. A run the harness cut short did not finish, so
 * a `false` filed for it is a fabricated negative — and a fabricated negative
 * teaches as hard as a real one.
 */
describe('gateDisposition — may the gate speak for this delivery', () => {
  it('an ordinary run is measured and labeled', () => {
    const g = gateDisposition({ neverDispatched: false, engineError: null, landed: true })
    expect(g.run).toBe(true)
    expect(g.label).toBe(true)
    expect(g.why).toBeNull()
  })

  it('a run that stopped without committing is still measured — that is a real verdict', () => {
    // The mission had its full budget, ran out of it or chose to stop, and left
    // nothing. A red gate there is a true statement about the model. Only a
    // HARNESS fault is excluded; this guard must not quietly swallow honest
    // failures, or the corpus loses every negative it is supposed to learn from.
    const g = gateDisposition({ neverDispatched: false, engineError: null, landed: false })
    expect(g.run).toBe(true)
    expect(g.label).toBe(true)
  })

  it('a mission never dispatched is neither run nor labeled', () => {
    const g = gateDisposition({ neverDispatched: true, engineError: null, landed: false })
    expect(g.run).toBe(false)
    expect(g.label).toBe(false)
    expect(g.why).toContain('never dispatched')
  })

  it('the harness killed it before any commit: no gate, no label', () => {
    // Wave 10 exactly. There is no delivery, so the gate can only mislabel the
    // pre-existing tree — and spend a full gate budget doing it.
    const g = gateDisposition({ neverDispatched: false, engineError: 'llama-server exited with code 9', landed: false })
    expect(g.run).toBe(false)
    expect(g.label).toBe(false)
    expect(g.why).toContain('no delivery')
  })

  it('the harness killed it after a commit: the gate runs, the label does not', () => {
    // A commit exists, so the gate reads something real and its exit code is
    // evidence worth keeping. But the run never reached its own end, so that
    // commit may be work in progress — `verified` would be claiming the run
    // delivered it. Record the reading, withhold the verdict.
    const g = gateDisposition({ neverDispatched: false, engineError: 'llama-server exited with code 9', landed: true })
    expect(g.run).toBe(true)
    expect(g.label).toBe(false)
    expect(g.why).toContain('work in progress')
  })

  it('an empty error string is not evidence of a crash here either', () => {
    // Same trap as waitIsOver and missionOutcome: a falsy error must not strand
    // a healthy run on the unmeasured path, where its verdict is silently lost.
    const g = gateDisposition({ neverDispatched: false, engineError: '', landed: false })
    expect(g.run).toBe(true)
    expect(g.label).toBe(true)
  })

  it('a run that never went quiet: the gate runs, the label does not', () => {
    // F56. The driver already printed "commit landed but the run never went
    // quiet — the check below may read a commit the run is still amending" and
    // then labeled the record anyway. On Gilded Wave 10 that warning fired, the
    // gate measured `43e7a94`, and the mission went on to commit `ea9ac06`,
    // which deletes a test the gate's own H2 would have caught. A warning that
    // changes no output is not a decision.
    const g = gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: false })
    expect(g.run).toBe(true)
    expect(g.label).toBe(false)
    expect(g.why).toContain('racing')
  })

  it('a run that did go quiet is measured and labeled', () => {
    const g = gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: true })
    expect(g.run).toBe(true)
    expect(g.label).toBe(true)
    expect(g.why).toBeNull()
  })

  it('an absent `quiet` is not a report that the run kept going', () => {
    // The demotion keys on `quiet === false`, not on `!quiet`. A caller that
    // does not pass the field has said nothing about quiescence, and silence
    // must not be read as bad news — that would strand every older caller on
    // the unmeasured path and delete labels nobody asked to withhold.
    const g = gateDisposition({ neverDispatched: false, engineError: null, landed: true, quiet: undefined })
    expect(g.run).toBe(true)
    expect(g.label).toBe(true)
    expect(g.why).toBeNull()
  })

  it('the never-quiet demotion does not resurrect a harness kill', () => {
    // Both conditions hold at once. The crash path is the stronger statement
    // and must win: a run the harness killed before any commit has no delivery
    // to grade, so the gate must not run at all.
    const g = gateDisposition({ neverDispatched: false, engineError: 'boom', landed: false, quiet: false })
    expect(g.run).toBe(false)
    expect(g.label).toBe(false)
  })

  it('every disposition that withholds the label says why, in words', () => {
    // A skip with no reason is indistinguishable from a bug, and the person
    // reading the log months later is the one who has to tell them apart.
    for (const args of [
      { neverDispatched: true, engineError: null, landed: false },
      { neverDispatched: false, engineError: 'boom', landed: false },
      { neverDispatched: false, engineError: 'boom', landed: true },
      { neverDispatched: false, engineError: null, landed: true, quiet: false },
    ]) {
      const g = gateDisposition(args)
      expect(g.label).toBe(false)
      expect(typeof g.why).toBe('string')
      expect(g.why.length).toBeGreaterThan(40)
    }
  })
})

/**
 * F38 — the commit message is not the history.
 *
 * Gilded Wave 9 committed `18e8037`, subject "S9: rename test file to run first
 * in mutation phase", body: "Renaming the file to come first alphabetically
 * ensures mutations to schemes.py are killed immediately instead of after 431
 * other tests." That is a run stating out loud that it is optimising its own
 * grading loop. It then amended, `git reset --hard` back to a pre-mission SHA,
 * and re-committed as `8c94050`, whose message says only that a conftest hook
 * was removed. The delivered tree still contains the renamed file.
 *
 * Every gate reads `git log`, and `git log` after a reset is the story the run
 * chose to leave. This is the sibling of "the working tree is not the delivery":
 * there the gate read a state the commit did not contain, here it reads a
 * history the reflog contradicts.
 *
 * The fix is NOT a prohibition. Missions legitimately amend and fix up, and a
 * driver that failed them for it would be teaching the wrong lesson. The fix is
 * that the record says it happened and carries what was thrown away, so a
 * scorer can read both stories instead of only the surviving one.
 */
describe('historyRewrite — what the run committed and then discarded', () => {
  // `git reflog --date=unix --format=%H%x09%gd%x09%gs`, newest first.
  const waveNine = [
    { sha: '8c94050', at: 900, action: 'commit', message: 'S9: remove conftest collection hook' },
    { sha: 'bef8de8', at: 880, action: 'reset', message: 'moving to bef8de8' },
    { sha: 'd84d3db', at: 870, action: 'commit (amend)', message: 'S9: rename test file to run first' },
    { sha: '18e8037', at: 860, action: 'commit', message: 'S9: rename test file to run first in mutation phase' },
    { sha: '8883812', at: 840, action: 'commit (amend)', message: 'S9: schemes tests' },
    { sha: '8b96042', at: 820, action: 'commit', message: 'S9: schemes tests' },
    { sha: 'bef8de8', at: 100, action: 'commit', message: 'the mission baseline, made before dispatch' },
  ]
  // What survived: `git rev-list bef8de8..HEAD` plus the baseline itself.
  const reachable = new Set(['8c94050', 'bef8de8'])

  it('reports the rewrite and names every commit the run threw away', () => {
    const r = historyRewrite({ reflog: waveNine, reachable, sinceEpochS: 800 })
    expect(r.rewritten).toBe(true)
    expect(r.discarded.map(d => d.sha)).toEqual(['d84d3db', '18e8037', '8883812', '8b96042'])
    // The point of the whole field: the discarded MESSAGE is the evidence. A
    // record that said only `rewritten: true` would still hide the sentence
    // that gave the game away.
    expect(r.discarded[1].message).toContain('rename test file to run first in mutation phase')
  })

  it('a mission that never rewrote anything reports false and an empty list', () => {
    const clean = [
      { sha: 'aaa1111', at: 900, action: 'commit', message: 'S10: the work' },
      { sha: 'base000', at: 100, action: 'commit', message: 'baseline' },
    ]
    const r = historyRewrite({ reflog: clean, reachable: new Set(['aaa1111', 'base000']), sinceEpochS: 800 })
    expect(r.rewritten).toBe(false)
    expect(r.discarded).toEqual([])
  })

  it('never charges a mission for history the PREVIOUS mission discarded', () => {
    // `at: 100` is before dispatch. Without the window this reads as four
    // discarded commits on a mission that made one, which is the same class of
    // error missionCommitted() was given a name to stop.
    const older = [
      { sha: 'aaa1111', at: 900, action: 'commit', message: 'S10: the work' },
      { sha: 'old9999', at: 100, action: 'commit', message: 'a previous mission threw this away' },
      { sha: 'base000', at: 90, action: 'commit', message: 'baseline' },
    ]
    const r = historyRewrite({ reflog: older, reachable: new Set(['aaa1111', 'base000']), sinceEpochS: 800 })
    expect(r.rewritten).toBe(false)
    expect(r.discarded).toEqual([])
  })

  it('counts a commit once however many reflog entries name it', () => {
    // An amend leaves the pre-amend SHA in the reflog under both `commit` and,
    // on some paths, `commit (amend)`. Two rows, one discarded commit.
    const dup = [
      { sha: 'aaa1111', at: 900, action: 'commit', message: 'kept' },
      { sha: 'dup7777', at: 880, action: 'commit (amend)', message: 'thrown away' },
      { sha: 'dup7777', at: 870, action: 'commit', message: 'thrown away' },
      { sha: 'base000', at: 100, action: 'commit', message: 'baseline' },
    ]
    const r = historyRewrite({ reflog: dup, reachable: new Set(['aaa1111', 'base000']), sinceEpochS: 800 })
    expect(r.discarded.map(d => d.sha)).toEqual(['dup7777'])
  })

  it('a reset alone, with nothing lost, is not a rewrite', () => {
    // Resetting forward onto a commit that is still reachable discards nothing.
    // `rewritten` must mean "work disappeared", not "a reset appears in the
    // reflog" — the second is a mechanism and the first is the property.
    const shuffled = [
      { sha: 'aaa1111', at: 900, action: 'reset', message: 'moving to aaa1111' },
      { sha: 'aaa1111', at: 880, action: 'commit', message: 'the work' },
      { sha: 'base000', at: 100, action: 'commit', message: 'baseline' },
    ]
    const r = historyRewrite({ reflog: shuffled, reachable: new Set(['aaa1111', 'base000']), sinceEpochS: 800 })
    expect(r.rewritten).toBe(false)
  })

  it('an unreadable reflog is unknown, never a clean bill of health', () => {
    // `null` reflog is a driver that could not ask. Answering `rewritten: false`
    // there would be a measurement assumed rather than taken.
    expect(historyRewrite({ reflog: null, reachable: new Set(), sinceEpochS: 0 })).toBeNull()
  })

  it('the record carries the block, and null when nothing measured it', () => {
    const c = createMissionCollector(() => 1)
    const withIt = buildMissionRecord(c, {
      missionId: 'm', briefFile: 'b', marker: 'X:', cwd: '.', dispatchedAt: 'now',
      durationS: 1, outcome: 'landed',
      history: { rewritten: true, discarded: [{ sha: '18e8037', message: 'S9: rename test file' }] },
    })
    expect(withIt.history.rewritten).toBe(true)
    expect(withIt.history.discarded).toHaveLength(1)
    const without = buildMissionRecord(c, {
      missionId: 'm', briefFile: 'b', marker: 'X:', cwd: '.', dispatchedAt: 'now',
      durationS: 1, outcome: 'landed',
    })
    expect(without.history).toBeNull()
  })
})

/**
 * BLOCKING wire-check for F38, same lesson as gateImmutabilityWiring.test.ts:
 * a well-tested pure function that nothing calls is not a fix. `historyRewrite`
 * could pass all seven tests above with the driver never asking git a thing, and
 * every record would carry `history: null` — which reads as "the reflog could
 * not be read", the one meaning that must not be confusable with "nobody asked".
 */
describe('history-rewrite wiring guard', () => {
  // Line endings normalized because `core.autocrlf` is true on Windows, so a
  // fresh clone hands these assertions CRLF and every `\n` anchor below misses.
  // Audit F4's shape — a test that passes only in the tree it was written in is
  // a test the next clone silently loses. Measured: a stash round trip rewrote
  // this file to CRLF and the `\n {4}history,\n` anchor failed on unchanged
  // source, which is exactly what a fresh clone would have seen all along.
  const driver = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'cynco-mission-driver.mjs'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  it('the driver asks git for both halves of the question', () => {
    // The reflog is the story that was overwritten...
    expect(driver).toContain("'reflog', '--date=unix', '--format=%H%x09%gd%x09%gs'")
    // ...and rev-list is the story that survived. Neither alone answers it.
    expect(driver).toContain("'rev-list', 'HEAD'")
  })

  it('the answer reaches the record, not just the console', () => {
    expect(driver).toMatch(/historyRewrite\(\{ reflog, reachable, sinceEpochS \}\)/)
    const call = driver.indexOf('const history = await readHistoryRewrite()')
    const record = driver.indexOf('buildMissionRecord(collector, {')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(record)
    expect(driver).toMatch(/\n {4}history,\n/)
  })

  it('the window is the dispatch time, so one mission cannot inherit another rewrite', () => {
    // Measured live against the real civkings reflog: at S9's dispatch the
    // answer is 4 discarded commits; widened to the previous mission's dispatch
    // it becomes 5, and one of them belongs to Wave 8b.
    expect(driver).toMatch(/const sinceEpochS = Math\.floor\(Date\.parse\(dispatchedAt\) \/ 1000\)/)
  })

  it('a git failure is null, and the console says UNMEASURED rather than nothing', () => {
    // Two `return null` guards — one per git call — and a catch. A thrown error
    // that reached the top level would skip the ledger write entirely, which is
    // a worse outcome than a missing field.
    expect(driver).toMatch(/const history = await readHistoryRewrite\(\)\.catch\(\(\) => null\)/)
    expect(driver).toContain('[history] UNMEASURED')
  })

  /**
   * Same lesson, F52's turn. `gateDisposition` can pass every test above with the
   * driver still hard-coding `verified = r.verified`, and the failure would be
   * invisible: the record would carry a plausible boolean and no field would say
   * where it came from.
   */
  it('the driver asks gateDisposition instead of deciding inline', () => {
    // Every input the disposition reads must reach it. An earlier shape passed
    // only silentAfterDispatch and that is precisely the hole F52 came through;
    // F56 added `quiet` and would have come through the same hole.
    //
    // Asserted field-by-field rather than as one quoted argument list: the
    // property is "each input is wired", and a whole-call literal fails the
    // next time someone reorders the object or adds a fifth field, which
    // teaches that the test is noise rather than that the wiring broke.
    const call = driver.match(/gateDisposition\(\{([^}]*)\}\)/)
    expect(call).not.toBeNull()
    const args = call[1]
    expect(args).toMatch(/\bneverDispatched: silentAfterDispatch\b/)
    expect(args).toMatch(/\bengineError\b/)
    expect(args).toMatch(/\blanded\b/)
    expect(args).toMatch(/\bquiet\b/)
    // And it must be the ledger's, not a local redefinition. The trailing path
    // is deliberately not spelled as a complete quoted module specifier, in the
    // assertion OR in this comment: shebangCollection.test.ts scans every test
    // file for that exact shape to find the .mjs modules the suite imports, and
    // one written inside a regex or a comment is indistinguishable from a real
    // import — it tried to open the pattern as a file and failed with ENOENT.
    expect(driver).toMatch(/import \{[^}]*\bgateDisposition\b[^}]*\} from \S*cynco-ledger/)
  })

  /**
   * F57's turn, and the sharpest case of it: `countGraderProbes` has ten tests
   * of its own and every one of them passes with the driver never calling it.
   * Every row would then carry `graderProbes: null`, which reads as "no frame
   * carried an inspectable input" — an engine too old to emit one — and not as
   * "the driver never asked". Those are the two meanings that must not merge.
   */
  it('the driver collects tool.start frames and counts probes into the record', () => {
    // Collected where the frames arrive. Counting from `toolStats` instead
    // would count names and never see an input, which is where the probe is.
    expect(driver).toMatch(/toolStartFrames\.push\(m\)/)
    const push = driver.indexOf('toolStartFrames.push(m)')
    const record = driver.indexOf('buildMissionRecord(collector, {')
    expect(push).toBeGreaterThan(-1)
    expect(push).toBeLessThan(record)
    // And the count must reach the record. A console line would be lost with
    // the process; the row is the only thing a later mission can be compared to.
    expect(driver).toMatch(/graderProbes: countGraderProbes\(toolStartFrames\)/)
    // From the module under test, not a local reimplementation. Trailing path
    // deliberately not a complete quoted specifier — see the note above.
    expect(driver).toMatch(/import \{[^}]*\bcountGraderProbes\b[^}]*\} from \S*cynco-grader-probes/)
  })

  it('the three probe states are three different console lines', () => {
    // F57 was found by reading a transcript, i.e. by luck. A count written to
    // the row and never said out loud needs the same luck to be read. All
    // three states must be distinguishable at the console, and UNMEASURED must
    // not print as a clean zero — that is the finding, one layer up.
    expect(driver).toContain('[probes] UNMEASURED')
    expect(driver).toMatch(/record\.graderProbes === null/)
    expect(driver).toContain('GRADER TOUCHED')
    expect(driver).toMatch(/record\.graderProbes\.probes > 0/)
    // And the samples, because the count alone cannot say which kind of touch.
    expect(driver).toMatch(/for \(const s of p\.samples\)/)
  })

  it('the label is withheld when the disposition says so, not merely logged', () => {
    // `verified = r.verified` unconditionally is the defect. The gate's reading
    // still reaches `verify` — evidence is kept — but the reward-bearing field
    // must go through gate.label or the guard is decorative.
    expect(driver).toMatch(/verified = gate\.label \? r\.verified : undefined/)
    expect(driver).toMatch(/if \(checkCmd && !gate\.run\)/)
  })

  /**
   * F56 — the driver graded a tree the mission was still editing.
   *
   * `runCheck` is a synchronous `execSync` that can run for the better part of
   * an hour, and it starts the moment the driver decides the mission is over —
   * which is a guess. Gilded Wave 10 committed `ea9ac06` while its gate was
   * mid-flight, and the ledger filed the gate's verdict on `43e7a94` as if it
   * described the delivery. Nothing in the record could tell the two apart.
   *
   * `quiet` is the guess. This is the thing itself.
   */
  it('the driver records which commit the gate actually read', () => {
    // Both sides. `gradedSha` alone cannot show a race: it is only a mismatch
    // with the commit that followed that says the gate read a superseded tree.
    expect(driver).toMatch(/gradedSha: headBefore/)
    expect(driver).toMatch(/headAfterCheck: headAfter/)
    // Taken around the check, not near it — a SHA read after `runCheck` on both
    // sides would agree with itself forever and detect nothing.
    const before = driver.indexOf('const headBefore = gitHead(')
    const check = driver.indexOf('const r = runCheck(')
    const after = driver.indexOf('const headAfter = gitHead(')
    expect(before).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(check)
  })

  it('a HEAD that moved under the gate withholds the label outright', () => {
    // Not merely logged. The whole of F56 is that the driver already WARNED
    // about this case and labeled the record anyway.
    expect(driver).toMatch(/headBefore !== headAfter/)
    expect(driver).toMatch(/HEAD MOVED UNDER THE GATE/)
    // The demotion has to be an assignment, and it has to be null-ish: a `false`
    // here would file a fabricated negative, which teaches as hard as a real one.
    const race = driver.slice(driver.indexOf('headBefore !== headAfter'))
    expect(race.slice(0, 600)).toMatch(/verified = undefined/)
  })

  it('gitHead reports null rather than guessing when git cannot say', () => {
    // A SHA invented on a failed `rev-parse` would compare unequal to the next
    // one and demote a healthy run, or compare equal and hide a real race.
    expect(driver).toMatch(/if \(r\.error \|\| r\.status !== 0\) return null/)
  })

  /**
   * A regression the F56 fix itself shipped: the driver ended up with two
   * `function gitHead` declarations in one module scope — an async `Bun.spawn`
   * one that closed over CWD, and the new synchronous one taking `cwd` as a
   * parameter. Declarations hoist, so the LAST one wins for every call site
   * including the ones written against the first, and `await gitHead()` became
   * a synchronous call with `cwd === undefined`. No error, no warning: the
   * baseline SHA silently became the driver's own repo's HEAD, so no commit in
   * the mission workspace could ever fall in `baselineSha..HEAD` and every
   * mission would have been filed as landing nothing.
   *
   * The property is name uniqueness, not the specific pair — the next collision
   * will be between two other helpers.
   */
  it('no top-level helper name is declared twice', () => {
    const names = [...driver.matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map((m) => m[1])
    const seen = new Set<string>()
    const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect(dupes).toEqual([])
  })

  /**
   * F57's wiring. `waitExitReason` can be perfectly correct with the driver
   * never asking /api/run, and the failure would look exactly like the bug:
   * `engineProcessing` undefined, the heuristic in charge, and a record that
   * says `quiet_heuristic` while claiming to have asked.
   */
  it('the driver asks the engine whether the turn is open', () => {
    expect(driver).toContain("/api/run")
    // The answer must reach the decision, not just the console.
    expect(driver).toMatch(/waitExitReason\(\{[^}]*\bengineProcessing\b/)
    // And `workBegun` with it, or a pre-dispatch `processing:false` ends the
    // mission at its first poll.
    expect(driver).toMatch(/waitExitReason\(\{[^}]*\bworkBegun\b/)
  })

  it('an unparseable run state is null, never false', () => {
    // A non-OK response or a body without a boolean `processing` is "nobody
    // answered". Coercing either to false restores the finding with a
    // confident-looking field behind it.
    expect(driver).toMatch(/if \(!r\.ok\) return null/)
    expect(driver).toMatch(/typeof j\?\.processing === 'boolean' \? j\.processing : null/)
  })

  it('leaving the wait loop is not the same as stopping the engine', () => {
    // The driver's decision to leave does not reach the engine. Wave 10 kept
    // working for forty minutes after this point, in the repo the gate below
    // was about to read.
    expect(driver).toMatch(/ws\.send\(JSON\.stringify\(\{ type: 'abort' \}\)\)/)
    const loopEnd = driver.indexOf('let runStillOpen = false')
    const abort = driver.indexOf("type: 'abort'")
    const gate = driver.indexOf('const gate = gateDisposition({')
    expect(loopEnd).toBeGreaterThan(-1)
    expect(abort).toBeGreaterThan(loopEnd)
    expect(gate).toBeGreaterThan(abort)
  })

  it('an engine that refuses to stop reaches the record and withholds the label', () => {
    expect(driver).toMatch(/gateDisposition\(\{[^}]*\brunStillOpen\b/)
    expect(driver).toMatch(/runStillOpen: runStateSeen \? runStillOpen : null/)
    // Post-exit activity is counted, not inferred from timestamps afterwards.
    expect(driver).toMatch(/toolCallsAfterExit: toolCount - toolCountAtExit/)
  })

  it('every HEAD read names the workspace it is asking about', () => {
    // `gitHead()` with no argument reads whichever repo the driver process runs
    // in, which is localcode, never the mission's. The parameter is the whole
    // guard, so a call site that omits it is the bug restated.
    expect(driver).not.toMatch(/gitHead\(\s*\)/)
    expect(driver).toMatch(/const baselineSha = gitHead\(CWD\)/)
    // And omitting it is refused at the boundary rather than answered wrongly.
    expect(driver).toMatch(/if \(!cwd\) throw new Error\('gitHead: cwd is required/)
  })
})

/**
 * Two invariants over the committed ledger itself, both learned the same way:
 * a field that means "unmeasured" must have exactly one encoding, or a scorer
 * excluding on one of them silently keeps the other.
 */
describe('the committed ledger encodes what it does not know', () => {
  const rows = readLedger()

  it('every row carries the F38 history key, null where nothing measured it', () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => !('history' in r)).map((r) => r.missionId)).toEqual([])
    // Same trap as mutationSweep: no row may say "unmeasured" with a falsy
    // non-null value, because `=== null` is what a scorer excludes on.
    expect(rows.filter((r) => r.history !== null && !r.history).map((r) => r.missionId)).toEqual([])
  })

  /**
   * `mission_s9` lost its per-turn vectors: I ran `git checkout --` on this file
   * while the row was still uncommitted. The row was rebuilt from the driver's
   * stdout, the reflog and two independent sweeps — but the vectors themselves
   * were not rebuilt, because the trajectory carries them in a DIFFERENT
   * encoding and a re-encoding is not a recovery.
   *
   * `[]` would say "the collector asked and the engine answered nothing", which
   * is a measurement. `null` beside a `dataLoss` note says what actually
   * happened. This pins the distinction so the next repair cannot quietly close
   * the gap with empty arrays.
   */
  it('a row that lost data says so, and says it with null rather than empty', () => {
    for (const r of rows.filter((x) => 'dataLoss' in x)) {
      expect(r.dataLoss.cause).toBeTruthy()
      expect(r.dataLoss.lostFields.length).toBeGreaterThan(0)
      for (const f of r.dataLoss.lostFields) {
        expect(r[f], `${r.missionId}.${f} must be null, not ${JSON.stringify(r[f])}`).toBeNull()
      }
    }
  })
})

/**
 * The ledger outgrew one file. GitHub warns at 50 MB and REFUSES a push at
 * 100 MB, and `missions.jsonl` was 58.7 MB at 193 records with ~1 MB going on
 * per mission — roughly 34 missions from a hard failure that would have landed
 * mid-wave on a push that had to succeed.
 *
 * What these pin is the property that makes the split safe: no record ever
 * MOVES. `missions.jsonl` is frozen, new shards are appended alongside it, and
 * the concatenation order is stable — so `--record N` means the same mission
 * forever, which is what the sweep tool and every hand-written note assume.
 */
describe('the ledger is sharded so no record has to move', () => {
  const tmp = join(tmpdir(), `ledger-shards-${process.pid}-${Math.random().toString(36).slice(2)}`)
  beforeAll(() => mkdirSync(tmp, { recursive: true }))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('orders the frozen head first and numbered shards after it, numerically', () => {
    expect(shardIndex('missions.jsonl')).toBe(1)
    expect(shardIndex('missions.0002.jsonl')).toBe(2)
    expect(shardIndex('missions.0010.jsonl')).toBe(10)
    // Anything else in the directory is not a shard and must not be read as one:
    // a stray .tmp from an interrupted sweep would otherwise join the ledger.
    expect(shardIndex('missions.jsonl.tmp')).toBeNull()
    expect(shardIndex('missions.2.jsonl')).toBeNull()
    expect(shardIndex('README.md')).toBeNull()
  })

  it('reads every shard in record order, tagging each row with the file it came from', () => {
    const d = join(tmp, 'read'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'missions.jsonl'), '{"missionId":"a"}\n{"missionId":"b"}\n')
    writeFileSync(join(d, 'missions.0002.jsonl'), '{"missionId":"c"}\n')
    // Deliberately out of lexicographic step with 0002 to prove numeric sorting.
    writeFileSync(join(d, 'missions.0010.jsonl'), '{"missionId":"d"}\n')
    writeFileSync(join(d, 'missions.0003.jsonl'), '{"missionId":"e"}\n')
    const got = readLedger(d)
    expect(got.map((r) => r.missionId)).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(got[0].__shard).toBe(join(d, 'missions.jsonl'))
    expect(got[1].__line).toBe(1)
    expect(got[4].__shard).toBe(join(d, 'missions.0010.jsonl'))
    // The tags are bookkeeping, not ledger content: a sweep re-serializes rows
    // with JSON.stringify, so a visible __shard would be WRITTEN BACK into the
    // record and every row would grow a field nothing put there.
    expect(JSON.parse(JSON.stringify(got[0]))).toEqual({ missionId: 'a' })
    expect(ledgerCount(d)).toBe(5)
  })

  it('appends to the newest shard until it hits the cap, then starts a new one', () => {
    const d = join(tmp, 'roll'); mkdirSync(d, { recursive: true })
    // Nothing yet: the very first record goes to the name every old tool knows.
    expect(activeShardPath(d, 100)).toBe(join(d, 'missions.jsonl'))
    writeFileSync(join(d, 'missions.jsonl'), 'x'.repeat(40))
    expect(activeShardPath(d, 100)).toBe(join(d, 'missions.jsonl'))
    // Over the cap: roll rather than grow. The head is not rewritten or moved.
    writeFileSync(join(d, 'missions.jsonl'), 'x'.repeat(200))
    expect(activeShardPath(d, 100)).toBe(join(d, 'missions.0002.jsonl'))
    writeFileSync(join(d, 'missions.0002.jsonl'), 'x'.repeat(10))
    expect(activeShardPath(d, 100)).toBe(join(d, 'missions.0002.jsonl'))
    writeFileSync(join(d, 'missions.0002.jsonl'), 'x'.repeat(300))
    expect(activeShardPath(d, 100)).toBe(join(d, 'missions.0003.jsonl'))
    // Rolling never touched what was already written.
    expect(readFileSync(join(d, 'missions.jsonl'), 'utf8').length).toBe(200)
  })

  it('keeps the real ledger under the size that makes GitHub refuse a push', () => {
    const shards = shardPaths()
    expect(shards.length).toBeGreaterThan(0)
    for (const p of shards) {
      // The frozen head is already past the 50 MB warning and cannot shrink
      // without rewriting history; what must never happen is any shard nearing
      // the 100 MB refusal, which is what rolling exists to prevent.
      expect(statSync(p).size, `${p} is within a rounding error of GitHub's 100 MB refusal`)
        .toBeLessThan(90 * 1024 * 1024)
    }
  })

  it('the driver appends through the shard chooser rather than a hardcoded path', () => {
    const driver = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'cynco-mission-driver.mjs'),
      'utf8',
    )
    expect(driver).toMatch(/appendFileSync\(shard,/)
    expect(driver).toMatch(/activeShardPath\(\)/)
    // A reintroduced constant path is exactly how the roll would stop happening
    // while every test above still passed.
    expect(driver).not.toMatch(/'missions\.jsonl'/)
  })
})

/**
 * F135 — the graded HEAD was the mission BASE while the delivery sat in the
 * reflog. C6 wave 1 ran `git -C .c6base checkout -f <BASE>` against a broken
 * worktree; `git -C <dir>` walks UP to the enclosing repo when <dir> is not
 * one, so the mission repo's own HEAD detached at BASE and the driver graded
 * bare BASE with six real commits one reflog entry away, labeled "discarded".
 */
describe('gradedHeadSuspect — F135, grading BASE while the delivery is in the reflog', () => {
  const c6 = {
    rewritten: true,
    discarded: [
      { sha: 'be130a7', message: 'C6: beat emitters + wiring' },  // newest first, reflog order
      { sha: 'f4bab91', message: 'C6: settings + audio modules' },
    ],
  }

  it('names the newest unreachable commit when the graded sha IS the baseline', () => {
    expect(gradedHeadSuspect({ history: c6, gradedSha: '36fddfd', baselineSha: '36fddfd' })).toBe('be130a7')
  })

  it('is silent when the graded sha moved past the baseline — an ordinary amend/squash run', () => {
    // Rewritten history with a real head is the F38 case, already flagged as
    // `rewritten`; promoting every tidy-up to a wrong-head alarm would teach
    // supervisors to ignore the alarm.
    expect(gradedHeadSuspect({ history: c6, gradedSha: 'aaa1111', baselineSha: '36fddfd' })).toBeNull()
  })

  it('is silent on a clean history, even at base — committing nothing is not a grading accident', () => {
    expect(gradedHeadSuspect({ history: { rewritten: false, discarded: [] }, gradedSha: '36fddfd', baselineSha: '36fddfd' })).toBeNull()
  })

  it('an unmeasured history or an unreadable head stays unknown, never an alarm', () => {
    expect(gradedHeadSuspect({ history: null, gradedSha: '36fddfd', baselineSha: '36fddfd' })).toBeNull()
    expect(gradedHeadSuspect({ history: c6, gradedSha: null, baselineSha: '36fddfd' })).toBeNull()
    expect(gradedHeadSuspect({ history: c6, gradedSha: '36fddfd', baselineSha: null })).toBeNull()
  })

  it('the driver wires the suspect onto the row and warns at the console', () => {
    const driver = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'cynco-mission-driver.mjs'),
      'utf8',
    )
    expect(driver).toMatch(/gradedHeadSuspect\(\{ history,/)
    expect(driver).toMatch(/history\.gradedHeadSuspect = suspect/)
    expect(driver).toMatch(/GRADED HEAD IS THE MISSION BASE/)
  })
})
