import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  progressCadence, everyMsFor, probeProgress, probeIo, probeGateTimeoutMs, shadowNoProgress, shadowStalled, runnerRowsFrom, progressLine, progressTracker, seedGateMs,
  STALLED_AT, STALLED_RULE, STALLED_WINDOW,
  PROGRESS_EVERY_MS_DEFAULT, PROBE_GATE_TIMEOUT_UNMEASURED_MS, PROBE_GATE_MS_ASSUMED,
} from '../cynco-campaign-progress.mjs'
import { runnerRowsFromCampaigns } from '../cynco-runner-rows.mjs'
import { defaultIo as campaignIo } from '../cynco-campaign.mjs'
import { buildProgressRepo, removeProgressRepos, PROGRESS_GATE } from './fixtures/progress/repo.mjs'

// Review M4: every temp dir this file creates is removed when it is done.
const tempDirs = []
afterAll(() => {
  removeProgressRepos()
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// The fixed reading shape (Global Constraints); the reused start grade adds
// exactly one key, `reusedFrom`.
const READING_KEYS = ['at', 'durationMs', 'elapsedFraction', 'failIds', 'fails', 'passes', 'sha']
const REUSED_KEYS = [...READING_KEYS, 'reusedFrom'].sort()

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
    expect(progressCadence({ everyMs: 30 * MIN, clockMs, nowMs: clockMs }).due).toBe(false)
  })

  // Final review M4: with no measured gate (a pre-Phase-6 calibration and no
  // last grade) the tail and the probe's cap assume a 600 s gate, so a probe
  // started at the edge of the tail cannot hold the WAIT past the wave's end.
  it('an unmeasured gate assumes PROBE_GATE_MS_ASSUMED (600 s) for the tail and the cap, and says so', () => {
    expect(PROBE_GATE_MS_ASSUMED).toBe(600_000)
    const clockMs = 8 * HOUR
    const c = (nowMs) => progressCadence({ everyMs: 30 * MIN, clockMs, gateMs: null, lastAtMs: 0, nowMs })
    expect(c(clockMs - 1_200_001).due).toBe(true)
    const late = c(clockMs - 1_200_000)
    expect(late.due).toBe(false)
    expect(late.reason).toBe('within the last 2 × 600 s assumed gate runtime of the 480 min wall clock (gate unmeasured)')
    expect(progressCadence({ everyMs: 30 * MIN, clockMs, nowMs: 10 * MIN }).reason).toMatch(/gate unmeasured \(600 s assumed for the tail and the cap\)/)
    // The cap never outlasts the tail: a probe started just before it ends by the clock's end.
    expect(probeGateTimeoutMs(null)).toBe(2 * PROBE_GATE_MS_ASSUMED)
    expect(PROBE_GATE_TIMEOUT_UNMEASURED_MS).toBe(2 * PROBE_GATE_MS_ASSUMED)
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
    expect(Object.keys(r0).sort()).toEqual(READING_KEYS)
    expect(r0.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r0.durationMs).toBeGreaterThanOrEqual(0)
    const r1 = probeProgress({ spec, sha: shas[1], lastSha: shas[0], elapsedMs: 4 * HOUR, clockMs: 8 * HOUR, n: 2 })
    expect(r1).toMatchObject({ sha: shas[1], fails: 1, passes: 2, failIds: ['P.3'], elapsedFraction: 0.5 })
    expect(Object.keys(r1).sort()).toEqual(READING_KEYS)
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
    expect(r.fault).toBe('gate printed an error; exit 3')
    expect(existsSync(join(tmpdir(), `cynco-progress-${spec.id}-3`))).toBe(false)
  }, 60_000)

  // Final review M2: the runner's log is the one mid-wave copy of a reading
  // outside runner memory, and the fault line is logged. It carries the fault
  // CLASS and the exit code — never the gate's stdout or stderr.
  it('a fault reading carries no gate output (the fixture gate prints a marker on its way out)', () => {
    const logs = []
    const t = progressTracker({ spec, probe: undefined, headOf: () => shas[3], clockMs: 8 * HOUR, startSha: shas[0], startFails: 3,
      dispatchedAtMs: 0, everyMs: 30 * MIN, log: (m) => logs.push(m) })
    const r = t.onTick({ nowMs: 30 * MIN })
    expect(r.fault).toBeTruthy()
    expect(r.fault).not.toContain('GATE-OUTPUT-MARKER')
    expect(r.fault).not.toContain('boom')
    expect(logs.join('\n')).not.toContain('GATE-OUTPUT-MARKER')
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

// Phase 7 ruling 2: the second shadow rule, `R2.stalled` — no decrease over the
// last three MEASURED ticks, at ≥ 25 % of the clock, with the latest count > 0.
describe('shadowStalled (R2.stalled, shadow)', () => {
  const tick = (min, fails, fault = false) => ({ at: new Date(min * 60_000).toISOString(), fails: fault ? null : fails, fault: fault ? 'gate died' : null, elapsedFraction: min / 480 })
  const clockMs = 8 * HOUR

  it('names its rule, threshold and window', () => {
    expect([STALLED_RULE, STALLED_AT, STALLED_WINDOW]).toEqual(['R2.stalled', 0.25, 3])
  })

  it('fires at ≥ 25 % of the clock when the last three measured ticks never decreased and the latest is > 0', () => {
    const decisions = [tick(46, 20), tick(92, 16), tick(139, 16), tick(186, 16)]
    const d = shadowStalled({ readings: [], decisions, clockMs, nowMs: 186 * 60_000, at: decisions.at(-1).at })
    expect(d).toEqual({ rule: 'R2.stalled', at: decisions.at(-1).at, elapsedFraction: 0.388, fired: true, window: [16, 16, 16], fails: 16, wouldHaveSavedS: 17640 })
  })

  it('does not fire before 25 %, on a decrease inside the window, at 0 fails, or with fewer than three measured ticks', () => {
    expect(shadowStalled({ readings: [], decisions: [tick(46, 20), tick(92, 20), tick(100, 20)], clockMs, nowMs: 100 * 60_000 }).fired).toBe(false)
    // The window is the LAST three: 20 → 18 drops out of it once a fourth tick lands.
    expect(shadowStalled({ readings: [], decisions: [tick(46, 20), tick(92, 18), tick(139, 18), tick(186, 18)], clockMs, nowMs: 186 * 60_000 })).toMatchObject({ fired: true, window: [18, 18, 18] })
    expect(shadowStalled({ readings: [], decisions: [tick(46, 20), tick(139, 18), tick(186, 18)], clockMs, nowMs: 186 * 60_000 })).toMatchObject({ fired: false, window: [20, 18, 18] })
    expect(shadowStalled({ readings: [], decisions: [tick(139, 0), tick(186, 0), tick(232, 0)], clockMs, nowMs: 232 * 60_000 }).fired).toBe(false)
    expect(shadowStalled({ readings: [], decisions: [tick(139, 16), tick(186, 16)], clockMs, nowMs: 186 * 60_000 })).toMatchObject({ fired: false, window: [16, 16] })
  })

  it('a fault inside the window is skipped, not counted as a measurement', () => {
    const d = shadowStalled({ readings: [], decisions: [tick(46, 16), tick(92, 16), tick(139, 0, true), tick(186, 16)], clockMs, nowMs: 186 * 60_000 })
    expect(d).toMatchObject({ fired: true, window: [16, 16, 16] })
  })

  it('an unknown clock is unmeasured (null), never a firing', () => {
    const d = shadowStalled({ readings: [], decisions: [tick(46, 16), tick(92, 16), tick(139, 16)], clockMs: null, nowMs: 139 * 60_000 })
    expect(d).toMatchObject({ fired: false, elapsedFraction: null, wouldHaveSavedS: null, fails: 16 })
    expect(shadowStalled({ readings: [], decisions: [], clockMs, nowMs: 0 })).toMatchObject({ fired: false, window: [], fails: null })
  })
})

describe('runnerRowsFrom', () => {
  const reading = (fails, elapsedFraction) => ({ at: 't', sha: 's', fails, passes: 0, failIds: [], durationMs: 1, elapsedFraction })
  const decision = (fired, elapsedFraction = 0.6) => ({ rule: 'R1.no-progress', at: 't', elapsedFraction, fired, startFails: 3, fails: 3, wouldHaveSavedS: 100 })

  // Review I1: scope is read off the shadow DECISIONS (any at ≥ 50 %, fired or
  // not), never off the readings.
  it('scopes waves with a decision past 50 %; fired = any firing; failed = not a pass', () => {
    const waves = [
      // fired and then PASSED: the rule was wrong.
      { missionId: 'm-pass', decision: { kind: 'pass' }, progress: [reading(3, 0.6)], shadowDecisions: [decision(true)] },
      // fired and did not pass: the rule was right.
      { missionId: 'm-next', decision: { kind: 'next' }, progress: [reading(3, 0.3), reading(3, 0.7)], shadowDecisions: [decision(false, 0.3), decision(true, 0.7)] },
      // a decision past 50 %, never fired, passed with survivors.
      { missionId: 'm-pws', decision: { kind: 'pass-with-survivors' }, progress: [reading(1, 0.8)], shadowDecisions: [decision(false, 0.8)] },
      // its only reading is before 50 %, but a (skip-tick) decision past it
      // fired: IN scope — the no-progress wave the rule exists for.
      { missionId: 'm-skips', decision: { kind: 'budget' }, progress: [reading(3, 0.06)], shadowDecisions: [decision(false, 0.06), decision(true, 0.56)] },
      // decisions only before 50 % (the wave ended early): out of scope.
      { missionId: 'm-early', decision: { kind: 'next' }, progress: [reading(3, 0.3)], shadowDecisions: [decision(false, 0.3)] },
      // no decision at all (adopted — never waited on): out of scope.
      { missionId: 'm-adopted', decision: { kind: 'next' }, progress: null, shadowDecisions: null },
      // a stop never ran; no progress field at all (a pre-Phase 6 record).
      { missionId: null, decision: { kind: 'stop' } },
      { missionId: 'm-old', decision: { kind: 'next' } },
    ]
    const [row, r2, ...rest] = runnerRowsFrom(waves)
    expect(rest).toEqual([])
    expect(r2.id).toBe('R2.stalled')
    // No R2 decision anywhere in these records: R2's scope is empty.
    expect(r2.scope.size).toBe(0)
    expect(row.id).toBe('R1.no-progress')
    expect(row.source).toBe('runner')
    expect([...row.scope].sort()).toEqual(['m-next', 'm-pass', 'm-pws', 'm-skips'])
    expect([...row.fired].sort()).toEqual(['m-next', 'm-pass', 'm-skips'])
    expect([...row.failed].sort()).toEqual(['m-next', 'm-skips'])
  })

  // The reviewer's case, end to end through the tracker: an 8 h clock, HEAD
  // never leaves the start sha, a due tick every 30 min.
  const trackWave = ({ headAt }) => {
    const clockMs = 8 * HOUR
    const probe = { archive: () => ({ ok: true }), runGate: () => ({ terminator: 'MISS', fails: [{ id: 'P.1', line: 'P.1: FAIL' }], passes: [], errors: [], exit: 1, harnessFault: null }), removeDir: () => {} }
    let min = 0
    const t = progressTracker({ spec: { id: 'rr', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => headAt(min), clockMs, startSha: 'START', startFails: 3,
      startFailIds: ['P.1', 'P.2', 'P.3'], startPasses: 0, dispatchedAtMs: 0, everyMs: 30 * MIN, log: () => {} })
    for (min = 30; min < 480; min += 30) t.onTick({ nowMs: min * MIN })
    return { missionId: 'm', decision: { kind: 'budget' }, progress: t.progress, shadowDecisions: t.shadowDecisions }
  }

  it('an 8 h wave that never commits after the start is IN scope and FIRED', () => {
    const wave = trackWave({ headAt: () => 'START' })
    // One reading (the reused start grade at 6 %), every later tick a skip —
    // and yet the rule decided at every tick past 50 %.
    expect(wave.progress).toHaveLength(1)
    expect(wave.progress[0].elapsedFraction).toBeLessThan(0.5)
    expect(wave.shadowDecisions.filter(d => d.fired).length).toBeGreaterThan(0)
    const [row] = runnerRowsFrom([wave])
    expect([...row.scope]).toEqual(['m'])
    expect([...row.fired]).toEqual(['m'])
  })

  it('a wave whose only commit lands before 50 % is in scope', () => {
    // Commits C1 at 90 min (1 fail, below the start's 3) and nothing after.
    const wave = trackWave({ headAt: (min) => (min >= 90 ? 'C1' : 'START') })
    expect(wave.progress.every(r => r.elapsedFraction < 0.5)).toBe(true)
    const [row] = runnerRowsFrom([wave])
    expect([...row.scope]).toEqual(['m'])
    expect(row.fired.size).toBe(0)
  })

  it('keeps the row with an empty scope — TOO FEW is the honest state, not an absent row', () => {
    const [row] = runnerRowsFrom([])
    expect(row.scope.size).toBe(0)
    expect(row.fired.size).toBe(0)
    expect(row.unlabeled).toEqual([])
  })

  // Phase 7 ruling 2: R2.stalled is a second runner row through the same
  // construction, scoped by ITS decisions at ≥ 25 % of the clock.
  it('returns R1 then R2; R2 is scoped, fired and failed off its own decisions, and R1 is unchanged by them', () => {
    const r2 = (fired, elapsedFraction) => ({ rule: 'R2.stalled', at: 't', elapsedFraction, fired, window: [3, 3, 3], fails: 3, wouldHaveSavedS: 100 })
    const waves = [
      // R2 fired at ≥ 25 %, the wave did not pass: R2 was right.
      { missionId: 'w-next', decision: { kind: 'next' }, shadowDecisions: [decision(false, 0.2), r2(false, 0.2), decision(false, 0.3), r2(true, 0.3)] },
      // R2 decided past 25 % and never fired; the wave passed.
      { missionId: 'w-pass', decision: { kind: 'pass' }, shadowDecisions: [decision(false, 0.3), r2(false, 0.3), decision(false, 0.6), r2(false, 0.6)] },
      // adopted: never waited on, no decision at all.
      { missionId: 'w-adopted', decision: { kind: 'next' }, progress: null, shadowDecisions: null },
    ]
    const rows = runnerRowsFrom(waves)
    expect(rows.map(r => r.id)).toEqual(['R1.no-progress', 'R2.stalled'])
    const [r1Row, r2Row] = rows
    expect(r2Row.source).toBe('runner')
    expect([...r2Row.scope].sort()).toEqual(['w-next', 'w-pass'])
    expect([...r2Row.fired]).toEqual(['w-next'])
    expect([...r2Row.failed]).toEqual(['w-next'])
    const [r1Alone] = runnerRowsFrom(waves.map(w => ({ ...w, shadowDecisions: w.shadowDecisions?.filter(d => d.rule === 'R1.no-progress') ?? null })))
    expect(r1Row).toEqual(r1Alone)
    expect([...r1Row.scope]).toEqual(['w-pass'])
  })

  // Final review I1: a VERDICT whose grade did not run (`kind: 'fault'`,
  // `verified: null` — the gate harness-faulted, or the grade never happened)
  // is UNLABELED for R1, as `labelOf` makes it for the S5 rules: out of the
  // scored n, named on the row. A WAIT-timeout fault (the faultWave record, no
  // `verified` field at all — the wave burned its clock) stays a failure.
  it('a grade that did not run is unlabeled and named; a WAIT-timeout fault stays a failure', () => {
    const waves = [
      { missionId: 'm-gradefault', decision: { kind: 'fault', why: 'gate did not run (code ETIMEDOUT, status null, after 7 ms)' }, verified: null, shadowDecisions: [decision(true)] },
      { missionId: 'm-waitfault', decision: { kind: 'fault', why: 'driver did not exit within the wall clock' }, shadowDecisions: [decision(true)] },
      { missionId: 'm-graded', decision: { kind: 'next' }, verified: false, shadowDecisions: [decision(true)] },
    ]
    const [row] = runnerRowsFrom(waves)
    expect([...row.scope].sort()).toEqual(['m-graded', 'm-waitfault'])
    expect([...row.fired].sort()).toEqual(['m-graded', 'm-waitfault'])
    expect([...row.failed].sort()).toEqual(['m-graded', 'm-waitfault'])
    expect(row.unlabeled).toEqual([{ missionId: 'm-gradefault', why: 'the grade did not run — gate did not run (code ETIMEDOUT, status null, after 7 ms)' }])
  })

  // Final review M3: the wave the runner gives up on (`waited.timedOut`) has
  // `missionId: null`; it is keyed `<campaign>#wave<n>` and stays in scope.
  it('a timed-out wave with a null missionId is in scope, keyed <campaign>#wave<n>, and counted failed', () => {
    const campaigns = mkdtempSync(join(tmpdir(), 'rr-campaigns-'))
    tempDirs.push(campaigns)
    mkdirSync(join(campaigns, 'cx'))
    writeFileSync(join(campaigns, 'cx', 'waves.jsonl'), [
      { wave: 1, missionId: 'cx-wave1-1', decision: { kind: 'next' }, verified: false, shadowDecisions: [decision(false)] },
      { wave: 2, missionId: null, decision: { kind: 'fault', why: 'driver did not exit within the wall clock' }, shadowDecisions: [decision(true)] },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    const [row] = runnerRowsFromCampaigns(campaigns)
    expect([...row.scope].sort()).toEqual(['cx#wave2', 'cx-wave1-1'])
    expect([...row.fired]).toEqual(['cx#wave2'])
    expect([...row.failed].sort()).toEqual(['cx#wave2', 'cx-wave1-1'])
  })

  // Task 4 review N2: a malformed record with no missionId is named by where
  // it lives — `<campaign>/waves.jsonl line <n>` — not by its index in the
  // combined list of every campaign's records.
  it('a malformed record is named <campaign>/waves.jsonl line <n>', () => {
    const campaigns = mkdtempSync(join(tmpdir(), 'rr-campaigns-'))
    tempDirs.push(campaigns)
    for (const [name, records] of [['ca', [{ wave: 1, missionId: 'ca-1', decision: { kind: 'next' } }]],
      ['cb', [{ wave: 1, missionId: 'cb-1', decision: { kind: 'next' } }, { wave: 2, missionId: null, decision: { kind: 'next' }, shadowDecisions: {} }, 'not a record']]]) {
      mkdirSync(join(campaigns, name))
      writeFileSync(join(campaigns, name, 'waves.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n')
    }
    const [row] = runnerRowsFromCampaigns(campaigns)
    expect(row.skipped).toEqual(['cb/waves.jsonl line 2', 'cb/waves.jsonl line 3'])
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
    // A record from before Phase 7 has no R2 decision: R2 is named, not evaluated.
    expect(progressLine(rec)).toBe('- Progress: 14 → 3 fails over 3 readings (first fix at 41 min; last at 210 min: 3); R1.no-progress fired at 52% (would have saved 3.2 h); R2.stalled not evaluated')
  })

  it('names both rules: R2.stalled at the minute it first fired, with its decision count', () => {
    const r1 = (min) => ({ rule: 'R1.no-progress', at: at(min), elapsedFraction: min / 480, fired: false, startFails: 20, fails: 16, wouldHaveSavedS: (480 - min) * 60 })
    const r2 = (min, fired) => ({ rule: 'R2.stalled', at: at(min), elapsedFraction: min / 480, fired, window: [16, 16, 16], fails: 16, wouldHaveSavedS: (480 - min) * 60 })
    const rec = { dispatchedAt: at(0), progress: [reading(20, 46), reading(16, 92)],
      shadowDecisions: [r1(46), r2(46, false), r1(92), r2(92, false), r1(139), r2(139, false), r1(186), r2(186, true)] }
    expect(progressLine(rec)).toBe('- Progress: 20 → 16 fails over 2 readings (first fix at 92 min; last at 92 min: 16); R1.no-progress did not fire (4 decision(s)); R2.stalled fired at 186 min (4 decision(s))')
    const quiet = { ...rec, shadowDecisions: rec.shadowDecisions.map(d => ({ ...d, fired: false })) }
    expect(progressLine(quiet)).toMatch(/; R1\.no-progress did not fire \(4 decision\(s\)\); R2\.stalled did not fire \(4 decision\(s\)\)$/)
  })

  it('names faults, a missing drop and a rule that did not fire', () => {
    const rec = { dispatchedAt: at(0), progress: [reading(5, 30), { at: at(60), fault: 'gate timed out after 860000 ms', durationMs: 860_000 }],
      shadowDecisions: [{ rule: 'R1.no-progress', at: at(30), elapsedFraction: 0.06, fired: false, startFails: 5, fails: 5, wouldHaveSavedS: 1 }] }
    // Task 3 review N2: "1 reading", not "1 readings".
    expect(progressLine(rec)).toBe('- Progress: 5 → 5 fails over 1 reading (no drop; last at 30 min: 5; 1 fault(s)); R1.no-progress did not fire (1 decision(s)); R2.stalled not evaluated')
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
      startPasses: 1, dispatchedAtMs: 0, everyMs: 30 * MIN, log: (m) => logs.push(m) })
    expect(t.onTick({ nowMs: 10 * MIN })).toBeNull() // not due
    expect(t.note()).toMatch(/none taken — next reading at 30 min/)
    const r1 = t.onTick({ nowMs: 30 * MIN })
    // Review M5: the fixed reading shape, plus `reusedFrom` and nothing else.
    expect(r1).toEqual({ at: new Date(30 * MIN).toISOString(), sha: 'START', fails: 2, passes: 1, failIds: ['P.1', 'P.2'], durationMs: 0, elapsedFraction: 0.125, reusedFrom: 'start' })
    expect(Object.keys(r1).sort()).toEqual(REUSED_KEYS)
    expect(gates).toEqual([])
    expect(t.onTick({ nowMs: 60 * MIN })).toEqual({ skipped: 'sha unchanged' })
    head = 'C1'
    const r3 = t.onTick({ nowMs: 125 * MIN })
    expect(r3).toMatchObject({ sha: 'C1', fails: 2, passes: 0, failIds: ['P.1', 'P.2'], elapsedFraction: 0.521 })
    expect(Object.keys(r3).sort()).toEqual(READING_KEYS)
    expect(gates).toHaveLength(1)
    expect(t.progress).toHaveLength(2)
    // Phase 7: both rules decide at every tick, R1 first.
    expect(t.shadowDecisions.map(d => d.rule)).toEqual(['R1.no-progress', 'R2.stalled', 'R1.no-progress', 'R2.stalled', 'R1.no-progress', 'R2.stalled'])
    expect(t.shadowDecisions.filter(d => d.rule === 'R1.no-progress').map(d => d.fired)).toEqual([false, false, true])
    // R2 reads R1's tick series (the skip tick carries the count): [2], [2, 2], [2, 2, 2] at 52 %.
    expect(t.shadowDecisions.filter(d => d.rule === 'R2.stalled').map(d => [d.fired, d.window])).toEqual([[false, [2]], [false, [2, 2]], [true, [2, 2, 2]]])
    expect(logs.join('\n')).toMatch(/\[campaign\] progress @ 125m: 2 fails \(was 2\)/)
    expect(logs.join('\n')).toMatch(/shadow R1\.no-progress FIRED at 52%/)
    expect(logs.join('\n')).toMatch(/shadow R2\.stalled FIRED at 52% \(2, 2, 2 fails over the last 3 measured ticks; would have saved 1\.9 h\) — shadow only, nothing stopped/)
    expect(t.note()).toBeNull()
  })

  it('a faulted tick is not a measurement for R2 — the stale count R1 carries is left out of the window', () => {
    let fault = false
    const probe = { archive: () => (fault ? { ok: false, problems: ['boom'] } : { ok: true }), runGate: () => gateOut(2), removeDir: () => {} }
    let head = 'START'
    const t = progressTracker({ spec: { id: 'trk-f', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => head, clockMs, startSha: 'START', startFails: 2, startFailIds: ['P.1', 'P.2'],
      startPasses: 1, dispatchedAtMs: 0, everyMs: 30 * MIN, log: () => {} })
    t.onTick({ nowMs: 30 * MIN }) // start grade reused: 2
    head = 'C1'; fault = true
    t.onTick({ nowMs: 60 * MIN }) // archive faulted
    fault = false
    t.onTick({ nowMs: 120 * MIN }) // back-off ×2 → due at 120: C1 graded, 2
    const r1 = t.shadowDecisions.filter(d => d.rule === 'R1.no-progress')
    const r2 = t.shadowDecisions.filter(d => d.rule === 'R2.stalled')
    expect(r1.map(d => d.fails)).toEqual([2, 2, 2])
    expect(r2.map(d => d.window)).toEqual([[2], [2], [2, 2]])
    expect(r2.at(-1).fired).toBe(false)
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

  // Review M1: the gate runtime the start grade measured seeds the cadence, so
  // the 10 % rule, the end-of-clock tail and the probe's cap hold before the
  // first probe run of the wave (the reused start grade never measures it).
  it('seeds gateMs: the 10 % interval, the tail and the probe cap hold from the first tick', () => {
    const caps = []
    const probe = { archive: () => ({ ok: true }), runGate: (spec, dest, { timeoutMs }) => { caps.push(timeoutMs); return gateOut(1) }, removeDir: () => {} }
    const make = (gateMs) => progressTracker({ spec: { id: 'seed', repo: 'C:/r', gate: 'g.py' }, probe, headOf: () => 'C1', clockMs: 8 * HOUR, startSha: 'START', startFails: 2,
      dispatchedAtMs: 0, everyMs: 30 * MIN, gateMs, log: () => {} })
    const seeded = make(215_000)
    expect(seeded.onTick({ nowMs: 30 * MIN })).toBeNull() // 215 s × 10 = 2150 s ≈ 35.8 min
    expect(seeded.note()).toMatch(/gate 215 s → ≥ 36 min/)
    expect(seeded.onTick({ nowMs: 2_150_000 })).toMatchObject({ sha: 'C1', fails: 1 })
    expect(caps).toEqual([860_000]) // 4 × 215 s, not the unmeasured 30 min
    // The tail: no reading within 2 × 215 s of the 8 h clock, even on the first tick.
    const late = make(215_000)
    expect(late.onTick({ nowMs: 8 * HOUR - 400_000 })).toBeNull()
    expect(late.note()).toMatch(/within the last 2 × 215 s gate runtime/)
    // Unseeded: the first tick at 30 min reads.
    expect(make(null).onTick({ nowMs: 30 * MIN })).toMatchObject({ sha: 'C1' })
  })
})

// Phase 6 fix wave (P-F155): every probe tick's first git spawn follows a gap,
// so bun's stale deadline trips it and runSync's retry line fired every tick.
// The probe's git spawns (HEAD read, archive) hand the line to the tracker,
// which counts it (`retriedSpawns`, on the wave record) and logs it once.
describe('progressTracker — stale-deadline retries are counted, logged once per wave', () => {
  it('counts every retry of the HEAD read and the archive, logs the F155 line once', () => {
    const logs = []
    const LINE = "[spawn] git: an impossible ETIMEDOUT after 6 ms (cap 30000 ms) — bun's stale deadline; retried once and the retry ran (F155)"
    let head = 0
    const headOf = ({ onStaleRetry } = {}) => { onStaleRetry?.(LINE); head += 1; return `C${head}` }
    const probe = { archive: (repo, sha, dest, { onStaleRetry } = {}) => { onStaleRetry?.(LINE); return { ok: true } },
      runGate: () => ({ terminator: 'MISS', fails: [{ id: 'P.1', line: 'P.1: FAIL' }], passes: [], errors: [], exit: 1, harnessFault: null }), removeDir: () => {} }
    const t = progressTracker({ spec: { id: 'f155', repo: 'C:/r', gate: 'g.py' }, probe, headOf, clockMs: 8 * HOUR, startSha: 'START', startFails: 2,
      dispatchedAtMs: 0, everyMs: 30 * MIN, log: (m) => logs.push(m) })
    expect(t.retriedSpawns()).toBe(0)
    for (const min of [30, 60, 90]) t.onTick({ nowMs: min * MIN })
    expect(t.retriedSpawns()).toBe(6)
    const f155 = logs.filter(l => l.includes('F155'))
    expect(f155).toEqual([`${LINE} — further stale-deadline retries this wave are counted on the wave record (retriedSpawns), not logged`])
  })

  it('the probe archive retries an impossible ETIMEDOUT once, into a fresh dir, and reports it', () => {
    const calls = [], fresh = [], retried = []
    const io = probeIo({
      calibrate: { freshDir: (p) => fresh.push(p),
        run: (cmd, args) => { calls.push(args); return calls.length === 1 ? { status: null, stdout: '', stderr: '', fault: { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', elapsedMs: 6 } } : { status: 0, stdout: '', stderr: '' } } },
      grade: { run: () => ({ status: 1, stdout: 'P.1: FAIL x\nGATE: MISS (1 fails)\n', stderr: '' }) },
    })
    expect(io.archive('C:/r', 'abc', 'C:/tmp/d', { onStaleRetry: (m) => retried.push(m) })).toEqual({ ok: true, problems: [] })
    expect(calls).toHaveLength(2)
    expect(fresh).toEqual(['C:/tmp/d', 'C:/tmp/d'])
    expect(retried).toHaveLength(1)
    expect(retried[0]).toMatch(/impossible ETIMEDOUT after 6 ms .*retried once .*\(F155\)/)
    // A real failure (not a stale deadline) is not retried.
    calls.length = 0
    const failing = probeIo({ calibrate: { freshDir: () => {}, run: (cmd, args) => { calls.push(args); return { status: 128, stdout: '', stderr: 'fatal: bad object' } } } })
    expect(failing.archive('C:/r', 'abc', 'C:/tmp/d').ok).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

// Task 3 review N1: a faulted grade's duration is near its timeout (a gate
// that hung for 2 h), and ×10 of it would starve an 8 h wave of readings — so
// only a grade whose gate ran clean seeds gateMs.
describe('seedGateMs', () => {
  it('the last grade\'s gate run when it did not fault, else the calibration\'s BASE run, else null', () => {
    expect(seedGateMs({ lastGrade: { gate: { durationMs: 215_000, harnessFault: null } }, calibration: { baseGateMs: 200_000 } })).toBe(215_000)
    expect(seedGateMs({ lastGrade: { gate: { durationMs: 7_190_000, harnessFault: 'gate timed out after 7200000 ms' } }, calibration: { baseGateMs: 200_000 } })).toBe(200_000)
    expect(seedGateMs({ lastGrade: { gate: { durationMs: 7_190_000, harnessFault: 'gate timed out after 7200000 ms' } }, calibration: {} })).toBeNull()
    expect(seedGateMs({ calibration: { baseGateMs: 200_000 } })).toBe(200_000)
    expect(seedGateMs({})).toBeNull()
    expect(seedGateMs(null)).toBeNull()
  })
})

describe('defaultIo.waitForDriver — the onTick seam', () => {
  it('calls onTick every poll, logs a repeated tick fault once, and the wait goes on', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'camp-pid-'))
    tempDirs.push(pidDir)
    const pidFile = join(pidDir, 'driver.pid')
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
