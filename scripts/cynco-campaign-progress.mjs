// scripts/cynco-campaign-progress.mjs — Phase 6 rulings 2 and 3: the runner
// grades the wave's latest commit MID-WAVE with the sealed gate, and runs the
// first runner-level regulator, `R1.no-progress`, in SHADOW over the readings.
//
// The gate stays sealed. A reading goes to the wave record (`rec.progress`,
// `rec.shadowDecisions`) and the runner's own log — never a probe message,
// never the brief, never the engine (the Stage 1 rule: a sealed instrument is
// never a probe). The model never gains information it did not have.
//
// A reading is taken on a clean `git archive` of the commit (archiveBase's
// form, exactly as calibrate reads the BASE), never on the live repo the
// mission is editing; the gate spawn is capped and NEVER retried (a 215 s gate
// re-run is not free; a stale ETIMEDOUT mid-wave is a fault reading, F155).
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveBase, defaultIo as calibrateIo } from './cynco-campaign-calibrate.mjs'
import { runGate, GATE_TIMEOUT_MS, defaultIo as gradeIo } from './cynco-campaign-grade.mjs'
import { NO_PROGRESS_AT, NO_PROGRESS_RULE, runnerRowsFrom } from './cynco-runner-rows.mjs'

/** `progress.everyMs` / `CYNCO_PROGRESS_EVERY_MS` when neither says otherwise: 30 min. */
export const PROGRESS_EVERY_MS_DEFAULT = 1_800_000
/** The gate may take at most 10 % of the wave's wall clock: interval ≥ gateMs × 10. */
export const PROGRESS_GATE_SHARE = 0.10
/** No reading starts within the last `gateMs × 2` of the wall clock. */
export const PROGRESS_TAIL_GATES = 2
/** The probe's gate cap before the first reading measured the gate: 30 min. */
export const PROBE_GATE_TIMEOUT_UNMEASURED_MS = 1_800_000
/** The probe's gate cap once measured: this many times the last measured run. */
export const PROBE_GATE_TIMEOUT_FACTOR = 4
// `R1.no-progress`'s name and threshold, and the runner rows the ladder reads
// off the wave records, live in scripts/cynco-runner-rows.mjs — the one
// construction the VERDICT and the rule-verdicts CLI share (Task 4 review I1).
// Re-exported here so every existing caller keeps its import.
export { NO_PROGRESS_AT, NO_PROGRESS_RULE, runnerRowsFrom }

const finitePos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
const round3 = (v) => Math.round(v * 1000) / 1000
const minutes = (ms) => `${Math.round(ms / 60_000)} min`

/**
 * The cadence the runner reads mid-wave, from `spec.progress.everyMs` (Task 5
 * puts it on the loader; read defensively here), then `CYNCO_PROGRESS_EVERY_MS`,
 * then the 30 min default. A non-positive or non-numeric value is ignored.
 */
export function everyMsFor(spec, env = process.env) {
  const fromSpec = spec?.progress?.everyMs
  if (finitePos(fromSpec)) return fromSpec
  const raw = env?.CYNCO_PROGRESS_EVERY_MS
  const fromEnv = raw === undefined || raw === '' ? NaN : Number(raw)
  return finitePos(fromEnv) ? fromEnv : PROGRESS_EVERY_MS_DEFAULT
}

/**
 * Is a reading due? Every time argument is milliseconds on the WAVE's clock
 * (since dispatch): `nowMs` the present, `lastAtMs` the last due tick (null
 * before the first, read as 0 — a reading at dispatch would grade the base the
 * wave was calibrated on), `clockMs` the wave's wall clock
 * (`hoursPerWave × 3600 s`), `gateMs` the gate's last measured run (null
 * until the first reading measured it).
 *
 * - never before `everyMs` since the last reading;
 * - when `gateMs` is known the interval is raised so the gate takes at most
 *   10 % of it (`gateMs / interval ≤ 0.10`; a 215 s gate → ≥ 2150 s);
 * - ×2 per consecutive faulted reading (a broken probe backs off, it does not
 *   hammer the CPU beside a running wave);
 * - never within the last `gateMs × 2` of the clock (a reading that cannot
 *   finish before the wave ends only delays the verdict). With no measured
 *   gate the tail is the clock's own end.
 */
export function progressCadence({ everyMs = Number(process.env.CYNCO_PROGRESS_EVERY_MS ?? PROGRESS_EVERY_MS_DEFAULT), clockMs, gateMs = null, faults = 0, lastAtMs = null, nowMs }) {
  const every = finitePos(everyMs) ? everyMs : PROGRESS_EVERY_MS_DEFAULT
  const gate = finitePos(gateMs) ? gateMs : null
  if (!finitePos(clockMs)) return { due: false, nextAtMs: null, reason: 'no wall clock to measure against' }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { due: false, nextAtMs: null, reason: 'no reading of the wave clock' }
  // `gate / 0.10` is `gate × 10` — written as the product so a 215 000 ms gate
  // gives exactly 2 150 000 and not a float a hair either side of it.
  const floor = gate ? Math.max(every, gate * Math.round(1 / PROGRESS_GATE_SHARE)) : every
  const backoff = 2 ** Math.max(0, Math.floor(Number(faults) || 0))
  const interval = floor * backoff
  const nextAtMs = (lastAtMs ?? 0) + interval
  const tailFrom = clockMs - PROGRESS_TAIL_GATES * (gate ?? 0)
  const why = [`every ${minutes(every)}`, gate ? `gate ${Math.round(gate / 1000)} s → ≥ ${minutes(gate * 10)}` : 'gate unmeasured', backoff > 1 ? `×${backoff} after ${faults} fault(s)` : null].filter(Boolean).join(', ')
  if (nowMs >= tailFrom) {
    return { due: false, nextAtMs: null, reason: gate ? `within the last ${PROGRESS_TAIL_GATES} × ${Math.round(gate / 1000)} s gate runtime of the ${minutes(clockMs)} wall clock` : `past the ${minutes(clockMs)} wall clock` }
  }
  if (nowMs < nextAtMs) return { due: false, nextAtMs, reason: `next reading at ${minutes(nextAtMs)} (${why})` }
  return { due: true, nextAtMs, reason: `due at ${minutes(nextAtMs)} (${why})` }
}

/** The probe's gate cap: `min(GATE_TIMEOUT_MS, 4 × measured gateMs)`, 30 min before any measurement. */
export function probeGateTimeoutMs(gateMs) {
  return finitePos(gateMs) ? Math.min(GATE_TIMEOUT_MS, PROBE_GATE_TIMEOUT_FACTOR * gateMs) : Math.min(GATE_TIMEOUT_MS, PROBE_GATE_TIMEOUT_UNMEASURED_MS)
}

/**
 * The probe's io. `archive` is calibrate's archiveBase (a fresh dir, `git
 * archive <sha> | tar -x` through bashExe(), F160); `runGate` is the grade
 * module's own runGate pointed at the ARCHIVE with `retry: false` — the one
 * place a spawn of the sealed gate is deliberately not retried; `removeDir`
 * cleans the archive after the reading. The two module ios are parameters so a
 * test can prove the flags without spawning a gate.
 */
export function probeIo({ calibrate = calibrateIo, grade = gradeIo } = {}) {
  return {
    archive: (repo, sha, dest) => archiveBase(repo, sha, dest, calibrate),
    runGate: (spec, dest, { timeoutMs } = {}) => runGate(spec, grade, { repo: dest, timeoutMs: timeoutMs ?? probeGateTimeoutMs(null), retry: false }),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  }
}
export const defaultProbeIo = probeIo()

/** Why a gate reading is not a reading, or null when it is one. */
function gateFaultOf(g) {
  if (g.harnessFault) return g.harnessFault
  // The sealed gates exit 0 on PASS and 1 on MISS (gate_c99.py, the real gates'
  // `sys.exit(1 if fails else 0)`); anything else is the gate dying, whatever
  // it managed to print first.
  if (g.exit !== 0 && g.exit !== 1) return `gate exited ${g.exit ?? 'null'}`
  return null
}

/**
 * One progress reading of `sha`: archive it into
 * `<tmpdir>/cynco-progress-<spec.id>-<n>`, run the sealed gate there, parse,
 * remove the dir. Returns
 *   `{ at, sha, fails, passes, failIds, durationMs, elapsedFraction }` — fails
 *     and passes are COUNTS, failIds the FAIL line ids;
 *   `{ at, fault, durationMs }` — the archive failed, the gate timed out or did
 *     not run (a stale ETIMEDOUT included — never retried), or died;
 *   `{ skipped: 'sha unchanged' }` — `sha` equals `lastSha`; nothing is run.
 * `elapsedMs` / `clockMs` (the wave's clock) give `elapsedFraction`, null when
 * either is unknown. `gateMs` is the last measured gate run (the timeout).
 * Never throws: a throw inside is the reading's fault.
 */
export function probeProgress({ spec, sha, io = defaultProbeIo, lastSha = null, elapsedMs = null, clockMs = null, gateMs = null, n = 0, now = Date.now, at: atGiven = null }) {
  if (lastSha && sha === lastSha) return { skipped: 'sha unchanged' }
  const t0 = now()
  const at = atGiven ?? new Date(t0).toISOString()
  const took = () => Math.max(0, now() - t0)
  if (!sha) return { at, fault: 'no commit sha to grade (the repo HEAD did not resolve)', durationMs: took() }
  const dest = join(tmpdir(), `cynco-progress-${spec.id}-${n}`)
  try {
    const arch = io.archive(spec.repo, sha, dest)
    if (!arch?.ok) return { at, fault: `archive of ${sha} failed: ${(arch?.problems ?? []).join('; ') || 'no reason given'}`, durationMs: took() }
    const g = io.runGate(spec, dest, { timeoutMs: probeGateTimeoutMs(gateMs) })
    const fault = gateFaultOf(g)
    if (fault) return { at, fault, durationMs: took() }
    const elapsedFraction = finitePos(clockMs) && typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? round3(elapsedMs / clockMs) : null
    return { at, sha, fails: g.fails.length, passes: g.passes.length, failIds: g.fails.map(f => f.id), durationMs: took(), elapsedFraction }
  } catch (e) {
    return { at, fault: `probe threw: ${e?.message ?? e}`, durationMs: took() }
  } finally {
    try { io.removeDir?.(dest) } catch (e) { console.error(`[campaign] progress archive ${dest} not removed: ${e?.message ?? e}`) }
  }
}

/**
 * `R1.no-progress`, in SHADOW (ruling 3): *if at ≥ 50 % of the wave's wall
 * clock the gate's fail count has not dropped below the wave's starting count,
 * the wave will not pass.* Evaluated at every progress reading; it stops
 * nothing. `nowMs` is the wave clock (ms since dispatch).
 *
 * `fired` iff `elapsedFraction ≥ 0.5` AND the latest non-fault reading's
 * `fails ≥ startFails`. It NEVER fires on a fault: when the newest reading
 * faulted the decision is `fired: false`, because a stale count is not a
 * reading of now. An unmeasured start (null) cannot fire either.
 * `wouldHaveSavedS` = the wall clock left at the decision (`clockMs/1000 −
 * elapsed`, ≥ 0): what stopping the wave here would have handed back. It is
 * written on every decision (fired or not) so the ladder can weigh a firing
 * against what it would have cost; null when the clock is unknown.
 */
export function shadowNoProgress({ readings, startFails, clockMs, nowMs, at = new Date().toISOString() }) {
  const list = (readings ?? []).filter(r => r && !r.skipped)
  const newest = list.at(-1) ?? null
  const measured = list.filter(r => !r.fault && typeof r.fails === 'number')
  const latest = measured.at(-1) ?? null
  const clockKnown = finitePos(clockMs) && typeof nowMs === 'number' && Number.isFinite(nowMs)
  const elapsedFraction = clockKnown ? round3(nowMs / clockMs) : null
  const start = typeof startFails === 'number' && Number.isFinite(startFails) ? startFails : null
  const fails = latest ? latest.fails : null
  const fired = elapsedFraction !== null && elapsedFraction >= NO_PROGRESS_AT
    && newest !== null && !newest.fault && start !== null && fails !== null && fails >= start
  const wouldHaveSavedS = clockKnown ? Math.max(0, Math.round(clockMs / 1000 - nowMs / 1000)) : null
  return { rule: NO_PROGRESS_RULE, at, elapsedFraction, fired, startFails: start, fails, wouldHaveSavedS }
}

/**
 * The verdict entry's `- Progress:` line, from the wave record. Minutes are
 * read off `at − dispatchedAt`. The start count is the shadow rule's
 * `startFails`, else the brief's FAIL ids (`s4.generatorInput.failIds`).
 */
export function progressLine(rec) {
  const readings = Array.isArray(rec?.progress) ? rec.progress : null
  const measured = (readings ?? []).filter(r => r && !r.fault && typeof r.fails === 'number')
  const faults = (readings ?? []).filter(r => r?.fault)
  if (!measured.length) {
    const reason = !readings ? (rec?.progressNote ?? 'not measured')
      : faults.length ? `${faults.length} probe(s) faulted: ${faults[0].fault}`
        : (rec?.progressNote ?? 'none was due before the wave ended')
    return `- Progress: no readings (${reason})`
  }
  const t0 = Date.parse(rec?.dispatchedAt ?? '')
  const minOf = (r) => { const t = Date.parse(r.at ?? ''); return Number.isFinite(t0) && Number.isFinite(t) ? `${Math.round((t - t0) / 60_000)} min` : 'unknown time' }
  const decisions = (rec?.shadowDecisions ?? []).filter(d => d?.rule === NO_PROGRESS_RULE)
  const start = decisions.find(d => typeof d.startFails === 'number')?.startFails ?? rec?.s4?.generatorInput?.failIds?.length ?? null
  const last = measured.at(-1)
  const firstFix = start === null ? null : measured.find(r => r.fails < start)
  const fix = start === null ? 'start unmeasured' : firstFix ? `first fix at ${minOf(firstFix)}` : 'no drop'
  const faulted = faults.length ? `; ${faults.length} fault(s)` : ''
  const firing = decisions.find(d => d.fired)
  const shadow = firing
    ? `${NO_PROGRESS_RULE} fired at ${Math.round(firing.elapsedFraction * 100)}%${typeof firing.wouldHaveSavedS === 'number' ? ` (would have saved ${(firing.wouldHaveSavedS / 3600).toFixed(1)} h)` : ''}`
    : decisions.length ? `${NO_PROGRESS_RULE} did not fire (${decisions.length} decision(s))` : `${NO_PROGRESS_RULE} not evaluated`
  return `- Progress: ${start ?? '?'} → ${last.fails} fails over ${measured.length} readings (${fix}; last at ${minOf(last)}: ${last.fails}${faulted}); ${shadow}`
}

/**
 * The WAIT-loop hook runWave hands to `waitForDriver` as `onTick`. It owns the
 * wave's readings and shadow decisions (`progress`, `shadowDecisions`, handed
 * to the wave record at VERDICT) and never throws out of a tick.
 *
 * `headOf()` → the repo's latest commit sha (runWave's `repoHead` seam);
 * `startSha` / `startFails` / `startFailIds` / `startPasses` — the wave's base
 * as graded at wave start (the calibration or the last verdict, the same sha).
 * The first due tick that finds HEAD still AT the start records that start
 * grade as a reading (`reusedFrom: 'start'`, no gate run — the gate is
 * deterministic and that sha was graded already), so a wave that commits
 * nothing still has a count past 50 %; after that an unchanged sha is skipped.
 * The reused reading has the fixed reading shape `{ at, sha, fails, passes,
 * failIds, durationMs: 0, elapsedFraction }` plus `reusedFrom: 'start'`;
 * `passes` / `failIds` are null only when the caller handed no start passes /
 * FAIL ids (runWave always hands both, from the calibration or the last grade).
 * `dispatchedAtMs` anchors the wave clock; the tick's `nowMs` is read against
 * it, else the tick's `elapsedMs` (the wait's own clock) is used.
 * `gateMs` seeds the gate's measured runtime (review M1: runWave passes the
 * last grade's `gate.durationMs`, else the calibration's BASE run) so the 10 %
 * interval, the end-of-clock tail and the probe's cap hold before the first
 * probe run of this wave; each real probe run replaces it.
 */
export function progressTracker({ spec, probe, headOf, clockMs, startSha = null, startFails = null, startFailIds = null, startPasses = null, dispatchedAtMs = null, everyMs = everyMsFor(spec), gateMs: seedGateMs = null, log = (m) => console.log(m), now = Date.now }) {
  const progress = [], shadowDecisions = []
  let lastSha = null, lastAtMs = null, gateMs = finitePos(seedGateMs) ? seedGateMs : null, faults = 0, n = 0, lastReason = null
  const tick = ({ elapsedMs, nowMs } = {}) => {
    const waveMs = Number.isFinite(dispatchedAtMs) && typeof nowMs === 'number' ? nowMs - dispatchedAtMs : elapsedMs
    const c = progressCadence({ everyMs, clockMs, gateMs, faults, lastAtMs, nowMs: waveMs })
    lastReason = c.reason
    if (!c.due) return null
    lastAtMs = waveMs
    // The tick's own clock reading when it carries one (the wait loop's
    // Date.now()), so `at − dispatchedAt` is the wave clock the cadence used.
    const at = new Date(typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : now()).toISOString()
    const mins = Math.round(waveMs / 60_000)
    let sha = null, reading
    try { sha = headOf() } catch (e) { reading = { at, fault: `latest commit not read: ${e?.message ?? e}`, durationMs: 0 } }
    if (!reading && sha && startSha && sha === startSha && lastSha === null && typeof startFails === 'number') {
      reading = { at, sha, fails: startFails, passes: startPasses ?? null, failIds: startFailIds ?? null, durationMs: 0,
        elapsedFraction: finitePos(clockMs) ? round3(waveMs / clockMs) : null, reusedFrom: 'start' }
    }
    if (!reading) reading = probeProgress({ spec, sha, io: probe, lastSha: lastSha ?? startSha, elapsedMs: waveMs, clockMs, gateMs, n: ++n, now, at })
    if (reading.skipped) {
      log(`[campaign] progress @ ${mins}m: ${reading.skipped} (${String(sha).slice(0, 7)}) — no gate run`)
    } else {
      progress.push(reading)
      if (reading.fault) {
        faults += 1
        log(`[campaign] progress @ ${mins}m: FAULT — ${reading.fault} (back-off ×${2 ** faults})`)
      } else {
        faults = 0
        lastSha = reading.sha
        if (!reading.reusedFrom && finitePos(reading.durationMs)) gateMs = reading.durationMs
        log(`[campaign] progress @ ${mins}m: ${reading.fails} fails (was ${startFails ?? '?'})${reading.reusedFrom ? ' — no commit since the start, start grade reused' : ` — gate ${Math.round(reading.durationMs / 1000)} s on ${String(reading.sha).slice(0, 7)}`}`)
      }
    }
    const d = shadowNoProgress({ readings: progress, startFails, clockMs, nowMs: waveMs, at })
    shadowDecisions.push(d)
    if (d.fired) log(`[campaign] shadow ${NO_PROGRESS_RULE} FIRED at ${Math.round(d.elapsedFraction * 100)}% (${d.fails} ≥ ${d.startFails}; would have saved ${(d.wouldHaveSavedS / 3600).toFixed(1)} h) — shadow only, nothing stopped`)
    return reading
  }
  const onTick = (t) => {
    try { return tick(t) } catch (e) {
      // A tick never breaks the wait, and a probe fault never touches the wave.
      console.error(`[campaign] progress tick failed: ${e?.message ?? e}`)
      return null
    }
  }
  const note = () => (progress.length ? null : (lastReason ? `none taken — ${lastReason}` : 'the wave ended before the first tick'))
  return { onTick, progress, shadowDecisions, note }
}
