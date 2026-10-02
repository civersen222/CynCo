// scripts/cynco-campaign-progress.mjs — Phase 6 rulings 2 and 3: the runner
// grades the wave's latest commit MID-WAVE with the sealed gate, and runs the
// first runner-level regulator, `R1.no-progress`, in SHADOW over the readings
// — and, since Phase 7, a second, `R2.stalled`, over the same ticks.
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
import { NO_PROGRESS_AT, NO_PROGRESS_RULE, STALLED_AT, STALLED_RULE, STALLED_WINDOW, runnerRowsFrom } from './cynco-runner-rows.mjs'

/** `progress.everyMs` / `CYNCO_PROGRESS_EVERY_MS` when neither says otherwise: 30 min. */
export const PROGRESS_EVERY_MS_DEFAULT = 1_800_000
/** The gate may take at most 10 % of the wave's wall clock: interval ≥ gateMs × 10. */
export const PROGRESS_GATE_SHARE = 0.10
/** No reading starts within the last `gateMs × 2` of the wall clock. */
export const PROGRESS_TAIL_GATES = 2
/**
 * Final review M4: the gate runtime assumed while none is measured (a
 * calibration from before Phase 6 carries no `baseGateMs`, and no verdict has
 * graded yet): 600 s, for the end-of-clock tail and the probe's cap only —
 * never for the interval, which stays `everyMs` until a gate is measured.
 */
export const PROBE_GATE_MS_ASSUMED = 600_000
/**
 * The probe's gate cap before any reading measured the gate: the tail's own
 * length (`PROGRESS_TAIL_GATES × PROBE_GATE_MS_ASSUMED`, 20 min), so a probe
 * that starts at the last moment the tail allows ends by the clock's end and
 * never holds the WAIT past the wave.
 */
export const PROBE_GATE_TIMEOUT_UNMEASURED_MS = PROGRESS_TAIL_GATES * PROBE_GATE_MS_ASSUMED
/** The probe's gate cap once measured: this many times the last measured run. */
export const PROBE_GATE_TIMEOUT_FACTOR = 4
// `R1.no-progress`'s name and threshold, and the runner rows the ladder reads
// off the wave records, live in scripts/cynco-runner-rows.mjs — the one
// construction the VERDICT and the rule-verdicts CLI share (Task 4 review I1).
// Re-exported here so every existing caller keeps its import. Phase 7's
// `R2.stalled` constants live there too, beside R1's.
export { NO_PROGRESS_AT, NO_PROGRESS_RULE, STALLED_AT, STALLED_RULE, STALLED_WINDOW, runnerRowsFrom }

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
 *   gate the tail assumes PROBE_GATE_MS_ASSUMED (600 s) and the reason says so
 *   (final review M4: the clock's own end let a probe due at clock − 1 s hold
 *   the wait up to its cap past the wave's end).
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
  const tailFrom = clockMs - PROGRESS_TAIL_GATES * (gate ?? PROBE_GATE_MS_ASSUMED)
  const assumedS = Math.round(PROBE_GATE_MS_ASSUMED / 1000)
  const why = [`every ${minutes(every)}`, gate ? `gate ${Math.round(gate / 1000)} s → ≥ ${minutes(gate * 10)}` : `gate unmeasured (${assumedS} s assumed for the tail and the cap)`, backoff > 1 ? `×${backoff} after ${faults} fault(s)` : null].filter(Boolean).join(', ')
  if (nowMs >= tailFrom) {
    return { due: false, nextAtMs: null, reason: gate ? `within the last ${PROGRESS_TAIL_GATES} × ${Math.round(gate / 1000)} s gate runtime of the ${minutes(clockMs)} wall clock`
      : `within the last ${PROGRESS_TAIL_GATES} × ${assumedS} s assumed gate runtime of the ${minutes(clockMs)} wall clock (gate unmeasured)` }
  }
  if (nowMs < nextAtMs) return { due: false, nextAtMs, reason: `next reading at ${minutes(nextAtMs)} (${why})` }
  return { due: true, nextAtMs, reason: `due at ${minutes(nextAtMs)} (${why})` }
}

/** The probe's gate cap: `min(GATE_TIMEOUT_MS, 4 × measured gateMs)`, PROBE_GATE_TIMEOUT_UNMEASURED_MS (20 min) before any measurement. */
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
    archive: (repo, sha, dest, { onStaleRetry } = {}) => archiveProbe(repo, sha, dest, calibrate, onStaleRetry),
    runGate: (spec, dest, { timeoutMs } = {}) => runGate(spec, grade, { repo: dest, timeoutMs: timeoutMs ?? probeGateTimeoutMs(null), retry: false }),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  }
}
export const defaultProbeIo = probeIo()

/**
 * P-F155 (Phase 6 fix wave): the probe's archive, through calibrate's runSync.
 * Every probe tick follows a gap of `everyMs` with no spawn, so bun's stale
 * deadline (F155) kills its git spawns in milliseconds. The HEAD read is a
 * pure read and retries inside runSync (`retryImpossibleTimeout`); the archive
 * WRITES a tree, so runSync's in-place retry is not used for it (the spawn
 * guard in cynco-spawn.test.mjs keeps archiveBase unretried). Instead an
 * ETIMEDOUT that provably did not spend its cap (runSync's `fault`, never a
 * `timedOut`) re-runs archiveBase ONCE from the top — `freshDir` empties the
 * destination first, so the retry extracts into a clean dir. The retry's line
 * goes to `onStaleRetry` (the tracker counts it and logs it once per wave),
 * else to stderr as runSync would print it.
 */
function archiveProbe(repo, sha, dest, calibrate, onStaleRetry) {
  let last = null
  const io = { ...calibrate, run: (cmd, args, opts) => { const r = calibrate.run(cmd, args, opts); last = { cmd, opts, r }; return r } }
  const first = archiveBase(repo, sha, dest, io)
  if (first.ok || last?.r?.fault?.code !== 'ETIMEDOUT') return first
  const stale = last
  const second = archiveBase(repo, sha, dest, io)
  if (!second.ok && last?.r?.fault?.code === 'ETIMEDOUT') return second
  const line = `[spawn] ${stale.cmd}: an impossible ETIMEDOUT after ${stale.r.fault.elapsedMs} ms (cap ${stale.opts?.timeoutMs} ms) — bun's stale deadline; archive retried once into a fresh dir (F155)`
  if (typeof onStaleRetry === 'function') onStaleRetry(line)
  else console.error(line)
  return second
}

/**
 * The fault CLASSES a probe reading may name — the leading, harness-authored
 * part of runGate's `harnessFault`. What follows a class in `harnessFault`
 * (`gate printed an error: <the gate's own line>`) is gate output, and gate
 * output never leaves the runner's memory on a probe (final review M2: the
 * fault string is logged, and the runner's log is the one mid-wave copy of a
 * reading outside it). `did not run (…)` keeps its parenthesis: that is
 * faultSummary's code/status/signal/elapsed, the harness's words.
 */
const GATE_FAULT_CLASSES = [/^gate did not run \([^)]*\)/, /^gate timed out after \d+ ms/, /^gate printed an error/, /^gate printed no GATE: terminator/]

/** Why a gate reading is not a reading — the fault class and the exit code, never gate output — or null when it is one. */
function gateFaultOf(g) {
  const exit = `exit ${g.exit ?? 'null'}`
  if (g.harnessFault) {
    const cls = GATE_FAULT_CLASSES.map(re => re.exec(String(g.harnessFault))?.[0]).find(Boolean) ?? 'gate harness fault'
    return `${cls}; ${exit}`
  }
  // The sealed gates exit 0 on PASS and 1 on MISS (gate_c99.py, the real gates'
  // `sys.exit(1 if fails else 0)`); anything else is the gate dying, whatever
  // it managed to print first.
  if (g.exit !== 0 && g.exit !== 1) return `gate exited abnormally; ${exit}`
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
 * `onStaleRetry` receives the archive's F155 retry line (P-F155).
 * Never throws: a throw inside is the reading's fault.
 */
export function probeProgress({ spec, sha, io = defaultProbeIo, lastSha = null, elapsedMs = null, clockMs = null, gateMs = null, n = 0, now = Date.now, at: atGiven = null, onStaleRetry = null }) {
  if (lastSha && sha === lastSha) return { skipped: 'sha unchanged' }
  const t0 = now()
  const at = atGiven ?? new Date(t0).toISOString()
  const took = () => Math.max(0, now() - t0)
  if (!sha) return { at, fault: 'no commit sha to grade (the repo HEAD did not resolve)', durationMs: took() }
  const dest = join(tmpdir(), `cynco-progress-${spec.id}-${n}`)
  try {
    const arch = io.archive(spec.repo, sha, dest, onStaleRetry ? { onStaleRetry } : {})
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
 * `R2.stalled`, in SHADOW (Phase 7 ruling 2): *if at ≥ 25 % of the wave's wall
 * clock the fail count has not decreased over the last three measured ticks,
 * the wave is stalled.* R1 compares against the wave's start and waits for
 * 50 %; on C10 the wave sat flat for five hours below its start and R1 never
 * spoke. R2 reads the TICK series, not the readings: `decisions` is one entry
 * per tick carrying that tick's count (a skip tick carries the last measured
 * count — the sha did not move, so the count is still true) or `fault` (a
 * faulted tick is no measurement and is left out of the window).
 *
 * `fired` iff `elapsedFraction ≥ STALLED_AT` AND the window (the last
 * `STALLED_WINDOW` measured ticks) is full AND never decreases AND its latest
 * count > 0. `window` is the counts read (fewer than three when fewer were
 * measured); `fails` the latest, null when none was measured; an unknown
 * clock is null with no firing (unmeasured, never 0). `wouldHaveSavedS` is
 * R1's: the clock left at the decision. `readings` is accepted for symmetry
 * with R1 and not read.
 */
export function shadowStalled({ readings, decisions, clockMs, nowMs, at = new Date().toISOString() }) {
  const measured = (decisions ?? []).filter(d => d && !d.fault && typeof d.fails === 'number' && Number.isFinite(d.fails))
  const window = measured.slice(-STALLED_WINDOW).map(d => d.fails)
  const clockKnown = finitePos(clockMs) && typeof nowMs === 'number' && Number.isFinite(nowMs)
  const elapsedFraction = clockKnown ? round3(nowMs / clockMs) : null
  const latest = window.at(-1) ?? null
  const nonDecreasing = window.length === STALLED_WINDOW && window.every((f, i) => i === 0 || f >= window[i - 1])
  // T2-M1: this tick's own probe faulted — it measured nothing, so R2 does not
  // decide on it (R1 refuses the same tick); the fault rides on the decision.
  const own = (decisions ?? []).at(-1)
  const ownFault = own?.fault ? own.fault : null
  const fired = !ownFault && elapsedFraction !== null && elapsedFraction >= STALLED_AT && nonDecreasing && latest > 0
  const wouldHaveSavedS = clockKnown ? Math.max(0, Math.round(clockMs / 1000 - nowMs / 1000)) : null
  return { rule: STALLED_RULE, at, elapsedFraction, fired, window, fails: latest, wouldHaveSavedS, ...(ownFault ? { fault: ownFault } : {}) }
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
  // Phase 7: R2.stalled, at the wave minute it first fired. A record from
  // before Phase 7 carries no R2 decision: named, not evaluated.
  const stalled = (rec?.shadowDecisions ?? []).filter(d => d?.rule === STALLED_RULE)
  const stalledFiring = stalled.find(d => d.fired)
  const shadow2 = stalledFiring ? `${STALLED_RULE} fired at ${minOf(stalledFiring)} (${stalled.length} decision(s))`
    : stalled.length ? `${STALLED_RULE} did not fire (${stalled.length} decision(s))` : `${STALLED_RULE} not evaluated`
  return `- Progress: ${start ?? '?'} → ${last.fails} fails over ${measured.length} reading${measured.length === 1 ? '' : 's'} (${fix}; last at ${minOf(last)}: ${last.fails}${faulted}); ${shadow}; ${shadow2}`
}

/**
 * The gate runtime runWave seeds the tracker with (review M1): the last
 * verdict's gate run, else the calibration's BASE run (`baseGateMs`), else
 * null. Task 3 review N1: only a grade whose gate did NOT harness-fault — a
 * faulted run's duration is its timeout (a gate that hung for 2 h), and ×10 of
 * it would starve an 8 h wave of every reading.
 */
export function seedGateMs(state) {
  const gate = state?.lastGrade?.gate
  const fromGrade = gate && !gate.harnessFault && finitePos(gate.durationMs) ? gate.durationMs : null
  const fromCalibration = finitePos(state?.calibration?.baseGateMs) ? state.calibration.baseGateMs : null
  return fromGrade ?? fromCalibration
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
  const progress = [], shadowDecisions = [], stallTicks = []
  let lastSha = null, lastAtMs = null, gateMs = finitePos(seedGateMs) ? seedGateMs : null, faults = 0, n = 0, lastReason = null
  // P-F155: every tick's first git spawn follows a gap of `everyMs`, so bun's
  // stale deadline trips it and the spawn is retried (runSync for the HEAD
  // read, archiveProbe for the archive). Counted here — `retriedSpawns` on the
  // wave record — and the line logged once per wave, not once per tick.
  let retriedSpawns = 0
  const onStaleRetry = (line) => {
    retriedSpawns += 1
    if (retriedSpawns === 1) log(`${line} — further stale-deadline retries this wave are counted on the wave record (retriedSpawns), not logged`)
  }
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
    try { sha = headOf({ onStaleRetry }) } catch (e) { reading = { at, fault: `latest commit not read: ${e?.message ?? e}`, durationMs: 0 } }
    if (!reading && sha && startSha && sha === startSha && lastSha === null && typeof startFails === 'number') {
      reading = { at, sha, fails: startFails, passes: startPasses ?? null, failIds: startFailIds ?? null, durationMs: 0,
        elapsedFraction: finitePos(clockMs) ? round3(waveMs / clockMs) : null, reusedFrom: 'start' }
    }
    if (!reading) reading = probeProgress({ spec, sha, io: probe, lastSha: lastSha ?? startSha, elapsedMs: waveMs, clockMs, gateMs, n: ++n, now, at, onStaleRetry })
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
    // Phase 7: R2.stalled over the tick series — R1's decisions, one per tick,
    // with this tick's fault marked: R1 carries the last measured count onto
    // a faulted tick, and that stale count is no measurement for R2.
    stallTicks.push(reading.fault ? { ...d, fails: null, fault: reading.fault } : d)
    const d2 = shadowStalled({ readings: progress, decisions: stallTicks, clockMs, nowMs: waveMs, at })
    shadowDecisions.push(d2)
    if (d2.fired) log(`[campaign] shadow ${STALLED_RULE} FIRED at ${Math.round(d2.elapsedFraction * 100)}% (${d2.window.join(', ')} fails over the last ${STALLED_WINDOW} measured ticks; would have saved ${(d2.wouldHaveSavedS / 3600).toFixed(1)} h) — shadow only, nothing stopped`)
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
  return { onTick, progress, shadowDecisions, note, retriedSpawns: () => retriedSpawns }
}
