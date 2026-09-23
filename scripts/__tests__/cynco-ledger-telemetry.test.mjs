import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createMissionCollector, buildMissionRecord } from '../cynco-ledger.mjs'
import { bashEffect } from '../../engine/tools/bashEffect.js'

/**
 * The verb classes exist because "delivery" measured as Edit+Write was
 * misleading: in 11N, Write outnumbered Edit 3:1 and nearly every Write was a
 * scratch file (base_realm.py, probe_*.py). Source edits and file creation are
 * different acts and must be counted separately.
 */
describe('toolStats verb classes', () => {
  it('counts source edits separately from writes and reads', () => {
    const c = createMissionCollector()
    for (const name of ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Read']) {
      c.observeToolCall({ name, isError: false })
    }
    expect(c.toolStats.total).toBe(6)
    expect(c.toolStats.byClass.sourceEdit).toBe(1)
    expect(c.toolStats.byClass.fileWrite).toBe(1)
    expect(c.toolStats.byClass.inspect).toBe(4)
  })

  it('tracks the largest run of calls with no source edit', () => {
    const c = createMissionCollector()
    for (const name of ['Edit', 'Read', 'Read', 'Read', 'Edit', 'Read']) {
      c.observeToolCall({ name, isError: false })
    }
    // gaps between source edits: 0 (leading), 3, then a trailing run of 1
    expect(c.toolStats.maxCallsWithoutSourceEdit).toBe(3)
  })

  it('counts an unknown tool as inspect rather than dropping it', () => {
    const c = createMissionCollector()
    c.observeToolCall({ name: 'SomeFutureTool', isError: false })
    expect(c.toolStats.byClass.inspect).toBe(1)
    expect(c.toolStats.total).toBe(1)
  })
})

describe('commit cadence', () => {
  it('records the longest run of calls with no new commit', () => {
    const c = createMissionCollector()
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Bash', isError: false })
    c.observeCommit('aaaaaaa')       // two calls elapsed before the first commit
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeCommit('bbbbbbb')       // three since
    expect(c.toolStats.commits).toBe(2)
    expect(c.toolStats.maxCallsWithoutCommit).toBe(3)
  })

  it('ignores a repeated HEAD — polling must not invent commits', () => {
    const c = createMissionCollector()
    c.observeCommit('aaaaaaa')
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(1)
  })

  /**
   * The dispatch baseline is the one HEAD the mission did NOT make. Without
   * this seam the driver's very first poll hands `observeCommit` a sha it has
   * never seen and every mission in the ledger reports `commits: 1` — a
   * fabricated delivery, which is a worse failure than the hard 0 this task
   * exists to remove.
   */
  it('does not count the pre-existing HEAD the mission was dispatched on', () => {
    const c = createMissionCollector()
    c.seedBaselineHead('aaaaaaa')
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(0)
    c.observeCommit('bbbbbbb')
    expect(c.toolStats.commits).toBe(1)
  })

  it('leaves the baseline unseeded when HEAD could not be read', () => {
    // gitHead() returns null rather than guessing. Seeding null must not pin
    // _lastHead to a falsy value that then swallows the first real commit.
    const c = createMissionCollector()
    c.seedBaselineHead(null)
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(1)
  })

  it('counts a commit that lands with no tool calls between polls', () => {
    const c = createMissionCollector()
    c.observeCommit('aaaaaaa')
    c.observeCommit('bbbbbbb')
    expect(c.toolStats.commits).toBe(2)
    expect(c.toolStats.maxCallsWithoutCommit).toBe(0)
  })
})

describe('buildMissionRecord probe block', () => {
  const minimalMeta = {
    missionId: 'm-1', briefFile: 'b.txt', marker: 'mk', cwd: 'C:/tmp/x',
    dispatchedAt: '2026-08-28T00:00:00.000Z', durationS: 1, outcome: 'landed',
  }
  it('carries the probe block verbatim and defaults to null', () => {
    const c = createMissionCollector()
    const probe = { command: 'pytest -q', runs: 2, fails: 1, overrides: 1, lastExit: 0, lastVerified: true, exhausted: false, blockedBySocket: 0 }
    const withProbe = buildMissionRecord(c, { ...minimalMeta, probe })
    expect(withProbe.probe).toEqual(probe)
    const without = buildMissionRecord(createMissionCollector(), minimalMeta)
    expect(without.probe).toBeNull()
  })
})

describe('bash effects and invariant blocks', () => {
  it('counts Bash calls by effect using the engine classifier', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'tool.start', toolName: 'Bash', input: { command: 'Get-Content a.py' } })
    c.ingest({ type: 'tool.start', toolName: 'Bash', input: { command: 'git checkout -- a.py' } })
    c.ingest({ type: 'tool.start', toolName: 'Bash', input: { command: 'python -m pytest -q' } })
    expect(c.toolStats.bashByEffect).toEqual({ read: 1, write: 0, run: 1, commit: 0, revert: 1, other: 0 })
    expect(c.toolStats.byClass.inspect).toBe(3)
  })

  it('agrees with the shared vectors', () => {
    const vectors = JSON.parse(readFileSync(new URL('../../engine/tools/bashEffect.vectors.json', import.meta.url), 'utf8'))
    for (const [cls, cmds] of Object.entries(vectors)) for (const cmd of cmds) expect(bashEffect(cmd)).toBe(cls)
  })

  it('keeps the last invariants and ultrastable snapshots on the record', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', invariants: { configuration: 'full', denials: [] }, ultrastable: { trace: [], margin: 0.4 } })
    c.ingest({ type: 'governance.status', health: 'healthy', invariants: { configuration: 'edit-only', denials: [{ invariant: 'edit-gap' }] }, ultrastable: { trace: [{ step: 3 }], margin: -0.1 } })
    const rec = buildMissionRecord(c, { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(rec.invariants.configuration).toBe('edit-only')
    expect(rec.invariants.denials).toHaveLength(1)
    expect(rec.ultrastable.margin).toBe(-0.1)
    const empty = buildMissionRecord(createMissionCollector(), { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(empty.invariants).toBeNull()
    expect(empty.ultrastable).toBeNull()
  })

  // Phase 2b-ii: verify-first routing. Lifted onto the row for the same reason
  // the denial ledger is — `entries[].nextCallClass` is the only record of
  // whether an informed refusal or a measured edit changed what the model did
  // next, and the analysis that asks needs the whole run, not a live frame.
  it('keeps the last verify-first routing snapshot on the record', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', routing: { budget: 6, used: 1, count: 1, byKind: { revert: 1, 'low-confidence-edit': 0 }, byOutcome: { passed: 1 }, entries: [{ callIndex: 4, kind: 'revert', entropy: null, outcome: 'passed', ms: 900, tail: 'ok', nextCallClass: null }] } })
    c.ingest({ type: 'governance.status', health: 'healthy', routing: { budget: 6, used: 2, count: 3, byKind: { revert: 1, 'low-confidence-edit': 2 }, byOutcome: { passed: 1, 'cached-passed': 1, failed: 1 }, entries: [{ callIndex: 4, kind: 'revert', entropy: null, outcome: 'passed', ms: 900, tail: 'ok', nextCallClass: 'sourceEdit' }] } })
    const rec = buildMissionRecord(c, { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(rec.routing.count).toBe(3)
    expect(rec.routing.used).toBe(2)
    expect(rec.routing.byKind['low-confidence-edit']).toBe(2)
    expect(rec.routing.entries[0].nextCallClass).toBe('sourceEdit')
  })

  it('routing is null when the session never routed, and an explicit null stays null', () => {
    const empty = buildMissionRecord(createMissionCollector(), { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(empty.routing).toBeNull()
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', routing: null })
    const rec = buildMissionRecord(c, { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(rec.routing).toBeNull()
  })

  it('keeps the last live POSIWID reading and IdentityGuard verdict on the record', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', posiwidLive: { divergence: 0.02, verdict: 'Consistent', dominantStated: 'inspect', dominantObserved: 'inspect', support: 60 } })
    c.ingest({ type: 'governance.status', health: 'healthy', posiwidLive: { divergence: 0.4, verdict: 'Drifting', dominantStated: 'inspect', dominantObserved: 'inspect', support: 400 } })
    c.ingest({ type: 'governance.session_fidelity', fidelity: null, identityGuard: { passed: true, posiwidPass: false, violations: [], details: ['POSIWID: observed behavior diverges from stated purpose'] } })
    const rec = buildMissionRecord(c, { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(rec.posiwidLive.verdict).toBe('Drifting')
    expect(rec.posiwidLive.support).toBe(400)
    expect(rec.identityGuard.posiwidPass).toBe(false)
    expect(rec.identityGuard.passed).toBe(true)
    const empty = buildMissionRecord(createMissionCollector(), { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' })
    expect(empty.posiwidLive).toBeNull()
    expect(empty.identityGuard).toBeNull()
  })
})

// Task 4 (2a-iii): the Brain's per-turn telemetry (engine/bridge/protocol.ts
// GovernanceStatusEvent.brain), lifted onto the ledger so it can be tested as
// a candidate signal before anything grants it authority.
describe('brain telemetry', () => {
  const meta = { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' }

  it('carries the frame\'s brain object onto each turn, and null when the frame had none', () => {
    const c = createMissionCollector()
    c.ingest({
      type: 'governance.status', health: 'healthy',
      brain: { tier: 'live', layerConvergence: { n: 5, meanAgree: 0.4, meanDepth: 0.3, byLayer: {} }, toolEntropy: { mean: 0.5, max: 0.9, spikeCount: 1 } },
    })
    c.ingest({
      type: 'governance.status', health: 'healthy',
      brain: { tier: 'live', layerConvergence: { n: 5, meanAgree: 0.6, meanDepth: 0.5, byLayer: {} }, toolEntropy: { mean: 0.7, max: 0.95, spikeCount: 2 } },
    })
    c.ingest({ type: 'governance.status', health: 'healthy' })

    const rec = buildMissionRecord(c, meta)
    expect(rec.turns).toHaveLength(3)
    expect(rec.turns[0].brain).toEqual({ tier: 'live', layerConvergence: { n: 5, meanAgree: 0.4, meanDepth: 0.3, byLayer: {} }, toolEntropy: { mean: 0.5, max: 0.9, spikeCount: 1 } })
    expect(rec.turns[1].brain.layerConvergence.meanAgree).toBe(0.6)
    expect(rec.turns[2].brain).toBeNull()
  })

  it('aggregates brainStats equal-weight per turn, tier = last non-null tier', () => {
    const c = createMissionCollector()
    c.ingest({
      type: 'governance.status', health: 'healthy',
      brain: { tier: 'live', layerConvergence: { n: 5, meanAgree: 0.4, meanDepth: 0.3, byLayer: {} }, toolEntropy: { mean: 0.5, max: 0.9, spikeCount: 1 } },
    })
    c.ingest({
      type: 'governance.status', health: 'healthy',
      brain: { tier: 'live', layerConvergence: { n: 5, meanAgree: 0.6, meanDepth: 0.5, byLayer: {} }, toolEntropy: { mean: 0.7, max: 0.95, spikeCount: 2 } },
    })
    c.ingest({ type: 'governance.status', health: 'healthy' })

    const rec = buildMissionRecord(c, meta)
    expect(rec.brainStats).toEqual({
      tier: 'live', turnsWithLens: 2, meanAgree: 0.5, meanDepth: 0.4, meanToolEntropy: 0.6,
    })
  })

  it('brainStats is null when no frame ever carried a brain block', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy' })
    c.ingest({ type: 'governance.status', health: 'healthy' })
    const rec = buildMissionRecord(c, meta)
    expect(rec.brainStats).toBeNull()
  })

  it('an explicit brain: null frame is treated the same as an absent one', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'governance.status', health: 'healthy', brain: null })
    const rec = buildMissionRecord(c, meta)
    expect(rec.turns[0].brain).toBeNull()
    expect(rec.brainStats).toBeNull()
  })
})

// Task 7 (2c-i): operator notes sent to a RUNNING unattended mission
// (engine/bridge/protocol.ts MissionOperatorNoteEvent). Two frames arrive per
// note — queued, then delivered — and the row must carry ONE entry showing
// both, or the queue latency the pair exists to measure is unreadable.
describe('operator notes', () => {
  const meta = { missionId: 'm', briefFile: 'b', marker: 'x', cwd: '.', dispatchedAt: 't', durationS: 1, outcome: 'landed' }

  it('pairs the delivery frame with its queued entry by queuedAt', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'stop editing app.py', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'and run the suite', queuedAt: '2026-09-22T10:00:01.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'stop editing app.py', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: 7 })
    c.ingest({ type: 'mission.operator_note', text: 'and run the suite', queuedAt: '2026-09-22T10:00:01.000Z', deliveredAtIteration: 7 })

    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(2)
    expect(rec.operatorNotes[0].text).toBe('stop editing app.py')
    expect(rec.operatorNotes[0].queuedAt).toBe('2026-09-22T10:00:00.000Z')
    expect(rec.operatorNotes[0].deliveredAtIteration).toBe(7)
    expect(rec.operatorNotes[1].deliveredAtIteration).toBe(7)
  })

  // `queuedAt` is an ISO string with millisecond resolution, and two dashboard
  // sends can land in the same millisecond — so it is NOT unique, and matching
  // on it alone made the second queued frame look like a no-op delivery of the
  // first. What separates the frames is their KIND: a queued frame always
  // starts a new entry, a delivery or a drop fills one in.
  it('keeps two notes queued in the same millisecond apart', () => {
    const c = createMissionCollector()
    const same = '2026-09-22T10:00:00.000Z'
    c.ingest({ type: 'mission.operator_note', text: 'first', queuedAt: same, deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'second', queuedAt: same, deliveredAtIteration: null })

    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes.map(n => n.text)).toEqual(['first', 'second'])
  })

  it('fills same-millisecond entries in the order the delivery frames arrive', () => {
    const c = createMissionCollector()
    const same = '2026-09-22T10:00:00.000Z'
    c.ingest({ type: 'mission.operator_note', text: 'first', queuedAt: same, deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'second', queuedAt: same, deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'first', queuedAt: same, deliveredAtIteration: 4 })
    c.ingest({ type: 'mission.operator_note', text: 'second', queuedAt: same, deliveredAtIteration: 4 })

    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(2)
    expect(rec.operatorNotes[0].deliveredAtIteration).toBe(4)
    expect(rec.operatorNotes[1].deliveredAtIteration).toBe(4)
  })

  // The two drop reasons are different operational facts: too many notes, or
  // too little runway left in the mission.
  it('records why a note was dropped, on the entry it was queued as', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'pushed out', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'stranded', queuedAt: '2026-09-22T10:00:01.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'pushed out', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null, dropped: 'queue full' })
    c.ingest({ type: 'mission.operator_note', text: 'stranded', queuedAt: '2026-09-22T10:00:01.000Z', deliveredAtIteration: null, dropped: 'mission ended' })

    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(2)
    expect(rec.operatorNotes[0].dropped).toBe('queue full')
    expect(rec.operatorNotes[1].dropped).toBe('mission ended')
    expect(rec.operatorNotes[0].deliveredAtIteration).toBeNull()
  })

  it('records a drop frame whose queued frame it never saw', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'late join', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null, dropped: 'mission ended' })
    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(1)
    expect(rec.operatorNotes[0].dropped).toBe('mission ended')
  })

  // Two notes can carry the same words. `queuedAt` is the key precisely so the
  // second one's delivery cannot be written onto the first one's row.
  it('does not collapse two notes with identical text', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'stop', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'stop', queuedAt: '2026-09-22T10:00:05.000Z', deliveredAtIteration: null })
    c.ingest({ type: 'mission.operator_note', text: 'stop', queuedAt: '2026-09-22T10:00:05.000Z', deliveredAtIteration: 3 })

    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(2)
    expect(rec.operatorNotes[0].deliveredAtIteration).toBeNull()
    expect(rec.operatorNotes[1].deliveredAtIteration).toBe(3)
  })

  // A note still in the queue when the mission ended is the interesting case:
  // it must stay on the row as undelivered rather than disappearing.
  it('keeps a queued-but-never-delivered note with deliveredAtIteration null', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'too late', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null })
    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toEqual([
      { t: expect.any(Number), text: 'too late', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: null, dropped: null },
    ])
  })

  // A collector attached mid-mission sees the delivery and never saw the
  // queueing. The note still happened; recording nothing would under-count it.
  it('records a delivery frame whose queued frame it never saw', () => {
    const c = createMissionCollector()
    c.ingest({ type: 'mission.operator_note', text: 'late join', queuedAt: '2026-09-22T10:00:00.000Z', deliveredAtIteration: 12 })
    const rec = buildMissionRecord(c, meta)
    expect(rec.operatorNotes).toHaveLength(1)
    expect(rec.operatorNotes[0].deliveredAtIteration).toBe(12)
  })

  it('is an empty array when nobody sent one — never null', () => {
    const rec = buildMissionRecord(createMissionCollector(), meta)
    expect(rec.operatorNotes).toEqual([])
  })
})
