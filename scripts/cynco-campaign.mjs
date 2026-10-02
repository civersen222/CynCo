// scripts/cynco-campaign.mjs — the campaign-level metasystem.
//
//   bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c8.campaign.json [--waves N] [--resume] [--dry-run] [--sync]
//                                  [--approve-proposal ideation/brief] [--reject-proposal ideation/brief]
//                                  [--adopt-inflight] [--autopoiesis] [--scoreboard]
//   bun scripts/cynco-campaign.mjs --author c9            # write the next campaign's sealed gate (Phase 3)
//   bun scripts/cynco-campaign.mjs --check <staging> <base>
//   bun scripts/cynco-campaign.mjs --approve-proposal gate/c9   # seal what --author staged
//
// S2: salvage + no-progress stop.   S3: budgets + invariants handed to the wave.
// S3*: sealed gate, suite gate, sweep.   S4: brief (generator binds; ideation advises).
// S5: the campaign spec (identity, checked once per invocation).   Algedonic: ntfy.
//
// Runs under bun (it reaches into engine/*.ts through .js specifiers).
import { resolve, join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, existsSync, appendFileSync, unlinkSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { cyncoHome } from '../engine/paths.js'
import { bashExe, runSync, faultSummary } from './cynco-spawn.mjs'
import { loadCampaignSpec, checkIdentity } from './cynco-campaign-spec.mjs'
import { CampaignState } from './cynco-campaign-state.mjs'
import { calibrate, defaultIo as calibrateIo } from './cynco-campaign-calibrate.mjs'
import { generateBrief, sidecarFor, workOrderFor, pacingDigestIncluded } from './cynco-brief.mjs'
import { gradeWave, SUITE_GATE } from './cynco-campaign-grade.mjs'
import { verdictEntry, notify, commitVerdict, economicsLines, hindcastLine } from './cynco-campaign-verdict.mjs'
import { runIdeation, measureFollowed, authorityRegistry, promotionProposal, capProposal, effectiveInvariants } from './cynco-ideation.mjs'
import { patchLedgerRow, findLedgerRow } from './cynco-ledger-patch.mjs'
import { exportGateLines, exportGateOutcomes, resealRecord, linesOf } from './cynco-gate-lines.mjs'
import { gateAuthorPromotion } from './cynco-gate-author.mjs'
import { sidecarPath } from './cynco-contract.mjs'
import { exportTriples } from './cynco-triples.mjs'
import { analyseDenials } from './cynco-signal-validation.mjs'
import { governanceCounts, governancePosiwid, governancePosiwidV2, authorityOf } from './cynco-governance-posiwid.mjs'
import { loadRoadmap, saveRoadmap, rejectLine, setLineStatus, ROADMAP_PATH } from './cynco-roadmap.mjs'
import { assertIdentityIntact } from './cynco-identity.mjs'
import { applyProposalDecision, seatAuthority } from './cynco-proposals.mjs'
import { writeRuleVerdicts, readRuleVerdicts, RULE_VERDICTS_PATH, modelRowsFrom, modelLaddersOf } from './cynco-rule-verdicts.mjs'
import { exportOutcomeDatasets, runHindcast, hindcastOf, noEligibleFault, hindcastReady, PRIMARY_TURNS, exportReadingDataset, runReadingHindcast } from './cynco-hindcast.mjs'
import { campaignScoreboard, pooledScoreboard, scoreboardLines } from './cynco-scoreboard.mjs'
import { readLedger } from './cynco-ledger-shards.mjs'
import { campaignAssessment, campaignRows, autopoiesisLine, storedAssessment, effectiveSeatAuthority } from './cynco-autopoiesis.mjs'
import { summarize as summarizeGateLines, GATE_LINES_PATH } from './cynco-gate-lines.mjs'
import { progressTracker, defaultProbeIo, everyMsFor, seedGateMs } from './cynco-campaign-progress.mjs'
import { runnerRowsFromCampaigns, runnerWaves } from './cynco-runner-rows.mjs'

// Phase 4: the operator's decision on a pending proposal lives in the one
// proposal registry (scripts/cynco-proposals.mjs). Re-exported so every caller
// that imported it from the runner keeps working against the same function.
export { applyProposalDecision } from './cynco-proposals.mjs'

const BRIEFS_DIR = 'docs/civkings-redesign-briefs'
const LOG = `${BRIEFS_DIR}/campaign-log.md`
const ENGINE_URL = 'http://127.0.0.1:9161/'
const ENGINE_PROBE_TIMEOUT_MS = 3_000
/** The cap on one `git rev-parse` read (the wave's HEAD-vs-base check). */
const GIT_READ_TIMEOUT_MS = 30_000

/**
 * Which sweep survivors sit inside a file the campaign CLAIMED — spec §3.2's
 * "a survivor a work[] item claims", read off `spec.allow.edit` /
 * `spec.allow.newFiles` because that is the set the work items are allowed to
 * touch. An allow entry can carry a parenthetical note or a glob
 * (`gilded/tests/test_c8_*.py (new test files …)`), so it is cut at its first
 * space and at its first `*`, leaving a path prefix. Survivors are `path:line`.
 *
 * A survivor OUTSIDE every claimed prefix is reported, never punished: the
 * campaign did not promise to cover code it was forbidden to edit, exactly as
 * the suite gate reports repairs it did not ask for.
 */
export function claimedSurvivors(survived, spec) {
  const prefixes = [...(spec.allow?.edit ?? []), ...(spec.allow?.newFiles ?? [])]
    .map(e => String(e).trim().split(/\s+/)[0].replace(/\\/g, '/').split('*')[0])
    .filter(Boolean)
  return (survived ?? []).filter(s => {
    const p = String(s).replace(/\\/g, '/').replace(/:\d+$/, '')
    return prefixes.some(pre => p === pre || p.startsWith(pre))
  })
}

/**
 * The stop rule, pure so it can be argued with in a test rather than in a log.
 *
 * Order matters and is not arbitrary:
 *   1. invariantsRejected — the engine refused the mission's invariants block,
 *      so whatever the wave did, it did NOT do it under the terms the campaign
 *      set. A green gate under rejected invariants measures a different
 *      experiment. It outranks `pass` deliberately.
 *   2. harness fault — `verified === null` means an instrument broke; the grade
 *      is not evidence either way.
 *   3. pass / pass-with-survivors / no-progress / budget / next.
 *
 * `pass` must stay REACHABLE: a sweep survivor in a file the campaign never
 * claimed is not a reason to deny a green gate, so only claimed survivors
 * downgrade the verdict — and they downgrade it to `pass-with-survivors`,
 * which stops the loop with exit 0. Neither is a `next`: looping on a gate
 * that is already green can only burn the budget.
 */
export function decide({ grade, state, spec, commitsLanded, row }) {
  if (row?.invariantsRejected === true) return { kind: 'fault', why: 'the wave ran without its invariants (block rejected by the engine)' }
  if (grade.verified === null) return { kind: 'fault', why: grade.gate.harnessFault ?? grade.suite.harnessFault ?? 'harness fault' }
  const green = grade.gate.terminator === 'PASS' && grade.suite.exit === 0
  if (green) {
    const survived = grade.sweep?.survived ?? []
    const claimed = claimedSurvivors(survived, spec)
    const sweepSaid = grade.sweep
      ? `sweep ${grade.sweep.killed}/${grade.sweep.total}${survived.length ? `, ${survived.length} survivor(s)` : ' no survivors'}`
      : 'sweep unmeasured'
    if (claimed.length) return { kind: 'pass-with-survivors', survivors: claimed, why: `sealed gate PASS, suite gate PASS, ${sweepSaid} — ${claimed.length} inside a claimed file: ${claimed.join(', ')}` }
    return { kind: 'pass', why: `sealed gate PASS, suite gate PASS, ${sweepSaid}${survived.length ? ' (none inside a claimed file)' : ''}` }
  }
  const ids = grade.gate.fails.map(f => f.id)
  const same = Array.isArray(state.lastFails) && ids.length === state.lastFails.length && ids.every((x, i) => x === state.lastFails[i])
  if (same && commitsLanded === 0 && (state.consecutiveNoProgress ?? 0) >= 1) return { kind: 'no-progress', why: `two consecutive waves with the same ${ids.length} FAIL line(s) and no commits` }
  if (state.waveCount >= spec.budget.waves) return { kind: 'budget', why: `${spec.budget.waves} wave(s) spent; ${ids.length} line(s) still FAIL` }
  return { kind: 'next', why: `${ids.length} line(s) still FAIL` }
}

/**
 * The environment a wave is dispatched with. The worker is an unattended model
 * with a Bash tool: anything in this env it can read, print, or post. The ntfy
 * credentials are the campaign's OWN alert channel (it could page the owner as
 * the runner) and GH_TOKEN/GITHUB_TOKEN would let a mission push and merge.
 * None of the three is needed to do the work, so none of them is handed over.
 */
/** The runner's environment with the spec's `env` laid over it (F161); `dispatchEnv` strips it like any other base. */
export function waveEnvBase(spec, base = process.env) {
  return { ...base, ...(spec?.env ?? {}) }
}

export function dispatchEnv(base, extra) {
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('CYNCO_NTFY_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') continue
    out[k] = v
  }
  return { ...out, ...extra }
}

/**
 * Phase 7 ruling 3: the check the driver runs once the engine closes the turn
 * with the marker landed. On C10 the brief's keep-green subset missed a
 * regression the full suite caught, so the default is the suite gate — public
 * pytest over the whole suite against the sealed baseline, whose output may
 * reach the model (the driver feeds a FAIL back once). The sealed campaign
 * gate's never does: it is graded by the runner, after the driver, as before.
 * Forward slashes so the command reads the same in every shell runCheck uses.
 *
 * Review I1: the baseline and the repo travel ONLY inside the command, as a
 * POSIX env prefix (runCheck's translateEnvPrefix runs it in PowerShell too).
 * In the env they reached the engine and the model's Bash, and the baseline —
 * the file the suite gate trusts — was neither sealed nor restored. As a path
 * token in the marker check command (CYNCO_MARKER_CHECK, final review I1),
 * harnessGatePaths names it (through markerCheckGateAssertions), so the engine
 * seals it and the driver snapshots and restores it like every other instrument.
 * The prefix is split on whitespace, so a path with a space is refused.
 */
export const MARKER_CHECK_TIMEOUT_MS = 1_800_000
export function suiteGateCommand(spec) {
  const fwd = (p) => String(p).replace(/^~(?=[\\/])/, homedir()).replace(/\\/g, '/')
  const baseline = fwd(spec.suiteBaseline)
  const repo = fwd(spec.repo)
  for (const [k, v] of [['suiteBaseline', baseline], ['repo', repo]]) {
    if (/\s/.test(v)) throw new Error(`campaign spec ${k} "${v}" contains whitespace — it cannot travel in the suite gate's env prefix`)
  }
  return `CHK_SUITE_BASELINE=${baseline} CYNCO_GATE_REPO=${repo} python "${fwd(SUITE_GATE())}"`
}

/**
 * Final review M4: suiteGateCommand's whitespace refusal, asked at STARTUP
 * (beside the checkout guard, before the lock) rather than inside every
 * wave's dispatch, where it faulted each wave in turn. Null when the spec
 * names its own `markerCheck` (the suite gate is then not the marker check)
 * or the paths can travel; otherwise the refusal line.
 */
export function suiteGateRefusal(spec) {
  if (spec.markerCheck !== undefined && spec.markerCheck !== null) return null
  try {
    suiteGateCommand(spec)
    return null
  } catch (e) {
    return `[campaign] ${spec.id}: ${e.message}; move it to a path without whitespace (or name a markerCheck) — nothing was dispatched`
  }
}

/** The keys the suite gate reads, which the engine (and so the model's Bash) must never hold. */
export const SUITE_GATE_ENV_KEYS = ['CHK_SUITE_BASELINE', 'CYNCO_GATE_REPO']

/**
 * The wave's dispatch-mission.sh argv and environment.
 *
 * The check-cmd argument stays `spec.keepGreen` (final review I1): the driver
 * also turns it into the engine's withheld contract assertion, which the
 * model's `ContractAssertPass` runs inside its own turn — a whole-suite gate
 * there costs the wave's clock unpriced, and the smoke's fail-once fixture
 * would be spent by the model with no tell. The marker check travels to the
 * driver on its own channel instead: CYNCO_MARKER_CHECK (a spec `markerCheck`
 * verbatim; without one the suite gate, carrying its baseline and repo in its
 * own command) and its cap CYNCO_MARKER_CHECK_TIMEOUT_MS. Only the driver's
 * marker verify runs it; the engine reads it for the instruments it seals and
 * the model's Bash never holds it (bashToolEnv). The keepGreen check keeps the
 * cap dispatch-mission.sh gives it, as before Phase 7. `spec.markerRetryMinS`
 * reaches the driver as CYNCO_MARKER_RETRY_MIN_S. `base` is the runner's env.
 */
export function waveDispatch(spec, { briefFile, invariants, timeoutS, pidFile, driverLog }, base = process.env) {
  const suite = spec.markerCheck === undefined || spec.markerCheck === null
  const markerCheck = suite ? suiteGateCommand(spec) : spec.markerCheck
  // CYNCO_CAMPAIGN_ID: the only way the dispatched engine's own 9161 dashboard
  // can name its campaign as `active` in /api/campaign between waves, when no
  // campaign has a driver in flight (Phase 2c-ii). dispatch-mission.sh passes
  // it through to `bun engine/main.ts` the same way it passes LOCALCODE_MISSION_*.
  // F161: spec.env (the engine's explicit llama-server / GGUF paths for a
  // campaign under a temp home) goes in through the BASE, so the same
  // stripping applies to it as to the runner's own environment.
  const env = dispatchEnv(waveEnvBase(spec, base), {
    LOCALCODE_MAX_ITERATIONS: String(spec.budget.iterations), CYNCO_BASH_TIMEOUT_MS: String(spec.budget.bashTimeoutMs),
    CYNCO_MISSION_INVARIANTS: JSON.stringify(invariants), DRIVER_PID_FILE: pidFile, DRIVER_LOG: driverLog, CYNCO_SKIP_IDLE_ENGINE: '1', CYNCO_CAMPAIGN_ID: spec.id,
    CYNCO_MARKER_CHECK: markerCheck, CYNCO_MARKER_CHECK_TIMEOUT_MS: String(MARKER_CHECK_TIMEOUT_MS),
    ...(spec.markerRetryMinS !== undefined ? { CYNCO_MARKER_RETRY_MIN_S: String(spec.markerRetryMinS) } : {}),
  })
  for (const k of SUITE_GATE_ENV_KEYS) delete env[k]
  return { args: [briefFile, spec.marker, spec.repo, String(timeoutS), spec.keepGreen], env }
}

/** The cap on the dispatch-mission.sh launch itself (it backgrounds the driver and returns). */
export const DISPATCH_TIMEOUT_MS = 900_000

/**
 * The one spawn of `scripts/dispatch-mission.sh`, for the wave (`dispatch`) and
 * the authoring mission (`dispatchRaw`). In a multi-wave campaign it is the
 * FIRST spawn after `waitForDriver`'s hours-long idle in the same bun process —
 * exactly F155's trigger (a stale deadline kills the spawn with ETIMEDOUT in
 * milliseconds). So it goes through runSync, which tells an elapsed timeout
 * from a harness fault, and each of the three readings is named: a fault, a
 * real timeout, a non-zero exit. It is deliberately NOT given
 * `retryImpossibleTimeout`: the killed attempt may already have backgrounded a
 * driver, and a blind re-dispatch could start a second one on the same GPU.
 *
 * `env` is the complete environment (dispatchEnv already stripped the ntfy and
 * GitHub keys), so it is passed `envExact`; an undefined env inherits the
 * runner's, as spawnSync did. `hooks` is runSync's test seam (`spawn`, `now`)
 * plus `bash` in place of bashExe().
 */
export function runDispatch(args, env, hooks = {}) {
  const { bash, ...spawnHooks } = hooks
  const r = runSync(bash ?? bashExe(), ['scripts/dispatch-mission.sh', ...args], { env, envExact: true, timeoutMs: DISPATCH_TIMEOUT_MS }, spawnHooks)
  const tail = () => `${r.stdout}${r.stderr}`.slice(-2000)
  if (r.fault) {
    throw new Error(`dispatch harness fault: dispatch-mission.sh did not run (${faultSummary(r.fault)}) — `
      + `an ETIMEDOUT far under the ${DISPATCH_TIMEOUT_MS} ms cap is bun's stale spawn deadline (F155); `
      + `not retried, because a re-dispatch could start a second driver${tail() ? `: ${tail()}` : ''}`)
  }
  if (r.timedOut) throw new Error(`dispatch timed out after ${r.elapsedMs} ms (cap ${DISPATCH_TIMEOUT_MS} ms): ${tail()}`)
  if (r.status !== 0) throw new Error(`dispatch failed (exit ${r.status}): ${tail()}`)
  if (r.stdout) console.log(r.stdout.trimEnd())
  if (r.stderr?.trim()) console.log(r.stderr.trimEnd())
  return r
}

const gitC = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout ?? ''
const repoRel = (abs) => relative(process.cwd(), abs).replace(/\\/g, '/')

export const defaultIo = {
  writeBrief: (path, text, sidecar) => { writeFileSync(path, text, 'utf8'); writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2) + '\n'); return path },
  dispatch: async ({ spec, briefFile, invariants, timeoutS, pidFile, driverLog }) => {
    // The env and the marker check (Phase 7 ruling 3) are built by waveDispatch.
    const { args, env } = waveDispatch(spec, { briefFile, invariants, timeoutS, pidFile, driverLog })
    // dispatch-mission.sh prints the invariants it accepted and the driver log
    // and PID it started; runDispatch re-emits them — those three lines are the
    // only unattended evidence that the wave was given its orders and that the
    // PID we are about to wait on is the driver's.
    runDispatch(args, env)
    // dispatch-mission.sh backgrounds the driver, so the missionId does not
    // exist yet: it is read out of the driver log by missionIdFrom once the
    // driver has written its ledger line.
    return { driverLog }
  },
  // The same launcher, called with the pieces spelled out rather than read off
  // a campaign spec. The AUTHORING mission (scripts/cynco-gate-author.mjs) has
  // no spec — writing one is the thing it is for — so it names its own marker,
  // cwd, wall clock and check command, and hands over an env it built itself.
  // `dispatch` above is left exactly as it was: the wave path is the measured
  // one and must not change behaviour to make room for this.
  dispatchRaw: async ({ briefFile, marker, cwd, timeoutS, checkCmd, env }) => {
    runDispatch([briefFile, marker, cwd, String(timeoutS), checkCmd ?? ''], env)
    return { driverLog: env?.DRIVER_LOG ?? null }
  },
  // The LEDGER LINE is the authority, not the pid. The driver writes its row
  // and then tears down (engine shutdown, snapshots, the odd orphan); a pid
  // probe answers "is that process object still there", which on Windows has
  // been wrong in both directions (an MSYS pseudo-PID nobody can see, a pid
  // that outlives the work). Once the row exists the wave is gradeable, so
  // check for it FIRST on every tick and keep the pid only as the secondary
  // signal for "it is gone and wrote nothing".
  //
  // Phase 6 ruling 2: `onTick({ elapsedMs, nowMs })` is called once per poll
  // while the driver runs — the runner's progress probe (scripts/cynco-campaign-
  // progress.mjs) hangs off it. A throw inside it is caught and logged ONCE per
  // distinct message, and the wait goes on: a probe never breaks the wait.
  waitForDriver: async ({ pidFile, driverLog, timeoutMs, missionIdFrom = defaultIo.missionIdFrom, pollMs = 30_000, onTick = null }) => {
    const t0 = Date.now()
    const tickFaults = new Set()
    const tick = async () => {
      if (typeof onTick !== 'function') return
      try { await onTick({ elapsedMs: Date.now() - t0, nowMs: Date.now() }) } catch (e) {
        const message = String(e?.message ?? e)
        if (!tickFaults.has(message)) { tickFaults.add(message); console.error(`[campaign] progress tick failed (the wait goes on): ${message}`) }
      }
    }
    const idNow = () => { try { return missionIdFrom(driverLog) } catch { return null } }
    // The ledger line before the pid file: a driver that already wrote its
    // row is gradeable whether or not its pid file survived, and a missing
    // pid file is only a fault once the row is known to be absent.
    const first = idNow()
    if (first) return { exited: true, missionId: first }
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    // A driver that is already gone on the FIRST probe did not run an
    // eight-hour mission in zero seconds — the PID handoff is broken, and
    // believing it faults a wave that is in fact still running and still
    // holding the GPU with nobody left to grade it. Say which of the two it is.
    if (!alive()) return { exited: false, pidUnseen: pid }
    while (Date.now() - t0 < timeoutMs) {
      const id = idNow()
      if (id) return { exited: true, missionId: id }
      if (!alive()) return { exited: true, missionId: idNow() }
      await tick()
      // Never sleep past the wall clock: a 30 s poll on top of an expired
      // budget is 30 s of a wave nobody is waiting on any more.
      await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - t0)))))
    }
    return { exited: false, timedOut: true }
  },
  // cynco-mission-driver.mjs:837 — `[ledger] <outcome> record <id> appended (…) → <shard>`
  missionIdFrom: (driverLog) => /\[ledger\] \w+ record (\S+) appended/.exec(readFileSync(driverLog, 'utf8'))?.[1] ?? null,
  pidAlive: (pidFile) => { try { return pidIsAlive(Number(readFileSync(pidFile, 'utf8').trim())) } catch { return false } },
  sha256: (p) => calibrateIo.sha256(p),
  readRow: (missionId) => findLedgerRow(missionId),
  // T7-M1: a rev (HEAD, a sha, an abbreviation) resolved to its full commit
  // sha, or null. Capped through runSync and retried on an impossible
  // ETIMEDOUT (a read — F155: it is the first spawn after a wave's long wait).
  // `onStaleRetry` (P-F155): the progress tracker's counter — its every tick
  // follows a gap, so the retry line is counted and logged once per wave.
  repoHead: (repo, rev = 'HEAD', { onStaleRetry } = {}) => {
    const r = runSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeoutMs: GIT_READ_TIMEOUT_MS, retryImpossibleTimeout: true, ...(onStaleRetry ? { onStaleRetry } : {}) })
    return !r.fault && !r.timedOut && r.status === 0 ? (String(r.stdout ?? '').trim() || null) : null
  },
  // Phase 6 ruling 2: the mid-wave progress probe's io (archive the sha, run
  // the sealed gate on the archive with no retry, remove it). An injected io
  // without it takes no readings — a test's fake wave never spawns a gate.
  progressProbe: defaultProbeIo,
  commitsBetween: (repo, base, head) => gitC(repo, ['log', '--oneline', `${base}..${head}`]).split('\n').filter(Boolean).map(l => ({ sha: l.slice(0, 7), subject: l.slice(8) })),
  firstCommitFiles: (repo, base, head) => { const first = gitC(repo, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)[0]; return first ? gitC(repo, ['show', '--name-only', '--format=', first]).split('\n').filter(Boolean) : [] },
  // cynco-work-snapshot.mjs:35, called by the driver with outDir 'C:/tmp'.
  salvageOf: (missionId) => { const p = `C:/tmp/${missionId}.uncommitted.patch`; if (!existsSync(p)) return null; const files = [...readFileSync(p, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]); return files.length ? { patchPath: p, files } : null },
  // Ruling 7: the advisory occupant runs on the SAME GPU as the wave. A live
  // engine on 9161 (the dashboard, or a run someone else started) means the
  // card is taken — any answer, even a 404, proves something is listening.
  engineLive: async () => { try { await fetch(ENGINE_URL, { signal: AbortSignal.timeout(ENGINE_PROBE_TIMEOUT_MS) }); return true } catch { return false } },
  grade: (spec, row) => gradeWave(spec, row),
  ideate: (args) => runIdeation(args),
  patchRow: (missionId, fields) => patchLedgerRow(missionId, fields),
  commit: (args) => commitVerdict(args),
  notify: (t) => notify(t),
  // Capped (ECONOMICS_TIMEOUT_MS) and null when the script did not run — the
  // same reader `--scoreboard` uses; it was an uncapped spawnSync before Phase 5.
  economics: (hooks) => scoreboardEconomics(hooks),
  appendLog: (text) => appendFileSync(LOG, '\n' + text),
  exportTriples: () => exportTriples(),
  analyseDenials: (summary) => analyseDenials(summary),
  exportGateLines: () => exportGateLines(),
  exportGateOutcomes: () => exportGateOutcomes(),
  // Phase 4: the per-wave identity assertion re-runs the spec loader's own
  // check (sealed paths exist, base is a commit, nothing brief-visible names
  // the instrument), and the authority registry reads the retained seats store
  // under this home. Both are seams so a unit test never touches git or ~/.cynco.
  checkIdentity: (spec) => checkIdentity(spec),
  seatsHome: () => cyncoHome(),
  // Phase 4: the per-rule S5 verdicts are recomputed from the whole ledger at
  // every VERDICT and written under <datasetsHome>/datasets/ for the engine.
  // Seams for the same reason as seatsHome: a unit test must never read the
  // real ledger shards or write into ~/.cynco.
  readLedgerRows: () => readLedger(),
  datasetsHome: () => cyncoHome(),
  writeRuleVerdicts: (args) => writeRuleVerdicts(args),
  // Phase 5 ruling 5: the outcome hindcast. Seams so a unit test never reads
  // the live ledger into ~/.cynco or spawns python (scripts/cynco-hindcast.mjs).
  exportOutcomeDataset: (args) => exportOutcomeDatasets(args),
  // Phase 7 ruling 1: the reading unit's interval dataset (and its one-time
  // `reading:2` holdout freeze) — a seam for the same reason.
  exportReadingDataset: (args) => exportReadingDataset(args),
  runHindcast: (args) => runHindcast(args),
  // Phase 4 ruling 4: the checklist is pure over facts the VERDICT already
  // holds; a seam only so a test can prove a throw never faults the wave.
  assessAutopoiesis: (args) => campaignAssessment(args),
  // Phase 5 ruling 2: the scoreboard, pure like the checklist above; the seam
  // exists so a test can prove a throw never faults the wave. The verdict file
  // it reads is the one writeRuleVerdicts just rewrote.
  scoreboard: (args) => campaignScoreboard(args),
  readRuleVerdicts: (path) => readRuleVerdicts(path),
}

/**
 * Everything the brief generator needs about where the campaign stands.
 * Shared by runWave and `--dry-run` so the dry run prints the brief the next
 * wave would actually receive, not an approximation of it.
 */
export function waveContext(spec, s, io = defaultIo) {
  const wave = s.waveCount + 1
  const base = s.lastBase ?? spec.base
  // NOT `wave === 1 ? calibration : lastGrade`: a faulted wave advances
  // waveCount without ever producing a grade, so wave 2 can legitimately have
  // no lastGrade. Falling back to the calibration keeps the campaign resumable
  // instead of bricking it with a TypeError on the next invocation.
  const fails = s.lastGrade?.gate.fails ?? s.calibration?.baseFails ?? []
  const passes = s.lastGrade?.gate.passes ?? s.calibration?.basePasses ?? []
  const prior = s.lastRow
    ? { missionId: s.lastRow.missionId, exitReason: s.lastRow.exitReason, durationS: s.lastRow.durationS, commits: s.lastCommits ?? [], toolStats: s.lastRow.toolStats, invariants: s.lastRow.invariants ?? null, verify: s.lastRow.verify, posiwid: s.lastGrade?.posiwid ?? null }
    : null
  const salvage = s.lastRow ? io.salvageOf(s.lastRow.missionId) : null
  return { wave, base, fails, passes, prior, salvage, ideation: null,
           ideationAuthority: s.ideationAuthority ?? 0, invariants: effectiveInvariants(spec, s), denialDigest: s.denialAnalysis?.invariants ?? null }
}

/**
 * Phase 5 Task 1: the roadmap follows the campaign. `sealed → running` when the
 * runner first dispatches a wave, `running`/`sealed → done` when a wave passes.
 * Only a line whose status is in `from` moves; a spec that is not on the
 * roadmap (the s1 smoke campaign) is skipped silently; any other status (a
 * `done` line a resumed campaign passes again) is left as it is and logged.
 * Forward-only is `setLineStatus`'s rule — its refusal is caught and logged,
 * never a wave fault: the roadmap is a view of the campaign, not its state.
 * Returns true when the file was rewritten.
 */
export function moveRoadmapLine(roadmapPath, id, to, from) {
  if (!roadmapPath) return false
  let roadmap
  try { roadmap = loadRoadmap(roadmapPath) } catch (e) {
    console.error(`[campaign] roadmap not read, ${id} not moved to ${to}: ${e?.message ?? e}`)
    return false
  }
  const line = roadmap.lines.find(l => l.id === id)
  if (!line) return false
  if (line.status === to) return false
  if (!from.includes(line.status)) {
    console.log(`[campaign] roadmap ${id} is ${line.status}, not ${from.join('/')} — left as is`)
    return false
  }
  const was = line.status
  try {
    setLineStatus(roadmap, id, to)
    saveRoadmap(roadmapPath, roadmap)
  } catch (e) {
    console.error(`[campaign] roadmap ${id} stays ${was}: ${e?.message ?? e}`)
    return false
  }
  console.log(`[campaign] roadmap ${id}: ${was} → ${to}`)
  return true
}

/** The roadmap file as a commit pathspec — only when it lives inside the repo. */
export const roadmapFileIn = (roadmapPath) => {
  const rel = repoRel(resolve(roadmapPath))
  return rel.startsWith('..') || /^[A-Za-z]:/.test(rel) || rel.startsWith('/') ? [] : [rel]
}

/**
 * `opts.roadmapPath`: where the roadmap moves above are written. `main` passes
 * its `deps.roadmapPath`; the default io defaults to the checked-in
 * ROADMAP_PATH, and an injected io without one moves nothing — a test's fake
 * wave must never rewrite the live roadmap.
 */
export async function runWave(spec, state, io = defaultIo, opts = {}) {
  const roadmapPath = opts.roadmapPath ?? io.roadmapPath ?? (io === defaultIo ? ROADMAP_PATH : null)
  const s = state.state
  // M4: `--approve-proposal` runs as a SECOND process while this one sleeps
  // out a wall clock. Its decision only reaches this object on the next save
  // — which is AFTER the dispatch that was supposed to carry the approved cap.
  // Read it in before the terms are computed, so an approval granted between
  // two waves is honoured by the very next one.
  state.adoptExternalDecisions()
  const ctx = waveContext(spec, s, io)
  const { wave, base, fails, prior } = ctx
  // Rule 11 is not a one-off: the calibration is evidence about the instrument
  // it was run against, and a gate edited mid-campaign (a fix, a rebase, a
  // hand-tweak) makes every reading after it incomparable with wave 1's. Check
  // the sha BEFORE anything is generated or dispatched; main's CALIBRATE will
  // re-run on the next invocation and the campaign continues from there.
  const sha256 = io.sha256 ?? defaultIo.sha256
  const gateSha256 = sha256(spec.gate)
  // The positive shim is part of the instrument (Rule 14): it decides whether
  // the gate was ever reachable, so moving it invalidates the calibration too.
  // The refusal NAMES which of the three moved — the operator's next move is to
  // look at that file, and "gate or perturb" sends them to the wrong one.
  const moved = s.calibration
    ? [['gate', gateSha256 !== s.calibration.gateSha256],
       ['perturb', sha256(spec.perturb) !== s.calibration.perturbSha256],
       ['positive shim', Boolean(spec.positive) && sha256(spec.positive) !== s.calibration.positiveSha256]]
      .filter(([, changed]) => changed).map(([name]) => name)
    : []
  if (moved.length) {
    return stopWave(spec, state, io, { wave, base, why: `${moved.join(' and ')} changed since calibration — re-run to recalibrate` })
  }
  // The identity assertion at VERDICT asks whether THIS wave's re-check ran,
  // not whether some earlier one did: a wave that skipped it is ungraded
  // against its own instrument, whatever the calibration on record says.
  s.rule11CheckedWave = wave
  const registry = authorityRegistry(s, { seatsHome: io.seatsHome?.() ?? null })
  const commander = registry.whoCommands('brief')?.component ?? 'generator'

  let ideation = null, ideationMeta = null
  let missionId, row, briefFile, dispatchedAt, waveFiles, workOrder
  // The roadmap pathspec, once THIS wave moved the line (`sealed → running` at
  // dispatch, `→ done` just before the verdict commit). Every commit this wave
  // makes — the verdict's or the fault path's — carries it, so a moved roadmap
  // is never left dirty for the next invocation's dirty-tree guard.
  let roadmapFiles = []
  const roadmapPathspec = (p) => (io.roadmapFileIn ?? roadmapFileIn)(p)
  // Phase 4 ruling 4: did the campaign-to-date denial digest (ledger →
  // validation) reach THIS wave's brief? The same predicate pacing() used to
  // print it (pacingDigestIncluded), recorded as `s4.pacingFromDenials`; an
  // adopted wave's brief was not written here, so false.
  let pacingFromDenials = false
  // Phase 5 ruling 2: an adopted wave is a human hand-off (the adopt script or
  // `--adopt-inflight`) — the scoreboard counts it as an intervention, so the
  // record says so. Nothing else on the record distinguishes it.
  let adopted = false
  // Phase 6 ruling 2: the mid-wave gate readings (scripts/cynco-campaign-
  // progress.mjs). The tracker exists only for a wave this runner WAITS on;
  // `progressNote` says why there is none, so the verdict's `- Progress:` line
  // names the reason instead of printing an empty reading as a measurement.
  let tracker = null, progressNote = null
  // `retriedSpawns` (P-F155): how many of the probe's git spawns hit bun's
  // stale deadline and were retried this wave — on the record only when the
  // runner waited with a tracker.
  const progressFields = () => ({ progress: tracker ? tracker.progress : null, shadowDecisions: tracker ? tracker.shadowDecisions : null,
    progressNote: tracker ? tracker.note() : progressNote, ...(tracker ? { retriedSpawns: tracker.retriedSpawns() } : {}) })

  if (s.adoptedRow) {
    // ADOPT (scripts/cynco-campaign-adopt.mjs): this wave already RAN — it was
    // dispatched by hand, or by an invocation that died before grading — and
    // only its measurement is missing. Every step before GRADE is skipped on
    // purpose: DISPATCH would burn another wall clock on work already in the
    // repo, GENERATE would overwrite the brief the wave was actually given,
    // and ideation only exists to advise that brief.
    missionId = s.adoptedRow
    adopted = true
    row = io.readRow(missionId)
    if (!row) throw new Error(`adopted row ${missionId} is not in the ledger — adopt a missionId that exists`)
    briefFile = resolve(row.briefFile ?? join(BRIEFS_DIR, `${spec.id}-wave${wave}.txt`))
    dispatchedAt = row.dispatchedAt ?? null
    delete s.adoptedRow
    progressNote = 'adopted wave — the runner did not wait on it'
    // The brief was authored outside the runner, so its sidecar may not exist;
    // commitVerdict hands `files` straight to `git add`, where one missing
    // pathspec stages nothing at all.
    waveFiles = [repoRel(briefFile), repoRel(sidecarPath(briefFile))].filter(f => existsSync(f))
    workOrder = null
    console.log(`[campaign] ADOPT ${missionId} — grading a wave that already ran (brief ${repoRel(briefFile)}); GENERATE/DISPATCH/WAIT skipped`)
  } else {
    // An empty FAIL set means the last grade said PASS. The brief generator
    // would happily write THE MISSES with no lines under it and THE WORK with
    // no items in it, and the wave would spend eight hours on a blank order.
    // Stop instead — a green gate is not a reason to dispatch.
    if (fails.length === 0) return stopWave(spec, state, io, { wave, base, why: 'no failing gate lines to work — grade says PASS' })

    // Rule 11 / F163 (final review T7-M1): calibration and dispatch must look
    // at ONE commit. The wave is graded against `base` (the calibration point,
    // or the last graded HEAD), but dispatch-mission.sh starts the mission from
    // wherever the repo's HEAD is — a reused repo whose HEAD already carried
    // the work PASSed the s2 smoke on a wave that fixed nothing. Nothing ran
    // yet, so this is a stop, not a fault; the roadmap is untouched. Like
    // `roadmapPath`, the real read is the default io's (main passes defaultIo);
    // an injected io without `repoHead` is a test's fake repo and skips it.
    const repoHead = io.repoHead ?? (io === defaultIo ? defaultIo.repoHead : null)
    const head = repoHead ? repoHead(spec.repo, 'HEAD') : null
    const baseSha = repoHead ? repoHead(spec.repo, base) : null
    if (repoHead && (!head || !baseSha || head !== baseSha)) {
      const baseRead = !baseSha ? `${base} (unresolved)` : baseSha === base ? base : `${base} (${baseSha})`
      return stopWave(spec, state, io, { wave, base,
        why: `repo HEAD ${head ?? '(unresolved)'} is not the wave base ${baseRead} — `
          + `calibration and dispatch must look at one commit (Rule 11, F163): reset ${spec.repo} to ${base}, or adopt the wave that moved it` })
    }

    // S4, occupant B (advisory) — runs only while no engine holds the GPU.
    if (spec.ideation?.enabled) {
      const busy = await (io.engineLive ?? defaultIo.engineLive)()
      if (busy) {
        console.log('[campaign] ideation skipped — an engine is answering on 9161 and the wave must not share the GPU')
        ideationMeta = { taskPath: null, durationMs: 0, error: 'engine busy' }
      } else {
        const draft = generateBrief(spec, ctx)
        const r = await io.ideate({ spec, fails, prior, briefText: draft, stateDir: state.dir })
        ideation = r.ideation; ideationMeta = { taskPath: r.taskPath ?? null, durationMs: r.durationMs ?? null, error: r.error ?? null }
      }
    }

    // S4, occupant A (binding). One context object feeds both the brief text
    // and the work order it recorded — what is recorded must be what was
    // printed, never a second, independently-computed guess at it.
    const briefCtx = { ...ctx, ideation }
    const text = generateBrief(spec, briefCtx)
    workOrder = workOrderFor(spec, briefCtx)
    pacingFromDenials = pacingDigestIncluded(briefCtx)
    // checkIdentity guards the spec's own fields, but the ideation section is
    // written by a model that just read the repo. A brief naming the sealed
    // gate would be refused by sealedPaths mid-run, after the wall clock has
    // already started. Refuse to WRITE it instead.
    const leak = /heldout|gate_c\d|perturb_/.exec(text)
    if (leak) return stopWave(spec, state, io, { wave, base, why: `the generated brief names the sealed instrument "${leak[0]}" — refusing to write it (the S4 ideation section is the likely source)` })
    briefFile = resolve(BRIEFS_DIR, `${spec.id}-wave${wave}.txt`)
    io.writeBrief(briefFile, text, sidecarFor(spec))
    waveFiles = [repoRel(briefFile), repoRel(sidecarPath(briefFile))]

    // S3: dispatch with the terms.
    const stamp = basename(briefFile).replace(/\.[^.]*$/, '')
    const pidFile = `C:/tmp/driver_${stamp}.pid`, driverLog = `C:/tmp/driver_${stamp}.log`
    dispatchedAt = new Date().toISOString()
    // The first dispatch of a sealed line starts it running; the file joins
    // the wave's commit so the dirty-tree guard never sees it as foreign work.
    if (moveRoadmapLine(roadmapPath, spec.id, 'running', ['sealed'])) roadmapFiles = roadmapPathspec(roadmapPath)
    let waited
    try {
      const dispatched = await io.dispatch({ spec, briefFile, invariants: effectiveInvariants(spec, s), timeoutS: spec.budget.hoursPerWave * 3600, pidFile, driverLog })
      // Persist BEFORE waiting, the daemon's missionLedger discipline: from here
      // on a mission is out there on the GPU, and a runner that dies in the wait
      // must not let the NEXT invocation dispatch a second one on top of it.
      s.inFlight = { wave, missionId: null, briefFile, pidFile, driverLog, dispatchedAt }
      state.save()
      // Phase 6 ruling 2: gate progress, measured by the runner mid-wave and
      // never shown to the model — the readings reach this wave's record and
      // the runner's log only. Needs the probe io and the HEAD reader; a test's
      // injected io without them takes no readings (and says so).
      const probe = io.progressProbe ?? (io === defaultIo ? defaultProbeIo : null)
      if (probe && repoHead) {
        tracker = progressTracker({ spec, probe, headOf: (hooks) => repoHead(spec.repo, 'HEAD', hooks), clockMs: spec.budget.hoursPerWave * 3600 * 1000,
          startSha: baseSha ?? base, startFails: s.lastFails?.length ?? s.calibration?.baseFails?.length ?? fails.length,
          startFailIds: s.lastFails ?? fails.map(f => f.id), startPasses: ctx.passes?.length ?? null,
          dispatchedAtMs: Date.parse(dispatchedAt), everyMs: everyMsFor(spec),
          // Review M1: the gate's runtime as the start grade measured it (the
          // last verdict's gate run, else the calibration's BASE run), so the
          // cadence's 10 % rule and end-of-clock tail hold from the first tick.
          // Task 3 review N1: never a faulted grade's (its duration is the timeout).
          gateMs: seedGateMs(s) })
      } else progressNote = !probe ? 'no progress probe on this runner io' : 'no repo HEAD reader on this runner io'
      waited = await io.waitForDriver({ pidFile, driverLog, timeoutMs: (spec.budget.hoursPerWave * 3600 + 3600) * 1000, onTick: tracker?.onTick ?? null })
      missionId = waited.exited ? (waited.missionId ?? dispatched?.missionId ?? io.missionIdFrom?.(driverLog) ?? null) : null
      row = missionId ? io.readRow(missionId) : null
    } catch (e) {
      console.error(`[campaign] wave ${wave} dispatch/wait failed: ${e?.stack ?? e}`)
      return faultWave(spec, state, io, { wave, missionId: null, briefFile, base, dispatchedAt, files: [...waveFiles, ...roadmapFiles], progressFields: progressFields(),
        why: `dispatch or wait failed: ${e?.message ?? e}` })
    }
    if (!row) {
      const why = waited.exited ? 'driver exited without a ledger row'
        : waited.pidUnseen ? `driver pid ${waited.pidUnseen} was already invisible on the first probe — the PID handoff is broken and the mission may still be running unwatched (see ${driverLog})`
          : 'driver did not exit within the wall clock'
      return faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, files: [...waveFiles, ...roadmapFiles], progressFields: progressFields(), why })
    }
  }

  // Everything past this point is measurement and bookkeeping on a run that
  // already happened. A throw here (a gate that dies, a ledger shard that will
  // not rewrite, ntfy blowing up) must not lose the wave: record the fault,
  // spend the wave, and hand the decision back so the loop stops deliberately
  // rather than by exception.
  let appended = false
  try {
  // S3*: grade.
  const grade = await io.grade(spec, row)
  const commits = io.commitsBetween(spec.repo, row.commitRange?.base ?? base, row.commitRange?.head ?? base)
  const followed = ideation ? measureFollowed(ideation, io.firstCommitFiles?.(spec.repo, row.commitRange?.base, row.commitRange?.head) ?? [], fails) : null
  // decide() reads waveCount as "waves spent INCLUDING this one" — the state's
  // own counter is only advanced after the record is appended, so hand decide
  // the count this wave makes rather than the one before it.
  let decision = decide({ grade, state: { ...s, waveCount: wave }, spec, commitsLanded: commits.length, row })
  // Review M5: `sweepRetried` rides on the ROW too, so a dataset built from
  // rows alone can tell a refusal that survived its F164 --mutate retry from
  // one that was never retried (a reading carries `retried` on mutationSweep).
  io.patchRow(missionId, { verified: grade.verified, ...(grade.sweep ? { mutationSweep: grade.sweep } : {}), sweepFault: grade.sweepFault ?? null, sweepWhy: grade.sweepWhy ?? null, sweepRetried: grade.sweepRetried ?? false,
    gate: { sha: grade.sha, gateSha256, terminator: grade.gate.terminator, fails: grade.gate.fails.map(f => f.line), passes: grade.gate.passes.length, priorRegressions: grade.gate.priorRegressions, suiteRegressions: grade.suite.regressions, harnessFault: grade.gate.harnessFault ?? grade.suite.harnessFault ?? null },
    posiwid: { divergence: grade.posiwid.divergence, verdict: grade.posiwid.verdict, dominantObserved: grade.posiwid.dominantObserved } })

  // I2: the wave record goes on the record FIRST, before anything that reads
  // the record set. The export must include the wave it is the verdict for —
  // a dataset regenerated one wave behind is a dataset that never sees the
  // latest evidence — and `promotionProposal` must be able to raise the
  // proposal in the very wave whose followed × landed made the case. Only
  // `verdictSha` and `notified` cannot be known yet; they are patched onto
  // this same record below, once the verdict is committed and sent.
  // `gate.author` (Phase 3): who WROTE the bar this wave was judged against.
  // Every graded field of `grade.gate` is kept exactly as the grader produced
  // it — the author is added beside them, never substituted for one. It is the
  // join key the gate-line dataset needs: without it, a held line cannot be
  // attributed to the seat that sealed it, and the promotion has no denominator.
  // `spec.author` is already defaulted to 'human' by loadCampaignSpec; the
  // fallback here is for an adopted or hand-built spec that never went through it.
  const rec = { wave, missionId, briefFile, base, head: grade.sha, gateSha256, dispatchedAt, gradedAt: new Date().toISOString(), gate: { ...grade.gate, author: spec.author ?? 'human' }, suite: grade.suite, sweep: grade.sweep, sweepFault: grade.sweepFault ?? null, sweepWhy: grade.sweepWhy ?? null, sweepRetried: grade.sweepRetried ?? false, posiwid: grade.posiwid, verified: grade.verified,
    // Phase 5 ruling 2: the scoreboard's per-wave inputs, kept on the record so
    // a board is recomputable without the ledger — the wave's GPU seconds and
    // the runner's own commitsBetween count (not toolStats.commits).
    durationS: row.durationS ?? null,
    outcome: { landed: row.outcome === 'landed', exitReason: row.exitReason, commitsLanded: commits.length },
    s4: { generatorInput: { failIds: fails.map(f => f.id), priorMissionId: prior?.missionId ?? null }, ideation, ideationMeta, authority: s.ideationAuthority ?? 0, commander, followed, workOrder, pacingFromDenials },
    adopted, decision, verdictSha: null, notified: false,
    // Phase 6 rulings 2–3: the mid-wave gate readings and the shadow
    // `R1.no-progress` decisions taken at each (null with a note when the
    // runner took none — never an empty reading dressed as a measurement).
    ...progressFields() }
  state.appendWave(rec)
  appended = true

  // The Level 4 spine: every verdict regenerates the dataset and re-asks
  // whether the denials change anything. A failure here is logged, never a
  // fault — the dataset is rebuilt in full next time, so nothing is lost.
  //
  // I1: "campaign to date" is a claim about THIS campaign. The exporter's
  // pooled block is every run in the whole ledger — hand runs and other
  // campaigns included — so the campaign's own block is what a c8 verdict and
  // a c8 cap proposal must be built from. A summary with no block for this
  // campaign (nothing graded under it yet) falls back to the pool, and the
  // verdict line then says which of the two it is reading.
  let denialAnalysis = null, denialScope = 'campaign', ledgerRows = null
  try {
    const exported = io.exportTriples()
    ledgerRows = Array.isArray(exported?.rows) ? exported.rows : null
    const summary = exported.summary
    const camp = summary?.campaigns?.[spec.id]
    const scoped = camp?.denials ? { denials: camp.denials, quiet: camp.quiet ?? {} } : null
    denialScope = scoped ? 'campaign' : 'all runs'
    denialAnalysis = (io.analyseDenials ?? defaultIo.analyseDenials)(scoped ?? { denials: summary?.denials, quiet: summary?.quiet })
    s.denialAnalysis = denialAnalysis
  } catch (e) { console.error(`[campaign] triples export/analysis skipped: ${e?.message ?? e}`) }

  // Phase 4: is the campaign still the campaign? Asserted AFTER the triples
  // dataset is regenerated (it is evidence either way) and BEFORE any
  // proposal is computed — a campaign whose identity broke this wave has no
  // standing to ask for more authority or a wider cap. A violation outranks
  // every grade the way invariantsRejected does in decide(): the wave is a
  // fault, and the record, the verdict line, the commit message and the
  // notification all say which invariant broke. It is pure over the spec,
  // state and row (cynco-identity.mjs), and it runs BEFORE the rule ladder so
  // the runner row reads this wave's FINAL decision as `R1.no-progress`'s
  // outcome — a pass the identity check turns into a fault is a failure there
  // too, on this verdict and not only the next one (Task 4 review M6).
  const identity = assertIdentityIntact({ spec, state: s, wave, row, io })
  rec.identity = identity
  if (!identity.intact) {
    decision = { kind: 'fault', why: `identity violated: ${identity.violated.join(' ')}` }
    rec.decision = decision
    console.error(`[campaign] wave ${wave} IDENTITY VIOLATED: ${identity.violated.map(n => `${n} (${identity.evidence[n].detail})`).join('; ')}`)
  }

  // Phase 4: the per-rule S5 verdicts, rewritten for the engine from the whole
  // ledger (not this campaign's slice — a rule's predictive power is a claim
  // about every mission it fired on). The rows the triples export already read
  // are reused; the ledger is read again only when that export did not hand
  // them back. Same discipline as the datasets above: derived, rebuilt in full
  // next time, so a failure is logged and never faults the wave.
  rec.ruleVerdicts = null
  rec.hindcast = null
  // The rows read here are kept for the scoreboard below, so the ledger is
  // never walked twice in one VERDICT.
  let verdictRows = null
  try {
    verdictRows = ledgerRows ?? (io.readLedgerRows ?? defaultIo.readLedgerRows)()
    const rows = verdictRows
    const home = (io.datasetsHome ?? defaultIo.datasetsHome)()
    const outPath = RULE_VERDICTS_PATH(home)
    // Phase 5 ruling 5: the outcome hindcast — export the prefix-only
    // datasets, retrain the two models in python, and hand their held-out
    // predictions to the ladder as `M1.*` rows. A measurement, never a gate:
    // any fault (python or sklearn missing, TOO FEW, a crash, a timeout) is
    // `rec.hindcast = { fault }` and the rule verdicts are written without
    // model rows. A stale outcome-model.json from an earlier wave is never read.
    let modelRows = []
    try {
      const exported = (io.exportOutcomeDataset ?? defaultIo.exportOutcomeDataset)({ rows, home })
      // The holdout as the manifest sees it per K (ineligible / missing ids named).
      const split = exported?.split ? { split: exported.split } : {}
      // F165: the one signals version the learner trained on, and how many
      // eligible missions each version had — on a fault too.
      const signals = typeof exported?.signalsVersion === 'number' ? { signalsVersion: exported.signalsVersion, rowsByVersion: exported.rowsByVersion ?? {} } : {}
      if (!hindcastReady(exported)) {
        rec.hindcast = { fault: noEligibleFault(exported, PRIMARY_TURNS), ...signals, ...(exported?.holdout ? { holdout: exported.holdout } : {}), ...split }
      } else {
        const h = hindcastOf((io.runHindcast ?? defaultIo.runHindcast)({ paths: exported.paths }), exported.paths.out)
        if (h.fault) rec.hindcast = { fault: h.fault, ...signals, ...split }
        // Task 2 review N3: `holdout` rides the success path too — on the wave
        // whose export froze v2's set it reads `frozenNow: true`, and the
        // verdict entry names the freeze (the manifest is committed with it).
        else { rec.hindcast = { ...h.summary, ...split, ...(exported?.holdout ? { holdout: exported.holdout } : {}) }; modelRows = modelRowsFrom(h.model, rows) }
      }
    } catch (e) { rec.hindcast = { fault: String(e?.message ?? e) } }
    if (rec.hindcast?.fault) console.error(`[campaign] outcome hindcast not measured: ${rec.hindcast.fault}`)
    // Phase 7 ruling 1: the reading learner, beside the mission one (which
    // stays primary) — the interval dataset over every runner-driven
    // campaign's waves (this one's included, as the runner rows read them),
    // its own `reading:2` holdout frozen once by the same rule, the model run
    // with `--unit reading`, its held-out predictions on the ladder as `M2.*`.
    // Below the minimum it is `{ fault: 'reading holdout not yet frozen (…)' }`
    // and python is not spawned. Its fault is its own: never the mission's,
    // never the wave's.
    let reading
    try {
      const waves = runnerWaves(join(home, 'campaigns'), { current: spec.id, entries: state.waveEntries(), rec }).map(({ record }) => record)
      const exportedR = (io.exportReadingDataset ?? defaultIo.exportReadingDataset)({ rows, waves, home })
      const rh = runReadingHindcast({ exported: exportedR, runHindcast: io.runHindcast ?? defaultIo.runHindcast })
      reading = rh.reading
      modelRows = [...modelRows, ...modelRowsFrom(rh.model, exportedR.intervals, { unit: 'reading' })]
    } catch (e) { reading = { fault: String(e?.message ?? e) } }
    if (reading.fault) console.error(`[campaign] reading hindcast not measured: ${reading.fault}`)
    rec.hindcast = { ...rec.hindcast, reading }
    // Phase 6 Task 4: the runner's shadow regulator `R1.no-progress` as a
    // runner row — one rule across campaigns, so its scope is this campaign's
    // waves (the one just recorded included) and every other runner-driven
    // campaign's under <home>/campaigns. Built by the ONE construction the
    // rule-verdicts CLI uses too (scripts/cynco-runner-rows.mjs, review I1).
    // Shadow: never authority, never the version. A malformed wave record is
    // skipped and named on the row; a fault reading the dir is logged and the
    // ladder is written without the row, never a fault of the wave.
    let runnerRows = []
    try { runnerRows = runnerRowsFromCampaigns(join(home, 'campaigns'), { current: spec.id, entries: state.waveEntries(), rec }) }
    catch (e) { console.error(`[campaign] runner rows (R1.no-progress) not read: ${e?.message ?? e}`) }
    const write = io.writeRuleVerdicts ?? defaultIo.writeRuleVerdicts
    try {
      rec.ruleVerdicts = write({ rows, campaign: spec.id, outPath, modelRows, runnerRows })
    } catch (e) {
      // Final review M1 (T5-M1): a throw on the MODEL rows must not leave the
      // previous wave's file for the engine to read, stale. The rules' verdicts
      // are rewritten alone (with the runner rows, which do not depend on the
      // hindcast); the hindcast says its ladder faulted, and the record says
      // the model rows were skipped. A throw without model rows is the rules'
      // own and falls through to the outer catch as before.
      if (!modelRows.length) throw e
      const message = String(e?.message ?? e)
      console.error(`[campaign] rule verdicts with the model rows failed (${message}) — rewriting the rules alone`)
      if (rec.hindcast) rec.hindcast.ladderFault = message
      if (rec.hindcast?.reading && !rec.hindcast.reading.fault) rec.hindcast.reading.ladderFault = message
      rec.ruleVerdicts = { ...write({ rows, campaign: spec.id, outPath, modelRows: [], runnerRows }), modelRowsSkipped: true }
    }
    // The ladder's reading of each model row (verdict, precision, CI, p(Holm)),
    // kept on the hindcast beside the model's own holdout metrics — the M1.*
    // rows on the mission hindcast, the M2.* rows on its reading (Phase 7).
    const ladders = modelLaddersOf(rec.ruleVerdicts?.models)
    if (rec.hindcast && !rec.hindcast.fault) rec.hindcast.ladder = ladders.mission
    if (rec.hindcast?.reading && !rec.hindcast.reading.fault) rec.hindcast.reading.ladder = ladders.reading
  } catch (e) {
    console.error(`[campaign] rule verdicts skipped: ${e?.message ?? e}`)
    // T5-M1: a fault before the learners ran (the ledger unreadable) is the
    // reading unit's too, so the entry's `; readings:` clause still prints.
    const fault = `not run: ${e?.message ?? e}`
    if (!rec.hindcast) rec.hindcast = { fault, reading: { fault } }
    else if (!rec.hindcast.reading) rec.hindcast.reading = { fault }
  }

  // 2d: POSIWID on the governance layer itself, one window per wave.
  let governance = null
  try {
    const proposalsDecided = (s.proposals ?? []).filter(p => p.decidedAt && p.decidedAt > (s.lastVerdictAt ?? '')).length
    const counts = governanceCounts({ row, wave: rec, proposalsDecided })
    // Phase 7 ruling 4: v2 states the purpose the authority table grants, read
    // from the verdict file THIS verdict wrote (a stale file from an earlier
    // wave is not this wave's table). No file → { earned: 0, total: 0 }; a file
    // that is there but unreadable, or a verdict that wrote none, is not
    // measured and says why. v1's fields stay exactly where they were.
    let v2
    try {
      if (!rec.ruleVerdicts) v2 = { verdict: null, reason: 'rule verdicts not written this verdict' }
      else {
        const path = RULE_VERDICTS_PATH((io.datasetsHome ?? defaultIo.datasetsHome)())
        const present = existsSync(path)
        const file = present ? (io.readRuleVerdicts ?? defaultIo.readRuleVerdicts)(path) : null
        v2 = present && !file ? { verdict: null, reason: `${path} unreadable` } : governancePosiwidV2(counts, authorityOf(file))
      }
    } catch (e) {
      console.error(`[campaign] governance POSIWID v2 not measured: ${e?.message ?? e}`)
      v2 = { verdict: null, reason: String(e?.message ?? e) }
    }
    // T4-M1: each stored window carries the authority v2 read it under
    // (`stated`, null when v2 was not measured), so v2 can be replayed over
    // the windows later the way v1 is.
    s.governancePosiwid = s.governancePosiwid ?? { windows: [] }
    s.governancePosiwid.windows.push({ wave, ...counts, stated: v2.stated ?? null })
    governance = { ...governancePosiwid(s.governancePosiwid.windows), v2 }
    rec.governancePosiwid = { ...governance, counts }
  } catch (e) { console.error(`[campaign] governance POSIWID skipped: ${e?.message ?? e}`) }

  // Phase 3: the gate-line dataset, regenerated with the same discipline as
  // the triples above — after the wave record is on disk (so the export sees
  // the wave it is the verdict for), and a failure is logged rather than
  // faulted, because the dataset is derived and rebuilt in full next time.
  let gateLines = null
  try { gateLines = (io.exportGateLines ?? defaultIo.exportGateLines)().summary ?? null }
  catch (e) { console.error(`[campaign] gate-lines export skipped: ${e?.message ?? e}`) }
  // Phase 4: the campaign-level outcome of every seal (refused / sealed / held /
  // resealed) — the evidence the line dataset cannot carry, because a refused
  // gate has no lines. Same discipline: derived, rebuilt in full, never a fault.
  try { (io.exportGateOutcomes ?? defaultIo.exportGateOutcomes)() }
  catch (e) { console.error(`[campaign] gate-outcomes export skipped: ${e?.message ?? e}`) }

  // §E: two proposals must not go pending in the same wave. promotionProposal
  // is computed FIRST; when it is about to be raised, capProposal is skipped
  // entirely (set to null) rather than called — calling it here would see
  // `s.proposals` before the promotion proposal below is pushed onto it, so
  // its own pending check could not see the truth.
  //
  // Both promotions are asked about the seat's EFFECTIVE authority — the
  // higher of this campaign's value and the retained seats store — so a fresh
  // campaign does not re-propose a promotion the seat already earned elsewhere.
  const seatsHome = io.seatsHome?.() ?? null
  const effective = (local, seat) => seatsHome ? Math.max(local ?? 0, seatAuthority(seatsHome, seat)) : (local ?? 0)
  const proposal = identity.intact ? promotionProposal(state.waves(), effective(s.ideationAuthority, 'ideation')) : null
  // The gate-author promotion (spec ruling 11) is the THIRD proposal that could
  // go pending in one wave, and §E does not care which of them got there first:
  // it is computed only when the ideation promotion is not about to be raised
  // AND nothing is already pending — including a `gate/<id>` the operator has
  // not decided yet, which is exactly the wrong moment to ask for more authority.
  const gatePromotion = identity.intact && !proposal && !(s.proposals ?? []).some(p => p.status === 'pending')
    ? gateAuthorPromotion(gateLines, effective(s.gateAuthorAuthority, 'gate-author'))
    : null
  const cap = !identity.intact || proposal || gatePromotion ? null : capProposal(denialAnalysis, spec, s)

  const sameFails = Array.isArray(s.lastFails) && grade.gate.fails.map(f => f.id).join() === s.lastFails.join()
  s.consecutiveNoProgress = sameFails && commits.length === 0 ? (s.consecutiveNoProgress ?? 0) + 1 : 0
  s.waveCount = wave; s.lastBase = grade.sha ?? base; s.lastFails = grade.gate.fails.map(f => f.id); s.lastGrade = grade; s.lastRow = row; s.lastCommits = commits
  s.lastVerdictAt = new Date().toISOString()
  delete s.inFlight
  if (proposal && !s.proposals.some(p => p.status === 'pending')) { s.proposals.push({ ...proposal, proposedAt: new Date().toISOString() }); await tryNotify(io, `${spec.id}: PROPOSAL ${proposal.name} ${s.ideationAuthority ?? 0} → ${proposal.newValue} (max ${proposal.bounds.max}, p=${proposal.evidence.p.toFixed(3)}). Approve with --approve-proposal ${proposal.name}`) }
  if (gatePromotion) { s.proposals.push({ ...gatePromotion, proposedAt: new Date().toISOString() }); await tryNotify(io, `${spec.id}: PROPOSAL ${gatePromotion.name} ${s.gateAuthorAuthority ?? 0} → ${gatePromotion.newValue} (max ${gatePromotion.bounds.max}) — ${gatePromotion.evidence.held}/${gatePromotion.evidence.n} CynCo gate lines held, ci lo ${gatePromotion.evidence.ci[0].toFixed(3)}. Approve with --approve-proposal ${gatePromotion.name}`) }
  if (cap) { s.proposals.push({ ...cap, proposedAt: new Date().toISOString() }); await tryNotify(io, `${spec.id}: PROPOSAL ${cap.name} ${cap.currentValue} → ${cap.newValue} (max ${cap.bounds.max}, p=${cap.evidence.pAdjusted.toFixed(3)}). Approve with --approve-proposal ${cap.name}`) }

  // Phase 4 ruling 4: the campaign autopoiesis checklist. It reads the identity
  // reading above (hasBoundary, organizationMaintained), and it is taken AFTER
  // §E so a proposal raised in this very wave counts as raised — the verdict
  // entry below prints that PROPOSAL line, and the checklist beside it must not
  // contradict it. Derived and re-runnable over the stored facts, so a throw is
  // recorded as `assessError` and never faults the wave.
  try {
    const waves = state.waves()
    rec.autopoiesis = (io.assessAutopoiesis ?? defaultIo.assessAutopoiesis)({ spec, state: s, waves, row, rows: campaignRows({ waves, ledgerRows, row }),
      gateLines, denialAnalysis, identity, commitsLanded: commits.length, seatAuthority: effectiveSeatAuthority(s, io.seatsHome?.() ?? null) })
  } catch (e) {
    rec.autopoiesis = { assessError: String(e?.message ?? e) }
    console.error(`[campaign] autopoiesis checklist not assessed: ${e?.message ?? e}`)
  }

  // Phase 5 ruling 2: the scoreboard — the four headline numbers for this
  // campaign to date, this wave included with its FINAL decision (the stored
  // copy of `rec` predates the identity check that can turn it into a fault).
  // The economics lines are read once here and printed below as before.
  // Derived and recomputable from the stored records, so a throw is recorded
  // as `{ error }` and never faults the wave.
  const economicsText = io.economics()
  try {
    const stored = state.waves()
    const boardWaves = stored.at(-1)?.wave === rec.wave ? [...stored.slice(0, -1), rec] : [...stored, rec]
    const ruleVerdictsFile = (io.readRuleVerdicts ?? defaultIo.readRuleVerdicts)(RULE_VERDICTS_PATH((io.datasetsHome ?? defaultIo.datasetsHome)()))
    rec.scoreboard = (io.scoreboard ?? defaultIo.scoreboard)({ spec, state: s, waves: boardWaves, rows: [row, ...(ledgerRows ?? verdictRows ?? [])], ruleVerdicts: ruleVerdictsFile, economics: economicsText })
  } catch (e) {
    rec.scoreboard = { error: String(e?.message ?? e) }
    console.error(`[campaign] scoreboard not computed: ${e?.message ?? e}`)
  }

  // Verdict (campaign log, economics, local commit, algedonic).
  const ideationRecord = ideation ? { authority: s.ideationAuthority ?? 0, hypotheses: ideation.hypotheses, followed } : null
  const entry = verdictEntry({ spec, wave, row, grade, decision, ideationRecord, economicsLines: economicsText, denialAnalysis, denialScope, capProposal: cap, governancePosiwid: governance, gateLines, identity, autopoiesis: rec.autopoiesis, scoreboard: rec.scoreboard, hindcast: rec.hindcast,
    // A wave the runner waited on with a probe prints its readings (or why
    // there were none); an adopted wave prints that it was not waited on. A
    // runner io with no probe at all took no measurement — no line, the way a
    // null hindcast prints none.
    progress: tracker || adopted ? rec : null,
    // Phase 6 Task 4: R1.no-progress, named with its verdict on the ladder line.
    runnerLadder: rec.ruleVerdicts?.runners ?? null })
  io.appendLog(entry)
  // Phase 5 Task 1 / final review I1: a pass finishes the roadmap line — read
  // off the FINAL decision (the identity check could still turn it into a
  // fault), and moved HERE, just before the commit (spec §3), after every step
  // that can throw. The line is forward-only: a `done` written before a later
  // throw would name a campaign with no PASS record, and leave the file dirty.
  if ((decision.kind === 'pass' || decision.kind === 'pass-with-survivors')
    && moveRoadmapLine(roadmapPath, spec.id, 'done', ['running', 'sealed'])) roadmapFiles = [...new Set([...roadmapFiles, ...roadmapPathspec(roadmapPath)])]
  // Ruling 5: commitVerdict matches these against `git status --porcelain`,
  // which speaks repo-relative forward slashes and nothing else.
  const files = [...new Set([LOG, ...waveFiles, ...roadmapFiles, ...ledgerShardsTouched()])]
  // F167: the runner runs from the campaign worktree (ensureCampaignCheckout at
  // startup), so this commit lands on the branch the tree is on; if someone
  // moved HEAD since, commitVerdict refuses rather than check anything out.
  try { rec.verdictSha = io.commit({ repoRoot: '.', branch: `campaign/${spec.id}`, files, message: `${spec.id.toUpperCase()} wave ${wave} verdict: ${decision.kind} — ${decision.why}` }).sha } catch (e) { console.error(`[campaign] commit skipped: ${e.message}`) }
  rec.notified = await notifyOrQueue(io, s, `${spec.id.toUpperCase()} wave ${wave}: ${decision.kind.toUpperCase()} — ${decision.why}\n${grade.gate.fails.map(f => f.line).join('\n')}`, decision)
  state.rewriteLastWave(rec)
  state.save()
  return rec
  } catch (e) {
    console.error(`[campaign] wave ${wave} post-run step failed: ${e?.stack ?? e}`)
    // The wave is already on the record when the throw came from the verdict
    // half; a second append would put the same wave in waves.jsonl twice and
    // double-count it in every promotion reading afterwards. Overwrite it.
    return faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, files: [...new Set([...(waveFiles ?? []), ...roadmapFiles])], appended, adopted, rowDurationS: row?.durationS ?? null, progressFields: progressFields(), why: `post-run step failed: ${e?.message ?? e}` })
  }
}

// notify is the last thing standing between a fault and silence; a throw from
// it must never be the reason the wave record goes unwritten.
const tryNotify = async (io, message) => {
  try { return Boolean(await io.notify(message)) } catch (e) { console.error(`[campaign] notify failed: ${e?.message ?? e}`); return false }
}

/** Queue what the algedonic channel could not deliver, and drain it when it can (spec §6). */
async function notifyOrQueue(io, s, message, decision) {
  const notified = await tryNotify(io, message)
  if (!notified) { s.pendingNotifications.push(decision); return false }
  s.pendingNotifications = await drainQueued(s.pendingNotifications, (n) => tryNotify(io, `(queued) ${n.kind} — ${n.why}`))
  return true
}

/**
 * Drain a notification queue into a local array and hand back what could not
 * be sent. `splice(0)` used to empty the queue BEFORE the re-send, so a channel
 * that came back for one message and dropped the next lost the queued verdicts
 * for good — nothing recorded that they were never delivered.
 */
export async function drainQueued(queue, send) {
  const pending = queue.splice(0)
  const failed = []
  for (const n of pending) {
    let ok = false
    try { ok = Boolean(await send(n)) } catch { ok = false }
    if (!ok) failed.push(n)
  }
  return failed
}

/**
 * A refusal to dispatch. It is NOT a spent wave — nothing ran — so waveCount
 * stays where it is; the record exists so the reason is in waves.jsonl and not
 * only in a console nobody was watching.
 */
async function stopWave(spec, state, io, { wave, base, why }) {
  const rec = { wave, missionId: null, briefFile: null, base, dispatchedAt: null, decision: { kind: 'stop', why } }
  rec.notified = await notifyOrQueue(io, state.state, `${spec.id.toUpperCase()} wave ${wave}: STOP — ${why}`, rec.decision)
  state.appendWave(rec)
  delete state.state.inFlight
  state.save()
  console.error(`[campaign] wave ${wave} STOP — ${why}`)
  return rec
}

/**
 * Ruling 8: a wave that faulted still SPENT a wave — counting it is what stops
 * a broken engine from burning the whole budget in a retry loop. The brief and
 * its sidecar are committed here too: they are untracked files the dirty-tree
 * guard would otherwise refuse on at the NEXT invocation, bricking the campaign
 * with work that never ran.
 */
async function faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, why, files, appended = false, adopted = false, rowDurationS = null, progressFields = null }) {
  const s = state.state
  const rec = { wave, missionId: missionId ?? null, briefFile, base, dispatchedAt, decision: { kind: 'fault', why } }
  // Phase 6: a wave that faulted in the WAIT (the wall clock ran out, the
  // driver left no row) keeps the mid-wave readings it did get — they are the
  // only measurement of what that wave did.
  if (progressFields?.progress) Object.assign(rec, progressFields)
  // A fault on a wave the operator handed over (`--adopt-inflight`, the adopt
  // script) is still that hand-off; the scoreboard counts it (Phase 5 ruling 2).
  if (adopted) rec.adopted = true
  // Task 2 review N1: a fault spent GPU time too. With no ledger row, a record
  // without `durationS` nulls the pooled PASS/GPU-h for good (an unmeasured
  // hour cannot make a denominator), so the fault carries its wall clock since
  // dispatch — `durationFrom: 'wall-clock'`, an upper bound (it includes the
  // wait for a driver that may have died early). The row's own duration wins
  // when there is one (a post-run step that threw). Never dispatched: null.
  const since = dispatchedAt ? Date.parse(dispatchedAt) : NaN
  if (Number.isFinite(rowDurationS)) { rec.durationS = rowDurationS; rec.durationFrom = 'row' }
  else if (Number.isFinite(since)) { rec.durationS = Math.max(0, Math.round(((io.now ?? Date.now)() - since) / 1000)); rec.durationFrom = 'wall-clock' }
  else rec.durationS = null
  if (files?.length) {
    try { io.commit?.({ repoRoot: '.', branch: `campaign/${spec.id}`, files, message: `${spec.id.toUpperCase()} wave ${wave} dispatched, faulted: ${why}` }) }
    catch (e) { console.error(`[campaign] fault-path commit skipped: ${e.message}`) }
  }
  rec.notified = await notifyOrQueue(io, s, `${spec.id} wave ${wave}: FAULT — ${why}`, rec.decision)
  // Task 3 review M2: the board on the fault record too — the dashboard reads
  // the LAST record carrying one, so a trailing fault without it undercounts
  // the campaign's waves until the next verdict. Same discipline as the
  // VERDICT's: derived, a throw is `{ error }`, never a second fault.
  try {
    const stored = state.waves()
    const boardWaves = appended && stored.at(-1)?.wave === wave ? [...stored.slice(0, -1), rec] : [...stored, rec]
    const ruleVerdictsFile = (io.readRuleVerdicts ?? defaultIo.readRuleVerdicts)(RULE_VERDICTS_PATH((io.datasetsHome ?? defaultIo.datasetsHome)()))
    const rows = (io.readLedgerRows ?? defaultIo.readLedgerRows)()
    rec.scoreboard = (io.scoreboard ?? defaultIo.scoreboard)({ spec, state: s, waves: boardWaves, rows, ruleVerdicts: ruleVerdictsFile, economics: io.economics ? io.economics() : null })
  } catch (e) {
    rec.scoreboard = { error: String(e?.message ?? e) }
    console.error(`[campaign] scoreboard not computed on the fault path: ${e?.message ?? e}`)
  }
  // I2: runWave appends the wave record before the verdict half runs, so a
  // throw from there arrives here with the wave ALREADY on the record. The
  // fault replaces it; appending would record the same wave twice.
  if (appended) state.rewriteLastWave(rec); else state.appendWave(rec)
  s.waveCount = wave
  delete s.inFlight
  state.save()
  return rec
}

/** The startup refusal: a wave the last invocation dispatched is still out there. */
export function inFlightRefusal(state) {
  const f = state.state?.inFlight
  if (!f) return null
  return `[campaign] wave ${f.wave} is in flight since ${f.dispatchedAt} (driver log ${f.driverLog}) — wait for it, then run --adopt-inflight`
}

/**
 * A RESEAL: a campaign that was already calibrated is being calibrated again,
 * so the bar moved under a run in progress.
 *
 * This is the falsifier for the whole gate-author claim. "CynCo's gate held"
 * means nothing if CynCo (or anyone) could quietly reword the gate mid-campaign
 * and then pass it — and the only moment that is observable is HERE, while the
 * runner still holds the calibration it is about to overwrite. Taken any later
 * the old line text is gone and every reseal reads as "nothing changed".
 *
 * Pure over the state object, and it records whether or not anyone wanted it
 * recorded: a first calibration is not a reseal and returns null.
 */
export function recordReseal(s, prev, next, { at, wave }) {
  if (!prev) return null
  const rec = resealRecord({ at, wave,
    from: { gateSha256: prev.gateSha256, lines: linesOf(prev) },
    to: { gateSha256: next.gateSha256, lines: linesOf(next) } })
  s.reseals = [...(s.reseals ?? []), rec]
  return rec
}

/**
 * `--adopt-inflight`: the operator says the in-flight wave is over. The ledger
 * line in the driver log is the proof it produced a mission; without it, a dead
 * pid is proof it produced nothing. A live pid is neither, so the refusal stands.
 */
export async function adoptInFlight(spec, state, io = defaultIo) {
  const f = state.state.inFlight
  if (!f) return { kind: 'none' }
  let missionId = null
  try { missionId = io.missionIdFrom(f.driverLog) } catch { missionId = null }
  if (missionId) {
    state.state.adoptedRow = missionId
    delete state.state.inFlight
    state.save()
    console.log(`[campaign] --adopt-inflight: wave ${f.wave} wrote ledger row ${missionId} — grading it`)
    return { kind: 'adopted', missionId }
  }
  if (io.pidAlive(f.pidFile)) return { kind: 'alive' }
  const rec = await faultWave(spec, state, io, { wave: f.wave, missionId: null, briefFile: f.briefFile, base: state.state.lastBase ?? spec.base, dispatchedAt: f.dispatchedAt, adopted: true,
    why: `driver is gone and wrote no ledger row (see ${f.driverLog})` })
  return { kind: 'fault', record: rec }
}

/**
 * One runner per campaign state dir. Two runners sharing it would dispatch two
 * waves onto one GPU and interleave their writes to state.json.
 */
export function takeLock(dir) {
  const path = join(dir, 'runner.lock')
  // `wx` is the atomic claim: the open fails when the file exists, so two
  // runners racing for one campaign cannot both write their pid and each read
  // the other's as "mine". Two passes: the first may find a stale lock and
  // remove it, the second claims — and if a third party claimed in between,
  // the second pass reads THEIR live pid and refuses.
  let pid = NaN
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      return { ok: true, path, pid: process.pid }
    } catch (e) { if (e?.code !== 'EEXIST') throw e }
    try { pid = Number(readFileSync(path, 'utf8').trim()) } catch { pid = NaN }
    if (pidIsAlive(pid)) return { ok: false, path, pid }
    console.log(`[campaign] removing a stale runner.lock (pid ${Number.isNaN(pid) ? 'unreadable' : pid} is gone)`)
    try { unlinkSync(path) } catch {}
  }
  return { ok: false, path, pid }
}

export function releaseLock(dir) {
  const path = join(dir, 'runner.lock')
  try { if (existsSync(path) && Number(readFileSync(path, 'utf8').trim()) === process.pid) unlinkSync(path) } catch {}
}

const pidIsAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }

function ledgerShardsTouched() {
  const out = spawnSync('git', ['status', '--porcelain', 'benchmark/cynco-ledger'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter(Boolean).map(l => l.slice(3).trim())
}

/**
 * The dirty-tree refusal, as a predicate over `git status --porcelain` lines.
 *
 * Two things are NOT someone's work in progress: the ledger shards every wave
 * rewrites, and THIS campaign's own wave briefs. A wave that faulted before its
 * verdict leaves its brief and sidecar untracked, and without this exemption
 * that debris refuses every later invocation — the campaign bricks itself on
 * files it wrote. Only untracked (`??`) briefs are exempt: an EDITED brief is a
 * human's change to an order and must still stop the runner.
 */
export function dirtyOutsideCampaign(porcelainLines, spec) {
  const brief = new RegExp(`^${BRIEFS_DIR}/${spec.id}-wave\\d+\\.(txt|contract\\.json)$`)
  return porcelainLines.filter(l => {
    const p = l.slice(3).trim().replace(/\\/g, '/')
    if (p.startsWith('benchmark/cynco-ledger/')) return false
    if (l.startsWith('??') && brief.test(p)) return false
    return true
  })
}

/** Has the campaign already spent every wave it was budgeted? */
export function budgetSpent(state, spec) {
  return (state.state.waveCount ?? 0) >= spec.budget.waves
}

// The economics script walks every Claude Code transcript; two minutes is
// generous and still bounds a verb an operator is waiting on.
export const ECONOMICS_TIMEOUT_MS = 120_000

/**
 * The economics lines — the VERDICT section of scripts/supervision-economics.mjs
 * (economicsLines) — spawned through runSync with ECONOMICS_TIMEOUT_MS. Both
 * readers use it: every wave VERDICT (`defaultIo.economics`) and
 * `--scoreboard`. A run that timed out, faulted or exited non-zero is null —
 * "the script did not run", which the board names — never an empty reading
 * that would pass for "no SUPERVISING figure". `hooks` is runSync's seam
 * (`spawn`, `now`), so the cap is tested where the spawn happens (F142).
 */
export function scoreboardEconomics(hooks = {}) {
  let failed = null
  const lines = economicsLines({ run: (cmd, args) => {
    const r = runSync(cmd, args, { timeoutMs: ECONOMICS_TIMEOUT_MS, retryImpossibleTimeout: true }, hooks)
    if (r.timedOut || r.fault || r.status !== 0) {
      failed = r.timedOut ? `timed out after ${ECONOMICS_TIMEOUT_MS} ms` : r.fault ? faultSummary(r.fault) : `exit ${r.status}`
      return ''
    }
    return r.stdout ?? ''
  } })
  if (failed) { console.error(`[campaign] economics: the economics script did not answer (${failed}) — supervision dollars unmeasured`); return null }
  return lines
}

/**
 * Every RUNNER-DRIVEN campaign's board under `campaignsDir` — a campaign is
 * runner-driven when its dir holds a `waves.jsonl` (spec ruling 2). A dir
 * without one is excluded and named, and so are the ledger missions no runner
 * campaign's wave record names (the hand-driven history). `current` is the
 * board already computed for the campaign asked about; it is reused, not
 * recomputed. Reads only.
 */
export function runnerDrivenBoards(campaignsDir, { current = null, rows = [], ruleVerdicts = null, economics = null } = {}) {
  const boards = [], excluded = []
  const runnerMissions = new Set()
  const names = existsSync(campaignsDir)
    ? readdirSync(campaignsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : []
  for (const name of names) {
    const cs = new CampaignState(join(campaignsDir, name))
    if (!existsSync(cs.wavesPath)) { excluded.push(`${name}: no waves.jsonl (not runner-driven)`); continue }
    const waves = cs.waves()
    for (const w of waves) if (w?.missionId) runnerMissions.add(w.missionId)
    if (current && current.id === name) { boards.push(current); continue }
    let st = {}
    if (existsSync(cs.statePath)) {
      try { st = JSON.parse(readFileSync(cs.statePath, 'utf8')) }
      catch (e) { boards.push({ id: name, error: `state.json is not JSON (${e.message})` }); continue }
    }
    boards.push(campaignScoreboard({ spec: { id: name }, state: st, waves, rows, ruleVerdicts, economics }))
  }
  const hand = (rows ?? []).filter(r => r?.missionId && !runnerMissions.has(r.missionId)).length
  if (hand) excluded.push(`${hand} ledger mission(s) outside any runner-driven campaign (hand-driven)`)
  return { boards, excluded }
}

/**
 * The authoring io, built here and handed over: `cynco-gate-author.mjs` never
 * imports this module (that would be an ESM cycle — the verb branches below
 * import IT), so the runner's dispatcher, driver wait, ledger reader, env
 * scrubber, lock and campaign-log append travel as data.
 */
function authorIo(author, roadmapPath = ROADMAP_PATH) {
  // Review #8: the roadmap seam, whole. `main`'s injectable `roadmapPath` was
  // read by the reject branch only; the approve branch and the author verbs
  // loaded and saved the checked-in file regardless. Every roadmap read and
  // write the author module makes now goes through the one path main was given
  // (the module passes ROADMAP_PATH as the save target; it is overridden here).
  return { ...authorIoBase(author), loadRoadmap: () => loadRoadmap(roadmapPath), saveRoadmap: (_p, r) => saveRoadmap(roadmapPath, r) }
}

function authorIoBase(author) {
  return author.defaultAuthorIo({ dispatchRaw: defaultIo.dispatchRaw, waitForDriver: defaultIo.waitForDriver, missionIdFrom: defaultIo.missionIdFrom,
    readRow: defaultIo.readRow, appendLog: defaultIo.appendLog, dispatchEnv, takeLock, releaseLock,
    // Phase 3: the auto-approve branch records its own decision, and the
    // algedonic channel says so — a seal no human approved must still page the
    // owner the moment it happens. `seatAuthority` is what makes the branch
    // reachable at all: the promotion is approved into the state of the
    // campaign that gathered the evidence, never into the fresh one being
    // authored, so the seat's authority has to be read across all of them.
    applyProposalDecision, notify: defaultIo.notify,
    seatAuthority: () => author.gateAuthorAuthorityAcrossCampaigns(join(cyncoHome(), 'campaigns')) })
}

/**
 * F167: a campaign runs from its own worktree; the operator's checkout is never
 * the runner's. The runner READS the campaign log, the roadmap and the ledger
 * shards from its working copy and commits its verdict there, so that working
 * copy has to BE `campaign/<id>`'s checkout — no commit technique can make the
 * verdict independent of a checkout the runner reads from.
 *
 * The refusal names the exact commands, by case: the branch is already checked
 * out in another worktree (go there), it exists (add a worktree on it), or it
 * does not exist yet (add a worktree that creates it at HEAD).
 */
export function campaignCheckoutRefusal({ id, current, branchExists, headSha7, checkedOutAt = null, rerun, worktreesRoot = '.claude/worktrees', dirtySeal = [] }) {
  const branch = `campaign/${id}`
  const dir = `${worktreesRoot}/campaign-${id}`
  const head = [`[campaign] ${id}: this checkout is on ${current || '(detached HEAD)'}, not ${branch}. A campaign runs from its own worktree; the operator's checkout is never the runner's (F167).`]
  if (checkedOutAt) return [...head, `${branch} is checked out at ${checkedOutAt} — run from there:`, `  cd ${checkedOutAt}`, `  ${rerun}`].join('\n')
  // T3 N1: a worktree created at HEAD carries only what HEAD holds.
  const seal = !branchExists && dirtySeal.length
    ? [`Commit the seal first: ${dirtySeal.join(', ')} ${dirtySeal.length === 1 ? 'is' : 'are'} uncommitted here, and a worktree created at HEAD would not carry ${dirtySeal.length === 1 ? 'it' : 'them'}.`]
    : []
  const add = branchExists ? `  git worktree add ${dir} ${branch}` : `  git worktree add ${dir} -b ${branch} ${headSha7}`
  return [...head, ...seal, `Run it from a worktree on ${branch}${branchExists ? '' : ` (the branch does not exist yet; this creates it at HEAD ${headSha7})`}:`,
    add, `  cd ${dir}`, '  npm install', `  ${rerun}`, STALE_WORKTREE_HINT(dir)].join('\n')
}

/** Final review M6: a removed worktree can leave its directory behind, and `git worktree add` then refuses. */
export const STALE_WORKTREE_HINT = (dir) => `If git worktree add says '${dir}' already exists, a removed worktree left it behind: `
  + 'git worktree prune, delete the directory, and run the add again — or add the worktree under another name.'

const defaultCheckoutGit = (repoRoot) => (args) => {
  const r = runSync('git', ['-C', repoRoot, ...args])
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * The startup guard for every runner path that writes to the repo (waves,
 * --dry-run's calibration, --adopt-inflight's verdict). `{ ok: true }` on
 * `campaign/<id>`; otherwise `{ ok: false, message }` from campaignCheckoutRefusal.
 * The printed worktree path is absolute when git names the common dir (T3 N2:
 * right whichever worktree the operator stands in), and a dirty spec or roadmap
 * is named first (T3 N1). `specPath` defaults to argv's first `.campaign.json`.
 */
export function ensureCampaignCheckout({ repoRoot = '.', id, argv = [], specPath = null, io } = {}) {
  const git = io?.git ?? defaultCheckoutGit(repoRoot)
  const branch = `campaign/${id}`
  const current = git(['branch', '--show-current']).stdout.trim()
  if (current === branch) return { ok: true }
  const branchExists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  const headSha7 = git(['rev-parse', '--short=7', 'HEAD']).stdout.trim()
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDir = common.status === 0 ? common.stdout.trim().replace(/\\/g, '/') : ''
  const worktreesRoot = /\/\.git$/.test(commonDir) ? `${commonDir.slice(0, -'/.git'.length)}/.claude/worktrees` : '.claude/worktrees'
  const sealFiles = [specPath ?? argv.find(a => /\.campaign\.json$/.test(String(a))), ROADMAP_PATH].filter(Boolean).map(p => String(p).replace(/\\/g, '/'))
  const st = git(['status', '--porcelain', '--', ...sealFiles])
  const dirtySeal = st.status === 0 ? st.stdout.split(/\r?\n/).filter(Boolean).map(l => l.slice(3).trim()) : []
  // `git worktree list --porcelain`: blocks of `worktree <path>` … `branch refs/heads/<b>`.
  let checkedOutAt = null
  let at = null
  for (const line of git(['worktree', 'list', '--porcelain']).stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) checkedOutAt = at
  }
  const rerun = `bun scripts/cynco-campaign.mjs ${argv.join(' ')}`.trimEnd()
  return { ok: false, message: campaignCheckoutRefusal({ id, current, branchExists, headSha7, checkedOutAt, rerun, worktreesRoot, dirtySeal }) }
}

export async function main(argv, deps = {}) {
  // Every path below reaches for a repo-relative path (scripts/, docs/,
  // benchmark/cynco-ledger/). Run from anywhere else and the first symptom is
  // a brief written into the wrong tree, not an error.
  // A campaign run's root is its own worktree (`.claude/worktrees/campaign-<id>`,
  // F167); the authoring and report verbs run from any localcode checkout's root.
  if (!existsSync('scripts/dispatch-mission.sh')) { console.error('[campaign] run from the root of a localcode checkout — for a campaign run, its worktree\'s root (.claude/worktrees/campaign-<id>, F167)'); return 2 }
  // F160: a missing Git Bash is a refusal up front, not a spent, faulted wave
  // an hour from now (dispatch is the first spawn). Asked only on the paths
  // that WILL spawn bash — `--author` (the BASE archive, the dispatch) and the
  // runner (CALIBRATE's archive, the wave dispatch, `--adopt-inflight`'s
  // grade), each before it touches state. The read-only and decision verbs
  // (`--autopoiesis`, `--check`, `--approve-proposal` / `--reject-proposal`
  // incl. `gate/<id>`, whose seal re-checks against the staged BASE dir,
  // `--sync`) spawn no bash and must not be refused for its absence.
  const needGitBash = () => {
    try { (deps.bashExe ?? bashExe)(); return true } catch (e) { console.error(`[campaign] ${e.message}`); return false }
  }
  const flag = (n) => argv.indexOf(n)
  const loadAuthor = deps.authorModule ? async () => deps.authorModule : () => import('./cynco-gate-author.mjs')
  // Injectable because the reject path WRITES it, and a test that redirects
  // CYNCO_HOME still shares this repo-relative file with the live campaign: the
  // first cut of `--reject-proposal` rewound the checked-in c9 line from
  // `proposed` to `authoring` every time the suite ran.
  const roadmapPath = deps.roadmapPath ?? ROADMAP_PATH

  // ── the gate-authoring verbs ───────────────────────────────────────────
  //
  // These run BEFORE loadCampaignSpec, and that ordering is the whole point:
  // `<id>.campaign.json` is what the authoring run PRODUCES. Requiring it here
  // would make the verb that writes a campaign spec depend on the campaign
  // spec already existing. The id comes from `--author <id>` / the proposal
  // name, falling back to the argv path's basename, and the state is loaded by
  // id (created with freshState when this campaign has no state dir yet).
  const specPath = argv.find(a => a.endsWith('.campaign.json'))
  const pathId = specPath ? basename(specPath).replace(/\.campaign\.json$/, '') : null
  if (flag('--check') !== -1) {
    const author = await loadAuthor()
    return await author.authorMain(argv, authorIo(author, roadmapPath))
  }
  if (flag('--author') !== -1) {
    const named = argv[flag('--author') + 1]
    const id = named && !named.startsWith('--') ? named : pathId
    if (!id) { console.error('usage: bun scripts/cynco-campaign.mjs --author <id>'); return 2 }
    if (pathId && named && !named.startsWith('--') && pathId !== named) {
      console.error(`[campaign] --author ${named} was given alongside ${specPath} — name one campaign, not two`); return 2
    }
    if (!needGitBash()) return 2
    const author = await loadAuthor()
    // `--note <file>` rides through: a supervisor refusal's CONTENT belongs in the
    // next resume's brief, and this is the only path that writes one.
    const noteIdx = flag('--note')
    const forward = noteIdx !== -1 && argv[noteIdx + 1] ? ['--author', id, '--note', argv[noteIdx + 1]] : ['--author', id]
    return await author.authorMain(forward, authorIo(author, roadmapPath))
  }
  const decisionIdx = flag('--approve-proposal') !== -1 ? flag('--approve-proposal') : flag('--reject-proposal')
  const decisionName = decisionIdx !== -1 ? argv[decisionIdx + 1] : null
  if (decisionName?.startsWith('gate/')) {
    const approve = flag('--approve-proposal') !== -1
    const id = decisionName.slice('gate/'.length)
    if (!id) { console.error('[campaign] --approve-proposal gate/<id> needs a campaign id'); return 2 }
    const state = new CampaignState(join(cyncoHome(), 'campaigns', id)).load()
    if (!approve) {
      const r = applyProposalDecision(state.state, decisionName, false)
      if (!r.ok) { console.error(r.why); return 2 }
      // A refusal has to REOPEN the line, or the campaign is stuck: `--author`
      // refuses a `proposed` line and `nextOpenLine` holds every later line behind
      // it, so a DO-NOT-SEAL verdict would leave the gate neither sealable nor
      // re-authorable. `rejectLine` is the one backward move the ladder permits.
      const roadmap = loadRoadmap(roadmapPath)
      let reopened = false
      try { rejectLine(roadmap, id); saveRoadmap(roadmapPath, roadmap); reopened = true }
      catch (e) { console.error(`[campaign] proposal rejected, but the roadmap line was not reopened: ${e.message}`) }
      // The note is the refusal's CONTENT, and the next resume's brief is the only
      // place it can do any work. Recorded by path, not copied: the reviewer's file
      // stays the one source, and a resume with no `--note` reuses the last one.
      const notePath = flag('--note') !== -1 ? argv[flag('--note') + 1] : null
      if (notePath) {
        const a = state.state.authoring?.[id]
        if (a) {
          a.refusals = a.refusals ?? []
          a.refusals.push({ at: new Date().toISOString(), by: 'supervisor', notePath })
        } else {
          console.error(`[campaign] --note given but state has no authoring.${id} to record it against`)
        }
      }
      state.save()
      console.log(`[campaign] proposal ${decisionName} ${r.status}${reopened ? '; roadmap line reopened to authoring' : ''}`
        + `${notePath ? `; supervisor note recorded (${notePath})` : ''}`)
      return 0
    }
    // SEAL FIRST, decide after. Recording the approval up front made a refused
    // seal a dead end: the proposal was no longer `pending`, so there was
    // nothing left for the operator to approve once the draft was fixed, and
    // the roadmap said `sealed` for a campaign that had not been. Nothing
    // about the decision is lost by taking it second — sealGate writes nothing
    // visible until every check has passed.
    if (!(state.state.proposals ?? []).some(p => p.name === decisionName && p.status === 'pending')) {
      console.error(`no pending proposal ${decisionName}`); return 2
    }
    const author = await loadAuthor()
    const roadmap = loadRoadmap(roadmapPath)
    const sealed = await author.sealGate({ id, state, roadmap, io: authorIo(author, roadmapPath) })
    if (!sealed.ok) {
      console.error(`[campaign] SEAL REFUSED for ${id} — the proposal stays pending and the roadmap line stays proposed:\n  ${sealed.problems.join('\n  ')}`)
      return 2
    }
    const r = applyProposalDecision(state.state, decisionName, true)
    if (!r.ok) { console.error(r.why); return 2 }
    state.save()
    console.log(`[campaign] ${id} sealed: ${sealed.specPath} written, triple copied, roadmap line sealed; proposal ${decisionName} ${r.status}`)
    return 0
  }

  if (!specPath) { console.error('usage: bun scripts/cynco-campaign.mjs <id>.campaign.json [--waves N] [--resume] [--dry-run] [--sync] [--adopt-inflight] [--autopoiesis] [--scoreboard] [--approve-proposal NAME] [--reject-proposal NAME] | --author <id> | --check <stagingDir> <baseDir>'); return 2 }
  // The runner (waves, --dry-run, --adopt-inflight) spawns bash; the verbs
  // below that return before the lock do not. Asked before the spec is read
  // and before CampaignState.load() creates anything.
  const verbOnly = ['--autopoiesis', '--scoreboard', '--approve-proposal', '--reject-proposal', '--sync'].some(f => flag(f) !== -1)
  if (!verbOnly && !needGitBash()) return 2
  const spec = loadCampaignSpec(specPath)
  // F167: the runner (waves, --dry-run, --adopt-inflight) reads and commits the
  // campaign's files in its working copy, so it runs only from the campaign's
  // own worktree. The verbs above the lock write nothing to the repo (state
  // lives under CYNCO_HOME; --sync pushes the branch ref, which works from any
  // checkout) and run anywhere. Asked before the identity check, which already
  // reads repo files.
  if (!verbOnly) {
    const co = ensureCampaignCheckout({ repoRoot: '.', id: spec.id, argv, specPath, io: deps.git ? { git: deps.git } : undefined })
    if (!co.ok) { console.error(co.message); return 2 }
    // Final review M4: a suite gate the env prefix cannot carry is refused
    // here, once, rather than faulting every wave at dispatch.
    const gateRefusal = suiteGateRefusal(spec)
    if (gateRefusal) { console.error(gateRefusal); return 2 }
  }
  // Phase 4 ruling 4: `--autopoiesis` is a dry report over what the campaign
  // already stored — the last graded wave's identity reading, the ledger rows
  // the runner reads, the last regenerated gate-lines dataset. It runs before
  // the spec's identity check on purpose: a campaign whose identity broke is
  // exactly one whose checklist an operator wants to read (hasBoundary false).
  // It dispatches nothing, takes no lock and writes nothing.
  if (flag('--autopoiesis') !== -1) {
    // Not CampaignState.load(): it creates the directory and renames a corrupt
    // state.json aside, and a report must leave the campaign exactly as it was.
    const state = new CampaignState(join(cyncoHome(), 'campaigns', spec.id))
    if (!existsSync(state.statePath)) { console.error(`[campaign] --autopoiesis: no campaign state at ${state.statePath} — nothing has run to assess`); return 2 }
    try { state.state = JSON.parse(readFileSync(state.statePath, 'utf8')) }
    catch (e) { console.error(`[campaign] --autopoiesis: ${state.statePath} is not JSON (${e.message}) — refusing to assess it`); return 2 }
    const ledgerRows = (deps.readLedgerRows ?? defaultIo.readLedgerRows)()
    const gateLinesPath = GATE_LINES_PATH()
    let gateLines = null
    if (existsSync(gateLinesPath)) {
      try { gateLines = summarizeGateLines(readFileSync(gateLinesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))) }
      catch (e) { console.error(`[campaign] ${gateLinesPath} unreadable, no gate-line evidence counted: ${e.message}`) }
    }
    // The seat authority the runner's VERDICT reads (state values and the
    // retained seats store under this home), so verb and runner cannot disagree
    // on configuration → seat.
    const a = storedAssessment({ spec, state: state.state, waves: state.waves(), ledgerRows, gateLines,
      seatAuthority: effectiveSeatAuthority(state.state, defaultIo.seatsHome()) })
    console.log(JSON.stringify(a, null, 2))
    console.log(autopoiesisLine(a))
    return 0
  }
  // Phase 5 ruling 2: `--scoreboard` is the same kind of dry report — this
  // campaign's board from its stored records, then the pooled board over every
  // runner-driven campaign under this home. Dispatches nothing, takes no lock,
  // writes nothing.
  if (flag('--scoreboard') !== -1) {
    const home = cyncoHome()
    const state = new CampaignState(join(home, 'campaigns', spec.id))
    if (!existsSync(state.statePath)) { console.error(`[campaign] --scoreboard: no campaign state at ${state.statePath} — nothing has run to score`); return 2 }
    let st
    try { st = JSON.parse(readFileSync(state.statePath, 'utf8')) }
    catch (e) { console.error(`[campaign] --scoreboard: ${state.statePath} is not JSON (${e.message}) — refusing to score it`); return 2 }
    const ledgerRows = (deps.readLedgerRows ?? defaultIo.readLedgerRows)()
    const ruleVerdicts = readRuleVerdicts(RULE_VERDICTS_PATH(home))
    const economics = (deps.economics ?? scoreboardEconomics)()
    const waves = state.waves()
    const board = campaignScoreboard({ spec, state: st, waves, rows: ledgerRows, ruleVerdicts, economics })
    for (const l of scoreboardLines(board, { detail: true })) console.log(l)
    // The latest hindcast on the record, in full: the entry line counts the
    // dropped dead columns, this names them.
    const hc = [...waves].reverse().find(w => w?.hindcast)?.hindcast
    const hcLine = hindcastLine(hc, { detail: true })
    if (hcLine) console.log(hcLine)
    const pool = runnerDrivenBoards(join(home, 'campaigns'), { current: board, rows: ledgerRows, ruleVerdicts, economics })
    console.log('')
    for (const l of scoreboardLines(pooledScoreboard(pool.boards, { excluded: pool.excluded }))) console.log(l)
    return 0
  }
  const identity = checkIdentity(spec)
  if (!identity.ok) { console.error('[campaign] IDENTITY VIOLATION:\n  ' + identity.problems.join('\n  ')); return 2 }
  const state = new CampaignState(join(cyncoHome(), 'campaigns', spec.id)).load()
  // The operator's verbs come BEFORE the lock. A campaign runs for days and
  // its runner holds runner.lock the whole time; a proposal decision that had
  // to wait for the wave to end would arrive after the wave that needed it.
  // Neither verb dispatches, so neither needs the one-runner rule: a decision
  // is merged into state.json by CampaignState.save (the decision on disk
  // wins over the runner's in-memory `pending`), and --sync drains the ntfy
  // queue only when no runner is live.
  if (flag('--approve-proposal') !== -1 || flag('--reject-proposal') !== -1) {
    const approve = flag('--approve-proposal') !== -1; const name = argv[(approve ? flag('--approve-proposal') : flag('--reject-proposal')) + 1]
    // Phase 4: the whole identity set, not only the spec check above — an
    // uncalibrated campaign or one whose revert ban is off may not approve
    // anything. No wave and no row: this is not a verdict, so the wave-bound
    // halves (this wave's Rule 11 re-check, the row's markerSeen) are not asked.
    // An approved seat promotion is also written to the retained seats store.
    const intact = assertIdentityIntact({ spec, state: state.state, io: defaultIo })
    const r = applyProposalDecision(state.state, name, approve, { identity: intact, seatsHome: cyncoHome() })
    if (!r.ok) { console.error(r.why); return 2 }
    state.save(); console.log(`[campaign] proposal ${name} ${r.status}`); return 0
  }
  if (flag('--sync') !== -1) {
    const held = takeLock(state.dir)
    if (held.ok) process.on('exit', () => releaseLock(state.dir))
    return sync(spec, state, { drain: held.ok, holder: held.pid })
  }
  const lock = takeLock(state.dir)
  if (!lock.ok) { console.error(`[campaign] another runner holds ${lock.path} (pid ${lock.pid}) — one runner per campaign`); return 2 }
  process.on('exit', () => releaseLock(state.dir))
  // --resume is the default and always has been: the state directory IS the
  // resume point. The flag is accepted so an operator can say so out loud.
  // A wave this runner dispatched and never graded is still on the GPU as far
  // as anything here knows. Dispatching another one would put two missions on
  // one card; the operator says when it is over, and --adopt-inflight is how.
  if (state.state.inFlight) {
    if (flag('--adopt-inflight') === -1) { console.error(inFlightRefusal(state)); return 2 }
    const r = await adoptInFlight(spec, state)
    if (r.kind === 'alive') { console.error(`[campaign] --adopt-inflight refused: the driver (pid file ${state.state.inFlight.pidFile}) is still alive and wrote no ledger row`); return 2 }
    if (r.kind === 'fault') { console.error(`[campaign] wave ${r.record.wave} recorded as a fault: ${r.record.decision.why}`); return 1 }
  }
  if (flag('--waves') !== -1) {
    const n = Number(argv[flag('--waves') + 1])
    if (!Number.isInteger(n) || n <= 0) { console.error('[campaign] --waves needs a positive integer'); return 2 }
    spec.budget.waves = n
  }
  const dryRun = flag('--dry-run') !== -1
  // The dirty-tree refusal protects the VERDICT COMMIT from landing on top of
  // someone's work. A dry run commits nothing, so it is not subject to it —
  // and refusing there would make the brief unreadable exactly when it is
  // being reviewed mid-edit.
  if (!dryRun) {
    const dirty = dirtyOutsideCampaign((spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean), spec)
    if (dirty.length) { console.error(`[campaign] working tree is dirty outside the ledger (${dirty.length} path(s)) — commit or stash first; the runner will not commit over your work:\n  ${dirty.join('\n  ')}`); return 2 }
  }

  // CALIBRATE whenever the instruments changed (or never ran).
  const sha = (p) => calibrateIo.sha256(p)
  const cal = state.state.calibration
  if (!cal || cal.gateSha256 !== sha(spec.gate) || cal.perturbSha256 !== sha(spec.perturb) || (spec.positive && cal.positiveSha256 !== sha(spec.positive))) {
    console.log('[campaign] CALIBRATE (Rule 11): gate/perturb/positive changed or never calibrated')
    const r = await calibrate(spec)
    if (!r.ok) { console.error('[campaign] CALIBRATION REFUSED:\n  ' + r.problems.join('\n  ')); await notify(`${spec.id}: calibration refused — ${r.problems[0]}`); return 3 }
    // basePasses is what wave 1's brief prints as "Already PASS at BASE and must
    // stay so" — the only thing telling the worker which lines it may not break.
    const next = { gateSha256: r.gateSha256, perturbSha256: r.perturbSha256, positiveSha256: r.positiveSha256 ?? null, baseFails: r.baseFails, basePasses: r.basePasses ?? [], perturbFails: r.perturbFails, baseGateMs: r.baseGateMs ?? null, calibratedAt: new Date().toISOString() }
    // BEFORE the overwrite: `cal` is the calibration this campaign has been
    // measured against so far, and once the line below runs it is gone. `wave`
    // is the number of waves already spent — the reseal lands between that wave
    // and the next one.
    const reseal = recordReseal(state.state, cal, next, { at: next.calibratedAt, wave: state.state.waveCount ?? 0 })
    state.state.calibration = next
    state.save()
    if (reseal) console.log(`[campaign] RESEAL recorded after wave ${reseal.wave}: gate ${reseal.from.gateSha256} → ${reseal.to.gateSha256}, ${reseal.changedLineIds.length} graded line(s) changed${reseal.changedLineIds.length ? `: ${reseal.changedLineIds.join(', ')}` : ''}`)
    console.log(`[campaign] calibrated: BASE MISS ${r.baseFails.length}, perturb honest${r.suiteBaselineCreated ? ', suite baseline written' : ''}`)
  }
  if (dryRun) {
    console.log(generateBrief(spec, waveContext(spec, state.state)))
    return 0
  }
  // decide() can only say `budget` about a wave it just graded; a campaign
  // resumed after its last wave would otherwise dispatch one more.
  if (budgetSpent(state, spec)) {
    console.log(`[campaign] budget already spent (${state.state.waveCount}/${spec.budget.waves} waves) — nothing to dispatch`)
    return 1
  }
  while (true) {
    const rec = await runWave(spec, state, defaultIo, { roadmapPath })
    console.log(`[campaign] wave ${rec.wave}: ${rec.decision.kind} — ${rec.decision.why}`)
    if (rec.decision.kind !== 'next') { await notify(`${spec.id.toUpperCase()} STOPPED: ${rec.decision.kind} — ${rec.decision.why}`); return rec.decision.kind === 'pass' || rec.decision.kind === 'pass-with-survivors' ? 0 : 1 }
  }
}

async function sync(spec, state, { drain = true, holder = null } = {}) {
  const branch = `campaign/${spec.id}`
  const reach = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'main'], { encoding: 'utf8', timeout: 20_000 })
  if (reach.status !== 0) { console.log('[campaign] no network — nothing synced; pending branch ' + branch); return 0 }
  // A push can be REJECTED (non-fast-forward, protected branch) and still leave
  // --sync looking like it worked; the PR would then describe commits nobody
  // has. Say so and change nothing else.
  const push = spawnSync('git', ['push', '-u', 'origin', branch], { encoding: 'utf8' })
  if (push.stdout?.trim()) console.log(push.stdout.trimEnd())
  if (push.stderr?.trim()) console.log(push.stderr.trimEnd())
  if (push.status !== 0) { console.error(`[campaign] git push of ${branch} was rejected (exit ${push.status}) — nothing else synced; resolve it by hand and re-run --sync`); return 1 }
  const prBase = spec.prBase ?? 'main'
  const existing = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { encoding: 'utf8' })
  if (existing.status !== 0) spawnSync('gh', ['pr', 'create', '--head', branch, '--base', prBase, '--title', `${spec.id.toUpperCase()} campaign verdicts (runner)`, '--body', `Unattended wave verdicts written by scripts/cynco-campaign.mjs. Merge on GitHub.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`], { stdio: 'inherit' })
  else console.log(`[campaign] PR exists: ${existing.stdout.trim()}`)
  if (!drain) { console.log(`[campaign] a runner (pid ${holder}) is live — its queued notifications drain at its next verdict, not here`); return 0 }
  const before = state.state.pendingNotifications.length
  state.state.pendingNotifications = await drainQueued(state.state.pendingNotifications, (n) => notify(`${spec.id}: (queued) ${n.kind} — ${n.why}`))
  const left = state.state.pendingNotifications.length
  if (before) console.log(`[campaign] queued notifications: ${before - left} sent, ${left} still queued`)
  state.save()
  return 0
}

// bun sets import.meta.main; node 24 does too. The argv comparison is the
// fallback for a runtime that sets neither, and fileURLToPath is the only
// correct file:// → Windows path conversion.
const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => { console.error(`[campaign] ${e?.stack ?? e}`); process.exit(1) })
}
