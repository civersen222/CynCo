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
