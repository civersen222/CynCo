import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  progressCadence, everyMsFor, probeProgress, probeIo, probeGateTimeoutMs, shadowNoProgress, runnerRowsFrom, progressLine, progressTracker,
  PROGRESS_EVERY_MS_DEFAULT, PROBE_GATE_TIMEOUT_UNMEASURED_MS,
} from '../cynco-campaign-progress.mjs'
import { defaultIo as campaignIo } from '../cynco-campaign.mjs'
import { buildProgressRepo, PROGRESS_GATE } from './fixtures/progress/repo.mjs'

const MIN = 60_000
const HOUR = 60 * MIN

describe('progressCadence', () => {
  const saved = process.env.CYNCO_PROGRESS_EVERY_MS
  afterEach(() => { if (saved === undefined) delete process.env.CYNCO_PROGRESS_EVERY_MS; else process.env.CYNCO_PROGRESS_EVERY_MS = saved })

  it('is never due before everyMs since the last reading (the first counts from dispatch)', () => {
    expect(progressCadence({ everyMs: 30 * MIN, clockMs: 8 * HOUR, nowMs: 29 * MIN }).due).toBe(false)
    const first = progressCadence({ everyMs: 30 * MIN, clockMs: 8 * HOUR, nowMs: 30 * MIN })
    expect(first).toMatchObject({ due: true, nextAtMs: 30 * MIN })
    const second = progressCadence({ everyMs: 30 * MIN, clockMs: 8 * HOUR, lastAtMs: 30 * MIN, nowMs: 59 * MIN })
    expect(second).toMatchObject({ due: false, nextAtMs: 60 * MIN })
    expect(second.reason).toMatch(/next reading at 60 min/)
  })

  it('reads CYNCO_PROGRESS_EVERY_MS as the default everyMs, and 30 min without it', () => {
    process.env.CYNCO_PROGRESS_EVERY_MS = String(10 * MIN)
    expect(progressCadence({ clockMs: 8 * HOUR, nowMs: 10 * MIN }).due).toBe(true)
    delete process.env.CYNCO_PROGRESS_EVERY_MS
    expect(progressCadence({ clockMs: 8 * HOUR, nowMs: 10 * MIN }).due).toBe(false)
    expect(progressCadence({ clockMs: 8 * HOUR, nowMs: 10 * MIN }).nextAtMs).toBe(PROGRESS_EVERY_MS_DEFAULT)
  })

  it('raises the interval so a measured gate takes at most 10 % of it (215 s gate → 2150 s)', () => {
    const at = (nowMs) => progressCadence({ everyMs: MIN, clockMs: 8 * HOUR, gateMs: 215_000, nowMs })
    expect(at(2_149_999).due).toBe(false)
    expect(at(2_150_000)).toMatchObject({ due: true, nextAtMs: 2_150_000 })
    // A gate faster than 10 % of everyMs leaves everyMs alone.
    expect(progressCadence({ everyMs: 30 * MIN, clockMs: 8 * HOUR, gateMs: 60_000, nowMs: 30 * MIN }).nextAtMs).toBe(30 * MIN)
  })

  it('backs off ×2 per consecutive fault', () => {
    const c = (faults) => progressCadence({ everyMs: 30 * MIN, clockMs: 8 * HOUR, faults, lastAtMs: 0, nowMs: 0 }).nextAtMs
    expect([c(0), c(1), c(2), c(3)]).toEqual([30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN])
  })

  it('never starts a reading within the last gateMs × 2 of the clock', () => {
    const clockMs = 8 * HOUR
    const c = (nowMs) => progressCadence({ everyMs: 30 * MIN, clockMs, gateMs: 215_000, lastAtMs: 0, nowMs })
    expect(c(clockMs - 430_001).due).toBe(true)
    const late = c(clockMs - 430_000)
    expect(late.due).toBe(false)
    expect(late.reason).toMatch(/within the last 2 × 215 s gate runtime/)
    // Unmeasured gate: the tail is the clock's own end.
    expect(progressCadence({ everyMs: 30 * MIN, clockMs, nowMs: clockMs }).due).toBe(false)
  })

  it('refuses without a wall clock', () => {
    expect(progressCadence({ everyMs: MIN, clockMs: null, nowMs: HOUR })).toMatchObject({ due: false, reason: 'no wall clock to measure against' })
  })

  it('everyMsFor: the spec field first, then the env, then the default; junk is ignored', () => {
    expect(everyMsFor({ progress: { everyMs: 5 * MIN } }, { CYNCO_PROGRESS_EVERY_MS: String(7 * MIN) })).toBe(5 * MIN)
    expect(everyMsFor({}, { CYNCO_PROGRESS_EVERY_MS: String(7 * MIN) })).toBe(7 * MIN)
    expect(everyMsFor({ progress: { everyMs: -1 } }, { CYNCO_PROGRESS_EVERY_MS: 'soon' })).toBe(PROGRESS_EVERY_MS_DEFAULT)
    expect(everyMsFor(undefined, {})).toBe(PROGRESS_EVERY_MS_DEFAULT)
  })
})

describe('probeProgress on a real fixture repo (git archive + the fixture gate)', () => {
  // Four commits: nothing holds (3 fails), P.1+P.2 hold (1 fail), the same
  // contents again (a new sha), and a gate that dies with exit 3.
  const { dir, shas } = buildProgressRepo(['', '1 2', '1 2\n', 'boom'])
  const spec = { id: `ptest${process.pid}`, repo: dir, gate: PROGRESS_GATE }

  it('reads 3 → 1 fails across two commits, on the archive and never the live tree', () => {
    // An uncommitted edit in the live repo that would make every line PASS:
    // a probe that read the working tree would report 0 fails.
    writeFileSync(join(dir, 'progress.txt'), '1 2 3')
    const r0 = probeProgress({ spec, sha: shas[0], elapsedMs: 30 * MIN, clockMs: 8 * HOUR, n: 1 })
    expect(r0).toMatchObject({ sha: shas[0], fails: 3, passes: 0, failIds: ['P.1', 'P.2', 'P.3'], elapsedFraction: 0.063 })
    expect(r0.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r0.durationMs).toBeGreaterThanOrEqual(0)
    const r1 = probeProgress({ spec, sha: shas[1], lastSha: shas[0], elapsedMs: 4 * HOUR, clockMs: 8 * HOUR, n: 2 })
    expect(r1).toMatchObject({ sha: shas[1], fails: 1, passes: 2, failIds: ['P.3'], elapsedFraction: 0.5 })
    // The temp archive is gone after each reading.
    expect(existsSync(join(tmpdir(), `cynco-progress-${spec.id}-1`))).toBe(false)
    expect(existsSync(join(tmpdir(), `cynco-progress-${spec.id}-2`))).toBe(false)
  }, 60_000)

  it('skips an unchanged sha without running anything', () => {
    const calls = []
    const io = { archive: () => { calls.push('archive'); return { ok: true } }, runGate: () => { calls.push('gate'); return {} }, removeDir: () => calls.push('rm') }
    expect(probeProgress({ spec, sha: shas[1], lastSha: shas[1], io })).toEqual({ skipped: 'sha unchanged' })
    expect(calls).toEqual([])
  })

  it('records a gate that exits 3 as { at, fault, durationMs }, never a count', () => {
    const r = probeProgress({ spec, sha: shas[3], elapsedMs: HOUR, clockMs: 8 * HOUR, n: 3 })
    expect(Object.keys(r).sort()).toEqual(['at', 'durationMs', 'fault'])
    expect(r.fault).toMatch(/no GATE: terminator|exited 3/)
    expect(existsSync(join(tmpdir(), `cynco-progress-${spec.id}-3`))).toBe(false)
  }, 60_000)

  it('records an archive that fails as a fault naming the sha', () => {
    const r = probeProgress({ spec, sha: 'deadbeef', n: 4 })
    expect(r.fault).toMatch(/archive of deadbeef failed/)
  }, 60_000)
})

describe('probeIo — the gate runs on the archive, capped, and is never retried', () => {
  const okGate = { status: 1, stdout: 'P.1: FAIL x\nGATE: MISS (1 fails)\n', stderr: '' }
  const fakes = (gateResult) => {
    const gateCalls = []
    const io = probeIo({
      calibrate: { freshDir: () => {}, run: () => ({ status: 0, stdout: '', stderr: '' }) },
      grade: { run: (cmd, args, opts) => { gateCalls.push({ cmd, args, opts }); return gateResult } },
    })
    return { io: { ...io, removeDir: () => {} }, gateCalls }
  }

  it('passes retryImpossibleTimeout: false, cwd and CYNCO_GATE_REPO = the archive, and the measured cap', () => {
    const { io, gateCalls } = fakes(okGate)
    const spec = { id: 'pflags', repo: 'C:/live-repo', gate: 'C:/h/gate_p.py' }
    const r = probeProgress({ spec, sha: 'abc', io, n: 1 })
    expect(r.fails).toBe(1)
    const dest = join(tmpdir(), 'cynco-progress-pflags-1')
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0].opts).toMatchObject({ cwd: dest, env: { CYNCO_GATE_REPO: dest }, retryImpossibleTimeout: false, timeoutMs: PROBE_GATE_TIMEOUT_UNMEASURED_MS })
    probeProgress({ spec, sha: 'def', io, n: 2, gateMs: 215_000 })
    expect(gateCalls[1].opts.timeoutMs).toBe(860_000)
    expect(probeGateTimeoutMs(10 * HOUR)).toBe(7_200_000)
  })

  it('a stale ETIMEDOUT is a fault reading, spawned once', () => {
    const { io, gateCalls } = fakes({ status: null, stdout: '', stderr: '', fault: { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', elapsedMs: 12 } })
    const r = probeProgress({ spec: { id: 'pstale', repo: 'C:/r', gate: 'g.py' }, sha: 'abc', io, n: 1 })
    expect(r.fault).toMatch(/gate did not run \(code ETIMEDOUT/)
    expect(gateCalls).toHaveLength(1)
  })
})

describe('shadowNoProgress (R1.no-progress, shadow)', () => {
  const read = (fails, elapsedFraction) => ({ at: 't', sha: `s${fails}${elapsedFraction}`, fails, passes: 0, failIds: [], durationMs: 1, elapsedFraction })
  const clockMs = 8 * HOUR

  it('does not fire before 50 % of the clock, even with no drop', () => {
    const d = shadowNoProgress({ readings: [read(3, 0.3)], startFails: 3, clockMs, nowMs: 0.49 * clockMs, at: 'now' })
    expect(d).toEqual({ rule: 'R1.no-progress', at: 'now', elapsedFraction: 0.49, fired: false, startFails: 3, fails: 3, wouldHaveSavedS: Math.round(0.51 * 8 * 3600) })
  })

  it('fires past 50 % when the fail count has not dropped, with wouldHaveSavedS = clock left', () => {
    const d = shadowNoProgress({ readings: [read(3, 0.3), read(3, 0.52)], startFails: 3, clockMs, nowMs: 0.52 * clockMs })
    expect(d).toMatchObject({ fired: true, elapsedFraction: 0.52, fails: 3, startFails: 3 })
    expect(d.wouldHaveSavedS).toBe(Math.round(8 * 3600 * 0.48))
  })

  it('does not fire when the count dropped below the start', () => {
    expect(shadowNoProgress({ readings: [read(2, 0.6)], startFails: 3, clockMs, nowMs: 0.6 * clockMs }).fired).toBe(false)
  })

  it('never fires on a fault — the newest reading faulted, the stale count is not read as now', () => {
    const readings = [read(3, 0.4), { at: 't', fault: 'gate timed out', durationMs: 5 }]
    const d = shadowNoProgress({ readings, startFails: 3, clockMs, nowMs: 0.7 * clockMs })
    expect(d.fired).toBe(false)
    expect(d.fails).toBe(3)
  })

  it('reads the latest non-fault reading once a later reading succeeds', () => {
    const readings = [{ at: 't', fault: 'x', durationMs: 1 }, read(4, 0.6)]
    expect(shadowNoProgress({ readings, startFails: 3, clockMs, nowMs: 0.6 * clockMs }).fired).toBe(true)
  })

  it('cannot fire on an unmeasured start or with no reading', () => {
    expect(shadowNoProgress({ readings: [read(3, 0.9)], startFails: null, clockMs, nowMs: 0.9 * clockMs }).fired).toBe(false)
    const none = shadowNoProgress({ readings: [], startFails: 3, clockMs, nowMs: 0.9 * clockMs })
    expect(none).toMatchObject({ fired: false, fails: null })
  })
})

describe('runnerRowsFrom', () => {
  const reading = (fails, elapsedFraction) => ({ at: 't', sha: 's', fails, passes: 0, failIds: [], durationMs: 1, elapsedFraction })
  const fire = (fired) => ({ rule: 'R1.no-progress', at: 't', elapsedFraction: 0.6, fired, startFails: 3, fails: 3, wouldHaveSavedS: 100 })

  it('scopes waves with a reading past 50 % and a decision; fired = any firing; failed = not a pass', () => {
    const waves = [
      // fired and then PASSED: the rule was wrong.
      { missionId: 'm-pass', decision: { kind: 'pass' }, progress: [reading(3, 0.6)], shadowDecisions: [fire(true)] },
      // fired and did not pass: the rule was right.
      { missionId: 'm-next', decision: { kind: 'next' }, progress: [reading(3, 0.3), reading(3, 0.7)], shadowDecisions: [fire(false), fire(true)] },
      // read past 50 %, never fired, passed with survivors.
      { missionId: 'm-pws', decision: { kind: 'pass-with-survivors' }, progress: [reading(1, 0.8)], shadowDecisions: [fire(false)] },
      // only read before 50 %: out of scope.
      { missionId: 'm-early', decision: { kind: 'next' }, progress: [reading(3, 0.3)], shadowDecisions: [fire(false)] },
      // only a FAULT past 50 %: out of scope.
      { missionId: 'm-fault', decision: { kind: 'budget' }, progress: [{ at: 't', fault: 'x', durationMs: 1 }], shadowDecisions: [] },
      // a stop never ran; no progress field at all (a pre-Phase 6 record).
      { missionId: null, decision: { kind: 'stop' } },
      { missionId: 'm-old', decision: { kind: 'next' } },
    ]
    const [row, ...rest] = runnerRowsFrom(waves)
    expect(rest).toEqual([])
    expect(row.id).toBe('R1.no-progress')
    expect(row.source).toBe('runner')
    expect([...row.scope].sort()).toEqual(['m-next', 'm-pass', 'm-pws'])
    expect([...row.fired].sort()).toEqual(['m-next', 'm-pass'])
    expect([...row.failed]).toEqual(['m-next'])
  })

  it('keeps the row with an empty scope — TOO FEW is the honest state, not an absent row', () => {
    const [row] = runnerRowsFrom([])
    expect(row.scope.size).toBe(0)
    expect(row.fired.size).toBe(0)
  })
})

describe('progressLine', () => {
  const t0 = Date.parse('2026-09-29T00:00:00.000Z')
  const at = (min) => new Date(t0 + min * MIN).toISOString()
  const reading = (fails, min) => ({ at: at(min), sha: `s${min}`, fails, passes: 14 - fails, failIds: [], durationMs: 215_000, elapsedFraction: min / 480 })

  it('prints start → last, the first fix, the last reading and the shadow firing', () => {
    const rec = { dispatchedAt: at(0), progress: [reading(14, 30), reading(9, 41), reading(3, 210)],
      shadowDecisions: [{ rule: 'R1.no-progress', at: at(30), elapsedFraction: 0.06, fired: false, startFails: 14, fails: 14, wouldHaveSavedS: 27000 },
        { rule: 'R1.no-progress', at: at(250), elapsedFraction: 0.52, fired: true, startFails: 14, fails: 14, wouldHaveSavedS: 11520 }] }
    expect(progressLine(rec)).toBe('- Progress: 14 → 3 fails over 3 reading(s) (first fix at 41 min; last at 210 min: 3); R1.no-progress fired at 52% (would have saved 3.2 h)')
  })

  it('names faults, a missing drop and a rule that did not fire', () => {
    const rec = { dispatchedAt: at(0), progress: [reading(5, 30), { at: at(60), fault: 'gate timed out after 860000 ms', durationMs: 860_000 }],
      shadowDecisions: [{ rule: 'R1.no-progress', at: at(30), elapsedFraction: 0.06, fired: false, startFails: 5, fails: 5, wouldHaveSavedS: 1 }] }
    expect(progressLine(rec)).toBe('- Progress: 5 → 5 fails over 1 reading(s) (no drop; last at 30 min: 5; 1 fault(s)); R1.no-progress did not fire (1 decision(s))')
  })

  it('prints the reason when there is no reading', () => {
    expect(progressLine({ progress: null, progressNote: 'adopted wave — the runner did not wait on it' })).toBe('- Progress: no readings (adopted wave — the runner did not wait on it)')
    expect(progressLine({ progress: [], progressNote: 'none taken — next reading at 30 min (every 30 min, gate unmeasured)' })).toBe('- Progress: no readings (none taken — next reading at 30 min (every 30 min, gate unmeasured))')
    expect(progressLine({ progress: [{ at: 't', fault: 'archive of abc failed: x', durationMs: 1 }] })).toBe('- Progress: no readings (1 probe(s) faulted: archive of abc failed: x)')
    expect(progressLine({})).toBe('- Progress: no readings (not measured)')
  })
})

describe('progressTracker — the WAIT hook', () => {
  const clockMs = 4 * HOUR
  const gateOut = (fails) => ({ terminator: fails ? 'MISS' : 'PASS', fails: Array.from({ length: fails }, (_, i) => ({ id: `P.${i + 1}`, line: `P.${i + 1}: FAIL` })), passes: [], errors: [], exit: fails ? 1 : 0, harnessFault: null })

  it('reuses the start grade while HEAD sits at the start, skips an unchanged sha, reads a new one, and shadows each', () => {
    let head = 'START'
    const gates = [], logs = []
    const probe = { archive: () => ({ ok: true }), runGate: (spec, dest) => { gates.push(dest); return gateOut(2) }, removeDir: () => {} }
    const t = progressTracker({ spec: { id: 'trk', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => head, clockMs, startSha: 'START', startFails: 2, startFailIds: ['P.1', 'P.2'],
      dispatchedAtMs: 0, everyMs: 30 * MIN, log: (m) => logs.push(m) })
    expect(t.onTick({ nowMs: 10 * MIN })).toBeNull() // not due
    expect(t.note()).toMatch(/none taken — next reading at 30 min/)
    const r1 = t.onTick({ nowMs: 30 * MIN })
    expect(r1).toMatchObject({ sha: 'START', fails: 2, reusedFrom: 'start', durationMs: 0 })
    expect(gates).toEqual([])
    expect(t.onTick({ nowMs: 60 * MIN })).toEqual({ skipped: 'sha unchanged' })
    head = 'C1'
    const r3 = t.onTick({ nowMs: 125 * MIN })
    expect(r3).toMatchObject({ sha: 'C1', fails: 2, elapsedFraction: 0.521 })
    expect(gates).toHaveLength(1)
    expect(t.progress).toHaveLength(2)
    expect(t.shadowDecisions.map(d => d.fired)).toEqual([false, false, true])
    expect(logs.join('\n')).toMatch(/\[campaign\] progress @ 125m: 2 fails \(was 2\)/)
    expect(logs.join('\n')).toMatch(/shadow R1\.no-progress FIRED at 52%/)
    expect(t.note()).toBeNull()
  })

  it('backs off after a fault and never throws out of a tick', () => {
    const probe = { archive: () => ({ ok: false, problems: ['git archive C1 failed: nope'] }), runGate: () => { throw new Error('unreachable') }, removeDir: () => {} }
    const t = progressTracker({ spec: { id: 'trk2', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => 'C1', clockMs, startSha: 'START', startFails: 2, dispatchedAtMs: 0, everyMs: 30 * MIN, log: () => {} })
    expect(t.onTick({ nowMs: 30 * MIN }).fault).toMatch(/archive of C1 failed/)
    // ×2 after one fault: the next reading is due 60 min later, not 30.
    expect(t.onTick({ nowMs: 60 * MIN })).toBeNull()
    expect(t.onTick({ nowMs: 90 * MIN }).fault).toBeTruthy()
    const broken = progressTracker({ spec: { id: 'trk3', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => { throw new Error('git gone') }, clockMs, dispatchedAtMs: 0, everyMs: 30 * MIN, log: () => {} })
    expect(broken.onTick({ nowMs: 30 * MIN }).fault).toMatch(/latest commit not read: git gone/)
  })
})

describe('defaultIo.waitForDriver — the onTick seam', () => {
  it('calls onTick every poll, logs a repeated tick fault once, and the wait goes on', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'camp-pid-')), 'driver.pid')
    writeFileSync(pidFile, `${process.pid}\n`)
    let polls = 0
    const ticks = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await campaignIo.waitForDriver({
        pidFile, driverLog: 'C:/tmp/d.log', timeoutMs: 5_000, pollMs: 1,
        missionIdFrom: () => (++polls >= 5 ? 'c10-wave1-1' : null),
        onTick: (t) => { ticks.push(t); throw new Error('probe exploded') },
      })
      expect(r).toEqual({ exited: true, missionId: 'c10-wave1-1' })
      expect(ticks.length).toBe(3)
      expect(ticks[0]).toEqual({ elapsedMs: expect.any(Number), nowMs: expect.any(Number) })
      const tickErrors = errors.mock.calls.map(c => String(c[0])).filter(m => m.includes('progress tick failed'))
      expect(tickErrors).toEqual(['[campaign] progress tick failed (the wait goes on): probe exploded'])
    } finally { errors.mockRestore() }
  })
})
