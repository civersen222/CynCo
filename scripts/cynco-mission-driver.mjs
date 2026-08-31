// Canonical CynCo mission driver (see docs/cynco-failure-log.md F5).
//
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd] [probe-cmd]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
//   check-cmd:     shell command run in cwd AFTER the mission ends (Phase 2b);
//                  exit 0 => verified:true, nonzero => verified:false,
//                  timeout/spawn failure => verified:null (UNMEASURED).
//                  Omit => null. Cap the run with CYNCO_CHECK_TIMEOUT_MS
//                  (default 300000); a mutation-testing gate needs more.
//                  Also sent as a DoD contract with the mission dispatch (P4.2)
//                  so taskError/errorTrend measure the run. The command itself
//                  is withheld from the text the model reads.
//   probe-cmd:     Stage 1 (S3*, docs/cynco-self-orchestration-spec.md): cheap
//                  PUBLIC check run at every quiescent turn boundary once a
//                  commit has landed. FAIL => verbatim output injected as a new
//                  user turn and the mission continues (max
//                  CYNCO_MAX_PROBE_OVERRIDES, default 3). PASS/UNMEASURED =>
//                  the exit stands. Requires CYNCO_PROBE_TIMEOUT_MS, fail-closed
//                  like check-cmd. Never a perf-measuring command: it shares
//                  the machine with the run it is probing.
//
// Optional sidecar: <task-file with .contract.json instead of its extension>.
// What the brief AUTHORIZES, which the brief text cannot say in a way any
// mechanism reads. Finding (ai): assessTestsUnmodified vetoes the whole reward
// (-1.0) when a test file loses cases or disappears, and clears only for paths
// a passed assertion names — so a mission ORDERED to delete superseded cases
// scored the maximum penalty for obeying. Shape:
//
//   { "assertions": [ { "testCensus": "gilded/tests/test_ui.py", "min": 40 },
//                     { "fileAbsent": "gilded/tests/test_old.py" },
//                     { "text": "<what the model reads>", "command": "<held out>" } ] }
//
// Malformed or unparseable => the dispatch is refused, exit 2. See
// scripts/cynco-contract.mjs.
//
// Requires the engine running headless with LOCALCODE_APPROVE_ALL=true (F2)
// and LOCALCODE_S5_ENFORCE=false (F7 — S5 capped at recommend so enforcement
// can neither kill the mission nor confound the outcome-ledger labels).
// Mission briefs should follow the F3 pattern: one focused task, single-line
// unique Edit anchor (grep-verified), full replacement block verbatim.
//
// Every mission appends one labeled record to benchmark/cynco-ledger/ (sharded)
// (governance falsification program, step 1). With a check-cmd the driver sets
// `verified` itself; without one, patch it after independent verification.
// Human spot-audit every 5th record either way (STATE doc Phase 2(b)).

import { basename, join, resolve } from 'node:path'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createMissionCollector, buildMissionRecord, missionCommitted, missionOutcome, waitExitReason, gateDisposition, historyRewrite, gradedHeadSuspect, QUIET_MS } from './cynco-ledger.mjs'
import { countGraderProbes } from './cynco-grader-probes.mjs'
import { runCheck } from './cynco-verify.mjs'
import { probeConfigError, shouldProbe, overrideDecision, probeMessage } from './cynco-probe.mjs'
import { purgeBytecodeCaches, purgeStaleAgentState } from './cynco-workspace.mjs'
import { loadMissionAssertions, sidecarPath, sealedDispatchRefusal, s5DispatchRefusal, workspaceError } from './cynco-contract.mjs'
import { engineEndpoints } from './cynco-endpoints.mjs'
import { snapshotHeldOut, restoreHeldOut } from './cynco-held-out.mjs'
import { snapshotUncommittedWork } from './cynco-work-snapshot.mjs'
import { activeShardPath, ledgerCount, ensureLedgerDir } from './cynco-ledger-shards.mjs'
import { cyncoHome } from '../engine/paths.js'
import { withheldGatePaths } from '../engine/bridge/contractAutoCreate.js'
import { loadOrCreateTokens } from '../engine/security/localToken.js'

const [taskFile, marker, cwdArg, timeoutArg, checkCmd, probeCmd] = process.argv.slice(2)
if (!taskFile || !marker) {
  console.error('usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd] [probe-cmd]')
  process.exit(2)
}
const CWD = cwdArg ?? 'C:\\Users\\civer\\civkings'
// Checked before anything is DERIVED from it. A workspace root that matches
// nothing makes every gate path look like it lives outside the workspace, so
// the repository itself joins the sealed set and the mission is refused its own
// code by a refusal that by design cannot say why. See `workspaceError`.
const cwdError = workspaceError(CWD)
if (cwdError) {
  console.error(`[driver] ${cwdError} — nothing was dispatched`)
  console.error('[driver] spell the path with forward slashes: C:/Users/civer/civkings')
  process.exit(2)
}
const TIMEOUT_S = parseInt(timeoutArg ?? '600', 10)
// One engine per wave: the bridge takes one client at a time, on purpose. So
// two waves in parallel means a second daemon on its own port with its own
// CYNCO_HOME, and this is where the driver is told which of them it belongs to.
// Resolved before anything is dispatched, because a port that is not a port
// spells `ws://localhost:NaN` and fails as something indistinguishable from a
// dead engine.
let ENDPOINTS
try {
  ENDPOINTS = engineEndpoints(process.env)
} catch (e) {
  console.error(`[driver] ${e.message} — nothing was dispatched`)
  process.exit(2)
}
const WS_URL = ENDPOINTS.ws
const GOV_URL = ENDPOINTS.governance
const RUN_URL = ENDPOINTS.run
// Sharded — see cynco-ledger-shards.mjs. `missions.jsonl` is frozen at 193
// records; new ones land in missions.NNNN.jsonl so no push ever hits GitHub's
// 100 MB file ceiling mid-wave.

const task = await Bun.file(taskFile).text()
console.log(`[driver] mission from ${taskFile} (${task.length} chars), marker="${marker}", cwd=${CWD}`)
// Said out loud, because two waves running at once is the case where driving
// the WRONG engine still connects, still runs, and lands its commits in a
// worktree somebody else is measuring. The home is here too: it is where the
// token came from, so a mismatch shows up as a 401 rather than a mystery.
console.log(`[driver] engine ${WS_URL} (port from ${ENDPOINTS.source}), `
  + `home=${process.env.CYNCO_HOME ?? '~/.cynco'}`)

// Built before the socket opens: a sidecar that cannot authorize what it claims
// to authorize must stop the dispatch, not be discovered halfway through a
// two-hour mission whose reward is already forfeit (finding (ai)).
// A gate that mutates source and re-runs a suite per mutation takes minutes,
// not seconds; the fixed 5-minute cap silently converted such gates into
// timeouts. Configurable, because the right cap is a property of the check.
const CHECK_TIMEOUT_MS = parseInt(process.env.CYNCO_CHECK_TIMEOUT_MS ?? '300000', 10)

// Only a cap the OPERATOR set is sent onward. `300000` here is this script's
// own default, not anybody's decision, and dispatching it would OVERRIDE a cap
// the engine's own environment had set — a number nobody chose beating a number
// somebody did. Absent means absent, and the engine then decides for itself.
const DISPATCHED_CHECK_TIMEOUT_MS =
  process.env.CYNCO_CHECK_TIMEOUT_MS === undefined ? undefined : CHECK_TIMEOUT_MS

// A check command with no operator-chosen cap silently inherits 300000ms, and
// 300s is shorter than any gate that mutates source and re-runs a suite. The
// cost of getting this wrong is not a failed check -- it is UNMEASURED, two
// hours after the only moment it could have been fixed. So refuse now, when it
// costs one line, rather than at the far end when it costs the whole mission.
// Setting it to 300000 explicitly is a choice and is accepted.
if (checkCmd && process.env.CYNCO_CHECK_TIMEOUT_MS === undefined) {
  console.error('[driver] a check command was given but CYNCO_CHECK_TIMEOUT_MS is unset —')
  console.error(`[driver] the check would inherit this script's ${CHECK_TIMEOUT_MS}ms default, which nobody chose,`)
  console.error('[driver] and a mutation gate killed at that cap reports UNMEASURED, not FAIL.')
  console.error('[driver] set it explicitly, e.g. CYNCO_CHECK_TIMEOUT_MS=1800000 — nothing was dispatched')
  process.exit(2)
}

// Stage 1 (S3*): same fail-closed shape for the probe's cap — a probe killed at
// a default nobody chose reports UNMEASURED at the exact moment it was needed.
const probeError = probeConfigError(probeCmd, process.env.CYNCO_PROBE_TIMEOUT_MS)
if (probeError) {
  console.error(`[driver] ${probeError} — nothing was dispatched`)
  process.exit(2)
}
const PROBE_TIMEOUT_MS = probeCmd ? parseInt(process.env.CYNCO_PROBE_TIMEOUT_MS, 10) : 0
const MAX_PROBE_OVERRIDES = parseInt(process.env.CYNCO_MAX_PROBE_OVERRIDES ?? '3', 10)
const probeState = probeCmd
  ? { command: probeCmd, runs: 0, fails: 0, overrides: 0, lastExit: null, lastVerified: null, exhausted: false, blockedBySocket: 0 }
  : null

let missionAssertions
try {
  missionAssertions = loadMissionAssertions(taskFile, checkCmd, {
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf-8'),
  }, DISPATCHED_CHECK_TIMEOUT_MS)
} catch (e) {
  console.error(`[driver] ${e.message}`)
  process.exit(2)
}
if (missionAssertions && missionAssertions.length > (checkCmd ? 1 : 0)) {
  console.log(`[driver] ${sidecarPath(taskFile)} authorizes ${missionAssertions.length - (checkCmd ? 1 : 0)} assertion(s)`)
}

// F41. Derived HERE, from the same function the engine derives it from, so the
// driver knows whether this mission depends on a guarantee before it decides
// whether the engine on the other end of the socket has one. The count is all
// that leaves this scope: the paths themselves are the withheld thing.
const SEALED_COUNT = missionAssertions
  ? withheldGatePaths(missionAssertions, CWD).length
  : 0
if (SEALED_COUNT > 0) console.log(`[driver] this mission seals ${SEALED_COUNT} held-out instrument(s)`)

for (const line of purgeBytecodeCaches(CWD)) console.log(`[driver] ${line}`)
for (const line of purgeStaleAgentState(CWD)) console.log(`[driver] ${line}`)

const collector = createMissionCollector()
const dispatchedAt = new Date().toISOString()
// F38's window. Seconds, because that is what the reflog speaks. Taken here
// rather than at the ledger write so a commit made in the first poll interval is
// still inside the mission.
const sinceEpochS = Math.floor(Date.parse(dispatchedAt) / 1000)
const missionId = `${basename(taskFile).replace(/\.[^.]*$/, '')}-${Date.now()}`
let enforcedWarned = false

// F45. The seal is a READ barrier: it hides the gate's name and refuses a Read.
// Nothing was a write barrier, and a shell command that spawns a child process
// is one syscall from any path on the disk. I4d2b3f found the unsealed script
// that GENERATES the gate, ran it, and was then scored by a gate it had rebuilt
// itself from a stale base. So take the bytes now and put them back before the
// check — the paths stay inside this scope, exactly as at SEALED_COUNT above.
const heldOutSnapshots = missionAssertions
  ? snapshotHeldOut(withheldGatePaths(missionAssertions, CWD),
                    join(cyncoHome(), 'held-out', missionId))
  : []
if (heldOutSnapshots.length) {
  const absent = heldOutSnapshots.filter(s => s.missing).length
  console.log(`[driver] snapshotted ${heldOutSnapshots.length - absent} held-out instrument(s)`
    + (absent ? `; ${absent} named by the check do not exist` : ''))
}

// The bridge refuses an unauthenticated upgrade. Reading the same token file the
// engine minted keeps this driver a zero-configuration tool; Bun's WebSocket
// sends no Origin, so it is not mistaken for a browser.
const localTokens = loadOrCreateTokens()
const bridgeToken = localTokens.tokenFor('bridge')
// The governance poll below reads the dashboard, which takes the inference scope.
const inferenceToken = localTokens.tokenFor('inference')
const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${bridgeToken}` } })
let toolCount = 0
let zeroToolCompletion = false
// F57: every `tool.start` frame, kept so the run can be asked afterwards how
// often it reached for the thing that grades it. Wave 10 walked a stale .pyc
// with `marshal.loads` for eighteen minutes and the row said nothing, because
// nothing was counting.
//
// Frames are kept by reference — these objects already exist, parsed from the
// socket, and holding them only defers their collection. Pre-filtering here
// instead would move the measurement into this untested file and out of
// countGraderProbes, which is the only thing under test that can do it.
const toolStartFrames = []
// The marker appearing in git log means a commit LANDED, not that the run is
// FINISHED. Measured on Gilded UI Wave 3d: the run committed 8ab7faf, the poll
// below caught the marker and fired the verification check, which failed DoD 7
// on four test names in the commit body that did not resolve — and while that
// 57-second check was running the run amended the commit to 78429e0 with the
// names corrected, which passes the same gate 59/59. So the ledger recorded
// verified:false for a wave that passes, because the instrument read a commit
// the run was still in the middle of fixing. Landing is now recorded but the
// loop keeps waiting for the conversation to go quiet: a completed message with
// no tool call after it for QUIET_MS. Any tool.start reopens the run.
let sawMessageComplete = false
let lastActivityAt = Date.now()
// F19: the engine said it was dead and nobody was listening. Wave 7h run 2 lost
// llama-server at turn 59; the engine caught the connection failure and emitted
// session.error, but the crash happened mid-message so `message.complete` never
// arrived and the quiescence test below kept answering "still working" for the
// next 3351 seconds. Null until the engine says otherwise; the string it says is
// kept, because "a crash happened" and "which crash" are different facts.
let engineError = null
// F32: dispatched, accepted by nobody. The bridge refused the frame — correctly,
// on a real schema skew — and said so only in its own stdout. From here that is
// indistinguishable from an engine still thinking, so this script waited, and
// would have waited out all 10800s it was given. `[gov] status=warning stuck=0`
// ticked the whole time and proved only that the dashboard was reachable.
//
// The absence of work has to have its own name. These four events are emitted
// only while a turn is actually running, so the first of them is the moment the
// mission demonstrably exists. session.ready is excluded on purpose: the bridge
// replays the last one to every client on connect, so it arrives whether or not
// anything was accepted.
const WORK_BEGUN = new Set(['stream.token', 'stream.thinking', 'tool.start', 'message.complete'])
let workBegun = false
// Generous: a cold llama-server prefilling a 20k-token mission has taken over a
// minute. The cost of being wrong here is a spurious re-dispatch; the cost of
// the old behaviour was three hours.
const SILENCE_S = parseInt(process.env.CYNCO_SILENCE_S ?? '300', 10)
let silentAfterDispatch = false
// F41, widened by F59. Every mission now waits for the engine to say what it is
// before anything is sent to it. Wave 9b proved that a driver holding a two-path
// seal and an engine that had never heard of sealing look, from here, exactly
// like a working pair; F59 is the same shape without a seal — S5 enforcement
// confounds the labels of a mission that withholds nothing just as thoroughly,
// so a guard that only ran on the sealed path was not a guard on the dispatch.
// session.ready is replayed to every client on connect, so this costs a mission
// with a live engine milliseconds.
let dispatched = false
const readyGateTimer = setTimeout(() => {
  if (dispatched) return
  // No session.ready in this long means the engine's competence is UNKNOWN, and
  // unknown is not permission — the same rule the ledger applies to a
  // verification that never ran. Both guards are asked with `capabilities: null`
  // so the refusal names the guarantee that could not be established, rather
  // than reporting a timeout and leaving the operator to guess which.
  const refusal = s5DispatchRefusal({ capabilities: null })
    ?? (SEALED_COUNT > 0 ? sealedDispatchRefusal({ sealedCount: SEALED_COUNT, capabilities: null }) : null)
  console.error(`[driver] REFUSED: no session.ready in ${process.env.CYNCO_READY_S ?? '30'}s — ${refusal}`)
  process.exit(4)
}, parseInt(process.env.CYNCO_READY_S ?? '30', 10) * 1000)

// Finding (ag): the brief is the instrument this mission is judged against, and
// this driver is the only component that knows where it lives. Measured on
// Gilded L4.6b, a run rewrote the brief it had been Read three times with a
// plausible reconstruction of its own. Finding (ac) built the refusal but fed
// it from LOCALCODE_IMMUTABLE_PATHS, read inside the engine process — which
// this driver, a WebSocket client, cannot set. So it travels with the message —
// dispatch and probe injection alike (Stage 1 sends user.messages too).
const readOnlyPaths = [resolve(taskFile).replace(/\\/g, '/')]

function dispatchMission() {
  if (dispatched) return
  dispatched = true
  clearTimeout(readyGateTimer)
  // P4.2 (STATE doc Phase 4(a)): the check script IS the contract — the engine
  // creates a one-assertion DoD so taskError/errorTrend measure this mission.
  //
  // The gate's command is withheld from the assertion TEXT and travels beside
  // it, and the brief's authorizations come from the sidecar. Both are built in
  // scripts/cynco-contract.mjs, which is under test; the reasoning for each
  // lives there. A malformed sidecar has already thrown by this point, above.
  const contract = missionAssertions
    ? {
        title: `Mission: ${marker}`,
        brief: task.slice(0, 200),
        assertions: missionAssertions,
      }
    : undefined
  ws.send(JSON.stringify({
    type: 'user.message', text: task, cwd: CWD, readOnlyPaths,
    // This driver is a script, not a person. An AskUser raised here is broadcast
    // to an empty room and "answered" only by the AskBroker's 300s timeout —
    // measured on Gilded UI Wave 6, five minutes spent learning nothing.
    unattended: true,
    ...(contract ? { contract } : {}),
  }))
}

ws.onopen = () => {
  console.log('[driver] connected, waiting for the engine to declare what it is')
}
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data)
    collector.ingest(m)
    if (m.type === 'session.ready' && !dispatched) {
      // F59 first: it applies to every mission, and an engine that cannot say
      // this word is misconfigured in a way that costs the run whether or not
      // anything is sealed.
      const refusal = s5DispatchRefusal({ capabilities: m.capabilities })
        ?? (SEALED_COUNT > 0 ? sealedDispatchRefusal({ sealedCount: SEALED_COUNT, capabilities: m.capabilities }) : null)
      if (refusal) {
        console.error(`[driver] REFUSED: ${refusal}`)
        process.exit(4)
      }
      console.log(`[driver] engine declares [${(m.capabilities ?? []).join(', ')}] — dispatching mission`)
      dispatchMission()
    }
    if (WORK_BEGUN.has(m.type)) workBegun = true
    if (m.type === 's5.decision' && m.enforced === true && !enforcedWarned) {
      // Kept as a second, independent detector. F59 moved the decision to
      // dispatch time, where it reads the engine's own declaration; this reads
      // the thing itself. If they ever disagree, the declaration is wrong, and
      // that is worth a line in the log even though it is now too late to act.
      console.log('[driver] WARNING: S5 ENFORCEMENT ACTIVE despite the capability check — restart engine with LOCALCODE_S5_ENFORCE=false (F7 risk, ledger labels confounded)')
      enforcedWarned = true
    }
    if (m.type === 'tool.start') {
      toolCount++
      toolStartFrames.push(m)
      console.log(`[cynco] tool: ${m.toolName}`)
      // Any tool call means the run is still working, whatever it has committed.
      sawMessageComplete = false
      lastActivityAt = Date.now()
    }
    if (m.type === 'message.complete') { sawMessageComplete = true; lastActivityAt = Date.now() }
    if (m.type === 'session.error' && !engineError) {
      // Terminal for this mission: conversationLoop only emits this after the
      // model loop has thrown and unwound. Recorded, not thrown away, so the
      // ledger can tell a repeated llama-server exit from a one-off.
      engineError = String(m.error ?? 'session.error with no message')
      console.log(`[driver] ENGINE ERROR — the run is over, not stalled: ${engineError}`)
    }
    if (m.type === 'tool.complete' && m.isError) console.log(`[cynco] TOOL ERROR (${m.toolName}): ${String(m.result).slice(0, 200)}`)
    if (m.type === 'approval.request') console.log(`[cynco] APPROVAL REQUESTED (${m.toolName ?? '?'}) — engine not in APPROVE_ALL mode? (F2)`)
    if (m.type === 'message.complete' && toolCount === 0) {
      // F7: conversation ended without a single tool call — mission cannot have
      // landed. Likely S5 crisis-mode tool restriction on a stale engine session.
      console.log('[driver] FAIL-FAST: message.complete with ZERO tool calls (F7 — check engine log for S5 ENFORCE; restart engine fresh)')
      zeroToolCompletion = true
    }
  } catch {}
}
ws.onerror = (e) => console.log('[driver] ws error', e?.message ?? e)
let opened = false
ws.addEventListener('open', () => { opened = true })
let wsClosed = false
ws.onclose = () => {
  wsClosed = true
  console.log('[driver] ws closed')
  // Closed without ever opening means the bridge refused the upgrade — 401 no
  // token, 409 a TUI already holds it. The mission was never dispatched, so
  // sitting out the full timeout would only produce a misleading TIMEOUT record.
  if (!opened) {
    console.log('[driver] bridge refused the connection — no mission dispatched. ' +
      'Check the engine is running and that no TUI already holds the bridge.')
    process.exit(3)
  }
}

// The marker must appear in a commit THIS mission made, not in one that was
// already there. Polling `git log -3` for the marker string meant a follow-up
// mission whose marker matched the previous mission's own subject line reported
// COMMIT LANDED on its first poll and closed after one turn — which is how UI
// Wave 1c died 30 seconds in, having matched Wave 1b's commit.
const baselineSha = gitHead(CWD)
if (!baselineSha) {
  console.log('[driver] WARNING: could not read HEAD — commit detection will match ANY of the last 3 commits, including pre-existing ones')
}

async function gitLog() {
  const range = baselineSha ? [`${baselineSha}..HEAD`] : ['-3']
  const p = Bun.spawn(['git', 'log', '--oneline', ...range], { cwd: CWD, stdout: 'pipe' })
  return await new Response(p.stdout).text()
}

/**
 * Does the engine still have the turn open? `true`, `false`, or `null` for
 * "nobody answered" — never a guess. F57: this is the only question that
 * distinguishes a run that has stopped from one that is thinking, and this
 * script spent three waves answering it by watching a socket go quiet.
 *
 * An engine predating /api/run returns 404, and an engine that has the route
 * but no `getRunState` dep returns the JSON literal `null`. Both are "unknown",
 * and both must stay distinct from `{processing:false}`.
 */
async function engineRunState() {
  try {
    const r = await fetch(RUN_URL, { headers: { Authorization: `Bearer ${inferenceToken}` } })
    if (!r.ok) return null
    const j = await r.json()
    return typeof j?.processing === 'boolean' ? j.processing : null
  } catch { return null }
}

console.log(`[driver] baseline HEAD ${baselineSha ?? '(unknown)'} — any commit after it counts as landed; "${marker}" is recorded, not required`)

// HEAD is polled rather than parsed out of Bash commands: the wave commits with
// whatever git incantation it likes, and a commit that lands is a fact about the
// repo, not about the command that produced it. `landed` above answers "did it
// commit at all" and stops caring after the first; this counts EVERY commit and
// the calls between them, which is the number the commit-pressure threshold is
// derived from. Eight consecutive runs ended uncommitted and nothing on the row
// could say how close any of them came.
//
// The baseline is seeded first, or the very first poll would file the commit the
// mission was dispatched ON as a commit the mission made.
collector.seedBaselineHead(baselineSha)
const headPoll = setInterval(() => { collector.observeCommit(gitHead(CWD)) }, 30_000)
// The poll must never be the reason the process stays alive: the record write at
// the end is what this script exists for, and a live timer holding the loop open
// past it would be a hang caused by telemetry.
headPoll.unref?.()

const start = Date.now()
let landed = false
let markerSeen = false
let quiet = false
let exitReason = null
let runStateSeen = false
while (!quiet && !zeroToolCompletion && !silentAfterDispatch && (Date.now() - start) / 1000 < TIMEOUT_S) {
  await Bun.sleep(30000)
  if (!workBegun && (Date.now() - start) / 1000 >= SILENCE_S) {
    // Not a stall — a non-event. Nothing was ever accepted, so there is no run
    // to wait for and no budget that would have helped (F32).
    console.log(`[driver] FAIL-FAST: ${SILENCE_S}s since dispatch and the engine has emitted no turn activity at all. ` +
      'The mission was never accepted. Read the engine log for "[bridge] REFUSED command frame" — ' +
      'a schema skew between this script and a long-running engine process looks exactly like this. ' +
      'Restart the engine on current source before re-dispatching.')
    silentAfterDispatch = true
    break
  }
  try {
    const g = await fetch(GOV_URL, { headers: { Authorization: `Bearer ${inferenceToken}` } }).then(r => r.json())
    console.log(`[gov] status=${g.status} stuck=${g.stuckTurns} toolOK=${g.toolSuccessRate}`)
  } catch { console.log('[gov] unreachable') }
  // Never let a git hiccup kill the loop — the ledger write at the end must run
  try {
    const log = await gitLog()
    if (log.includes(marker)) markerSeen = true
    // The marker is evidence about the commit MESSAGE, never about whether work
    // landed. See missionCommitted() in cynco-ledger.mjs for why this decision
    // has a name and a test instead of living here as an expression.
    const committed = missionCommitted(log, marker, baselineSha)
    if (committed && !landed) {
      console.log(`[driver] COMMIT LANDED${markerSeen ? '' : ` (no "${marker}" in the subject — brief dictated another format)`}:\n` + log)
      landed = true
    }
  } catch (e) { console.log(`[driver] git poll failed: ${e?.message ?? e}`) }
  // F57: ask the engine whether the turn is open before deciding it is closed.
  const engineProcessing = await engineRunState()
  if (engineProcessing !== null) runStateSeen = true
  else console.log('[driver] /api/run UNANSWERED — falling back to the silence heuristic; the exit will be recorded as inferred, not observed')
  // Quiescence ends the wait whether or not anything landed. A run that lands
  // and then keeps working — amending the commit, fixing a name — must finish
  // before the check runs, or the check measures a state that no longer
  // exists. A run that stops without committing is simply over, and waiting
  // out its budget only buys a wrong label; see waitIsOver().
  exitReason = waitExitReason({ landed, sawMessageComplete, msSinceActivity: Date.now() - lastActivityAt, engineError, engineProcessing, workBegun, engineGone: wsClosed && runStateSeen && engineProcessing === null })
  if (exitReason) {
    // Stage 1 (S3*): the probe runs where the exit decision resolves — the same
    // place GVS5H runs its verifier, between worker turns. The engine ignores
    // user.message while a turn is open (conversationLoop.ts:872), so this
    // boundary is the only moment an injection can land. On FAIL with budget
    // and a live socket, the injection IS the hard override: the wait continues.
    if (probeState && shouldProbe({ probeCmd, landed, exitReason })) {
      const probedSha = gitHead(CWD)
      console.log(`[probe] running in ${CWD}: ${probeCmd} (cap ${PROBE_TIMEOUT_MS}ms, run ${probeState.runs + 1})`)
      const pr = runCheck(probeCmd, CWD, PROBE_TIMEOUT_MS)
      probeState.runs++
      probeState.lastExit = pr.exitCode
      probeState.lastVerified = pr.verified
      if (pr.verified === false) probeState.fails++
      const d = overrideDecision({ verified: pr.verified, overridesUsed: probeState.overrides, maxOverrides: MAX_PROBE_OVERRIDES, socketOpen: !wsClosed })
      console.log(`[probe] ${pr.verified === null ? 'UNMEASURED' : pr.verified ? 'PASS' : 'FAIL'} (exit=${pr.exitCode ?? 'none'}${pr.timedOut ? ', TIMED OUT' : ''}, ${pr.durationMs}ms) — ${d.why}`)
      if (pr.verified === false && wsClosed) probeState.blockedBySocket++
      if (d.inject) {
        probeState.overrides++
        console.log('[probe] injecting the verbatim FAIL and continuing the wait — the mission is not done')
        try {
          ws.send(JSON.stringify({ type: 'user.message', text: probeMessage({ sha: probedSha, ...pr }), cwd: CWD, readOnlyPaths, unattended: true }))
          sawMessageComplete = false
          lastActivityAt = Date.now()
          exitReason = null
          continue
        } catch (e) {
          console.log(`[probe] injection FAILED (${e?.message ?? e}) — the exit stands after all`)
        }
      } else if (pr.verified === false) {
        probeState.exhausted = probeState.overrides >= MAX_PROBE_OVERRIDES
      }
    }
    if (exitReason === 'engine_error') console.log('[driver] leaving the wait loop on the engine error above — the git poll ran first, so a commit made before the crash is already recorded')
    else if (exitReason === 'engine_gone') console.log('[driver] the engine is GONE — the socket closed and /api/run, which answered earlier in this run, no longer answers. Not silence, absence.')
    else if (exitReason === 'engine_closed_the_turn') console.log(`[driver] the engine reports the turn is closed — ${landed ? 'proceeding to verification' : 'nothing committed; the run is over'}`)
    else console.log(`[driver] run quiet for ${Math.round((Date.now() - lastActivityAt) / 1000)}s after a completed message — ${landed ? 'proceeding to verification' : 'nothing committed; the run has stopped, not stalled'}`)
    quiet = true
  }
}
// F57's second half: leaving the loop is this script's decision, and it does not
// stop the engine. Wave 10 kept executing model calls for forty minutes after
// its driver returned, in the repo the gate was about to read and the ledger was
// about to describe. Whatever the reason for leaving, the turn must be closed
// before the gate runs — and if the engine will not close it, the record has to
// say so instead of implying a quiet workspace.
let runStillOpen = false
if (!silentAfterDispatch) {
  if (await engineRunState() === true) {
    console.log('[driver] engine still has the turn OPEN — sending abort')
    try { ws.send(JSON.stringify({ type: 'abort' })) } catch (e) { console.log(`[driver] abort send failed: ${e?.message ?? e}`) }
    const abortDeadline = Date.now() + parseInt(process.env.CYNCO_ABORT_S ?? '60', 10) * 1000
    while (Date.now() < abortDeadline) {
      await Bun.sleep(5000)
      if (await engineRunState() === false) break
    }
    runStillOpen = await engineRunState() === true
    if (runStillOpen) console.log('[driver] REFUSED TO STOP — the engine still has the turn open after abort. ' +
      'Everything below measures a repo that is still being written to; the ledger records runStillOpen:true and the gate cannot speak for this delivery.')
    else console.log('[driver] engine closed the turn on abort')
  }
}
// The socket stays open on purpose for the rest of this script. The gate below
// can run for the better part of an hour, and anything the engine does during
// it is exactly what F57 was: work nothing was watching. Held open, those events
// still reach the collector, and the delta below turns them into a number on the
// record rather than a thing that happened to a repo nobody was looking at.
const toolCountAtExit = toolCount
if (engineError) console.log(`[driver] ENGINE ERROR outcome — the harness died, not the model: ${engineError}\n  Check the engine log for the llama-server exit code before re-dispatching; the mission budget was not the problem.`)
else if (silentAfterDispatch) console.log('[driver] NEVER DISPATCHED — no turn ran. This says nothing about the model or the brief; ' +
  'it says this script and the engine did not agree on the wire. Log a failure entry (docs/cynco-failure-log.md).')
else if (!landed && quiet) console.log('[driver] STOPPED WITHOUT COMMIT — the run went quiet with an uncommitted tree; log a failure entry (docs/cynco-failure-log.md)')
else if (!landed) console.log('[driver] TIMEOUT without commit — log a failure entry (docs/cynco-failure-log.md)')
else if (!quiet) console.log('[driver] WARNING: commit landed but the run never went quiet — the check below may read a commit the run is still amending (see QUIET_MS). The gate is ADVISORY in that case; verified stays null.')

/**
 * The SHA at HEAD of the repo at `cwd`, or null when git cannot say. Never a guess.
 *
 * `cwd` is required and checked. Omitting it does not fail — it silently reads
 * whichever repo the driver process happens to be running in, which is this one,
 * not the mission's workspace. That is a wrong answer wearing the shape of a
 * right one: `baselineSha` becomes localcode's HEAD, no commit in the target
 * repo can ever be in `baselineSha..HEAD`, and the mission is filed as having
 * landed nothing. A throw here is the difference between a broken run and a
 * lying record.
 */
function gitHead(cwd) {
  if (!cwd) throw new Error('gitHead: cwd is required — an unqualified HEAD reads the driver\'s own repo, not the mission workspace')
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' })
  if (r.error || r.status !== 0) return null
  const sha = (r.stdout ?? '').trim()
  return sha || null
}

try {
  const p = Bun.spawn(['git', 'status', '--short'], { cwd: CWD, stdout: 'pipe' })
  console.log('[git status]\n' + await new Response(p.stdout).text())
} catch (e) { console.log(`[driver] git status failed: ${e?.message ?? e}`) }

// Phase 2(b): brief-supplied check command labels the record automatically.
// Runs for EVERY outcome — a timeout mission that somehow landed working code
// earns verified:true, and a "landed" commit that breaks the check earns
// verified:false. Both are exactly the labels the falsification program needs.
// A check that itself times out earns verified:null, because it measured
// nothing about the delivery.
// Not "skipped for speed". A gate run against a tree this mission never
// delivered to reports a true fact about the PREVIOUS state of the repo, filed
// under this mission's id as its verdict — including a verified:true for a
// delivery that does not exist. `null` is what "nobody measured this delivery"
// is spelled as here; see gateDisposition() for why this decision has a name.
let verified
let verify = null
// `engine_gone` is the same fact as `engineError` as far as the gate is
// concerned — the harness stopped the run — so it takes the same advisory path.
// The ledger's own `engineError` field stays null, because no error was reported;
// the engine simply stopped answering, and `exitReason` is where that is said.
const gate = gateDisposition({ neverDispatched: silentAfterDispatch, engineError: engineError ?? (exitReason === 'engine_gone' || null), landed, quiet, runStillOpen })
if (checkCmd && !gate.run) {
  console.log(`[verify] SKIPPED — ${gate.why}`)
} else if (checkCmd) {
  if (!gate.label) console.log(`[verify] ADVISORY — ${gate.why}`)
  // F45, and BEFORE the command line is logged: the gate that runs must be the
  // gate that was dispatched. Restoring is not the interesting part — SAYING SO
  // is. A substituted instrument scores the mission against a check nobody
  // chose, and on I4d2b3f that was invisible in every artifact the run left.
  const tampered = restoreHeldOut(heldOutSnapshots)
  if (tampered.length) {
    console.log(`[verify] HELD-OUT INSTRUMENT CHANGED UNDER THE MISSION: `
      + `${tampered.length} restored from the dispatch snapshot. The check below `
      + `is the dispatched one. Something in this run wrote to a file it was `
      + `never shown — look for an unsealed script that generates it.`)
  }
  console.log(`[verify] running check in ${CWD}: ${checkCmd} (cap ${CHECK_TIMEOUT_MS}ms)`)
  // F56: which commit did the gate actually read? `runCheck` is synchronous and
  // can run for the better part of an hour, and the mission is not necessarily
  // finished when it starts — Gilded Wave 10 committed `ea9ac06` while its gate
  // was mid-flight, and the ledger filed the gate's verdict on `43e7a94` as if
  // it were about the delivery. Nothing in the record could tell them apart.
  // Taking HEAD on both sides costs two git calls and turns a silent wrong
  // answer into a visible mismatch.
  // F132: the gate must grade the COMMIT, not the working tree. C5 wave 1
  // committed chassis.py importing GENTRY_SURNAMES while the definition sat
  // uncommitted in world.py — verify and the sealed gate both read the tree,
  // so a head that dies on ImportError from a clean checkout was graded as if
  // it stood alone. Preserve tracked changes to the patch FIRST (same snapshot
  // the tail takes on every exit path), then reset, so the check reads what a
  // clean checkout of gradedSha would. Skipped while the run is still open:
  // reverting files under a live mission destroys its in-flight work, and that
  // verify is already advisory. If the snapshot cannot be written the tree is
  // left alone — grading the tree is a gap; losing the work is worse.
  let dirtyAtVerify = 0
  if (!runStillOpen) {
    try {
      const st = spawnSync('git', ['status', '--porcelain', '-uno'], { cwd: CWD, encoding: 'utf8' })
      const lines = (st.status === 0 ? st.stdout.trim() : '') ? st.stdout.trim().split('\n') : []
      dirtyAtVerify = lines.length
      if (dirtyAtVerify > 0) {
        const snap = snapshotUncommittedWork(CWD, 'C:/tmp', missionId)
        if (snap.written) {
          console.log(`[verify] tree dirty at gate time: ${dirtyAtVerify} tracked file(s) — preserved → ${snap.patchPath}; resetting so the gate grades the commit, not the tree (F132)`)
          spawnSync('git', ['checkout', '--', '.'], { cwd: CWD })
        } else {
          console.log(`[verify] tree dirty (${dirtyAtVerify} tracked) but the snapshot was not written — NOT resetting; this gate grades the tree (F132 gap stands for this run)`)
        }
      }
    } catch (e) {
      console.log(`[verify] F132 quarantine failed (${e?.message ?? e}) — this gate grades the tree`)
    }
  }
  const headBefore = gitHead(CWD)
  const r = runCheck(checkCmd, CWD, CHECK_TIMEOUT_MS)
  const headAfter = gitHead(CWD)
  verified = gate.label ? r.verified : undefined
  // `heldOutRestored` is a count, never the paths: the paths are the withheld
  // thing, and the ledger is read by everything. Zero is the ordinary case and
  // is recorded rather than omitted — an absent field cannot tell "nothing was
  // touched" apart from "this driver could not tell".
  verify = { command: checkCmd, exitCode: r.exitCode, timedOut: r.timedOut, spawnFailed: r.spawnFailed, durationMs: r.durationMs, outputTail: r.outputTail, gradedSha: headBefore, headAfterCheck: headAfter, heldOutRestored: tampered.length, dirtyAtVerify }
  if (headBefore && headAfter && headBefore !== headAfter) {
    // Demote here as well as in gateDisposition. That call reads `quiet`, which
    // is a guess about whether the run had stopped; this is the thing itself.
    console.log(`[verify] HEAD MOVED UNDER THE GATE: graded ${headBefore}, HEAD is now ${headAfter}. ` +
      `verified stays null — the gate measured a commit this mission then committed past.`)
    verified = undefined
  }
  // Three outcomes, not two. A check that never answered has not said the
  // delivery is broken — it has said nothing, and the label must say nothing.
  const verdict = r.verified === null ? 'UNMEASURED' : r.verified ? 'PASS' : 'FAIL'
  console.log(`[verify] ${gate.label ? verdict : `${verdict} (advisory — verified stays null)`} ` +
    `(exit=${r.exitCode ?? 'none'}${r.timedOut ? ', TIMED OUT' : ''}${r.spawnFailed ? ', SPAWN FAILED' : ''}, ${r.durationMs}ms)`)
  if (r.verified !== true) console.log(`[verify] output tail:\n${r.outputTail}`)
  if (gate.label && r.verified === null) {
    console.log(`[verify] verified stays null — the check did not finish. ` +
      `Re-run it by hand, or raise CYNCO_CHECK_TIMEOUT_MS, then patch the record.`)
  }
}

// F38. Ask the reflog what this mission committed and then threw away, because
// every other label on this record — `verified`, `mutationSweep`, `markerSeen` —
// reads the history that survived, and a mission is free to choose which history
// that is. `null` on any failure: unknown is a truthful answer and "clean" is not.
async function readHistoryRewrite() {
  const git = async (args) => {
    const p = Bun.spawn(['git', ...args], { cwd: CWD, stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(p.stdout).text()
    return (await p.exited) === 0 ? text : null
  }
  const raw = await git(['reflog', '--date=unix', '--format=%H%x09%gd%x09%gs'])
  if (raw === null) return null
  // `%gd` under --date=unix renders `HEAD@{1785570306}`; `%gs` is
  // "commit: subject" / "commit (amend): subject" / "reset: moving to X".
  const reflog = []
  for (const line of raw.split('\n')) {
    const [sha, gd, gs] = line.split('\t')
    if (!sha || gs === undefined) continue
    const stamp = /\{(\d+)\}/.exec(gd ?? '')
    if (!stamp) continue // undatable entry: excluded, never assumed in-window
    const cut = gs.indexOf(': ')
    reflog.push({
      sha,
      at: parseInt(stamp[1], 10),
      action: cut < 0 ? gs : gs.slice(0, cut),
      message: cut < 0 ? '' : gs.slice(cut + 2),
    })
  }
  // Reachable is HEAD's WHOLE ancestry, not baselineSha..HEAD: a discarded
  // commit is one no ancestor path reaches, and the narrow range would call
  // every pre-mission commit discarded. The mission window is enforced instead
  // by `sinceEpochS` — a previous mission's discarded commit is unreachable too,
  // and charging it here is the error missionCommitted() was named to stop.
  const rev = await git(['rev-list', 'HEAD'])
  if (rev === null) return null
  const reachable = new Set(rev.split('\n').map(s => s.trim()).filter(Boolean))
  return historyRewrite({ reflog, reachable, sinceEpochS })
}
const history = await readHistoryRewrite().catch(() => null)
if (history === null) {
  console.log('[history] UNMEASURED — the reflog could not be read. This record cannot say whether the run discarded any commit.')
} else if (history.rewritten) {
  console.log(`[history] REWRITTEN: ${history.discarded.length} commit(s) made by this mission are unreachable from HEAD.`)
  console.log('[history] Not a failure by itself — but every gate reads the SURVIVING log, so read these before believing it:')
  for (const d of history.discarded) console.log(`[history]   ${d.sha.slice(0, 7)}  ${d.message}`)
}

// F135. `git -C <dir>` walks up to the enclosing repo when <dir> is not one;
// a mission aiming at a broken worktree detached THIS repo's HEAD at BASE and
// the verdict above graded bare BASE with the delivery one reflog entry away.
// Flag it on the row and at the console; re-grading stays supervisor work.
const suspect = gradedHeadSuspect({ history, gradedSha: verify?.gradedSha ?? null, baselineSha })
if (suspect) {
  history.gradedHeadSuspect = suspect
  console.log(`[history] GRADED HEAD IS THE MISSION BASE while ${history.discarded.length} in-window commit(s) are unreachable from it.`)
  console.log(`[history] The verify above graded ${verify.gradedSha.slice(0, 7)} — likely NOT the delivery. Newest unreachable commit: ${suspect.slice(0, 7)}`)
  console.log(`[history] Re-grade by hand: git -C "${CWD}" branch --all --contains ${suspect.slice(0, 7)}  → run the check at that ref, then patch the row.`)
}

// Stop polling and take one final reading. The interval ran through the gate as
// well as the wait loop — deliberately, because the socket stays open there and
// a mission that refused to stop can still commit while its gate runs — but the
// record must describe a fixed HEAD, so the last observation is taken here
// rather than left to whichever tick happened to fire last.
clearInterval(headPoll)
collector.observeCommit(gitHead(CWD))

// Keep whatever the tree was still holding. Eight consecutive missions ended
// uncommitted and nothing kept any of it — 11N was holding a working
// `tick_loyalty` when the iteration cap closed the loop, and it survived only
// because a human read the diff. This runs on EVERY exit path (the driver's
// tail is linear, so there is only one), before the record is built, and in its
// own try: a snapshot failure must never cost the ledger its record.
try {
  const snap = snapshotUncommittedWork(CWD, 'C:/tmp', missionId)
  if (snap.written) {
    console.log(`[driver] uncommitted work preserved → ${snap.patchPath}`)
  } else if (snap.untracked.length) {
    console.log(`[driver] tree has no tracked changes; ${snap.untracked.length} untracked file(s) left in place`)
  }
  // A snapshot that failed reads exactly like a clean tree at the console. Say
  // which one it was, or the next run is told the work was saved when it wasn't.
  if (snap.error) console.log(`[driver] work snapshot FAILED (uncommitted work NOT preserved): ${snap.error}`)
} catch (e) {
  console.log(`[driver] work snapshot threw (uncommitted work NOT preserved): ${e?.message ?? e}`)
}

// Append the labeled mission record to the outcome ledger
const outcome = missionOutcome({ landed, zeroToolCompletion, wentQuiet: quiet, engineError, neverDispatched: silentAfterDispatch })
// Read HEAD one last time, AFTER the snapshot above and after the check script
// has run, so `baselineSha..finalSha` is exactly the commits this mission made.
// Not taken from the 30s poll: the poll can miss a commit made in its last
// interval, and a range that is short by one commit silently drops those lines
// from every sweep derived from it.
const finalSha = gitHead(CWD)
try {
  const record = buildMissionRecord(collector, {
    missionId,
    briefFile: taskFile,
    marker,
    markerSeen,
    cwd: CWD,
    dispatchedAt,
    durationS: Math.round((Date.now() - start) / 1000),
    outcome,
    engineError,
    verified,
    verify,
    // Stage 1 (S3*): what the in-loop probe saw and did. null when no probe-cmd.
    probe: probeState,
    history,
    // -> `commitRange`. The pair that makes this row sweepable later; see the
    // field's comment in cynco-ledger.mjs for the 150 rows that had no pair.
    baselineSha,
    finalSha,
    // F57. `exitReason` stays null only if the loop never resolved one, which
    // is the timeout path, and `silentAfterDispatch` has its own name for the
    // case where no turn ever ran.
    exitReason: exitReason ?? (silentAfterDispatch ? 'never_dispatched' : 'timeout'),
    // Unknown when nothing ever answered /api/run — an older engine cannot be
    // read as a quiet one.
    runStillOpen: runStateSeen ? runStillOpen : null,
    toolCallsAfterExit: toolCount - toolCountAtExit,
    // F57: null when no frame carried an inspectable input, which an engine too
    // old to emit one cannot be told from a mission that never probed.
    graderProbes: countGraderProbes(toolStartFrames),
  })
  ensureLedgerDir()
  const shard = activeShardPath()
  appendFileSync(shard, JSON.stringify(record) + '\n')
  console.log(`[ledger] ${outcome} record ${missionId} appended (${collector.turns.length} turns, ${collector.s5Decisions.length} S5 decisions) → ${shard}`)
  if (!checkCmd) console.log('[ledger] no check-cmd given — patch "verified": true|false after independent verification')
  // `verified` is one check command's exit code. It cannot say whether the new
  // tests BITE — only a withheld mutation set can, and those run later. Say so
  // on every record, so nobody reads verified:true as accepted.
  console.log(`[ledger] mutationSweep: null (UNMEASURED) — patch it once the withheld set has run: { command, killed, total, survived[] }`)
  // Print the sweep as a command that can be pasted, not as a chore to remember.
  // 150 rows went unlabeled because the sweep was a hand-authored step happening
  // days later against code nobody had the range for; the range is now on the
  // row, so the only remaining cost is knowing what to type.
  if (record.commitRange === null) {
    console.log('[sweep] commitRange: null — HEAD was unreadable at one end, so this row cannot be swept from its own diff')
  } else if (record.commitRange.base === record.commitRange.head) {
    console.log('[sweep] commitRange is empty (base === head) — this mission committed nothing, so there is no diff to mutate')
  } else {
    const { base, head } = record.commitRange
    console.log(`[sweep] derive it:  python scripts/cynco-mutation-sweep.py --repo "${CWD}" --base ${base} --head ${head}`)
    console.log(`[sweep] then record: bun scripts/cynco-ledger-sweep.mjs --mission ${missionId} --kind derived --command "..." --killed K --total T [--survived ...]`)
  }
  // F57 was found by reading a transcript, which is to say by luck. A row that
  // records the count and says nothing at the console is the same amount of
  // luck: the count still has to be read. Printed with a sample, because the
  // number cannot tell tidying from disassembly and the sample can.
  if (record.graderProbes === null) {
    console.log('[probes] UNMEASURED — no tool.start frame carried an inspectable input (older engine?)')
  } else if (record.graderProbes.probes > 0) {
    const p = record.graderProbes
    console.log(`[probes] GRADER TOUCHED ${p.probes}/${p.total} tool calls — ${JSON.stringify(p.byPattern)} (F57; read the samples on the record before labelling)`)
    for (const s of p.samples) console.log(`[probes]   ${s}`)
  } else {
    console.log(`[probes] 0/${record.graderProbes.total} tool calls touched the grading apparatus`)
  }
  // 1-in-5 human spot-audit cadence (STATE doc Phase 2(b)).
  try {
    // Counted across every shard: the 1-in-5 cadence is over the whole ledger,
    // and counting only the live shard would restart the cadence at each roll.
    const count = ledgerCount()
    if (count % 5 === 0) {
      console.log(`[ledger] SPOT-AUDIT DUE: record #${count} — human-verify this mission's label (1-in-5 cadence)`)
      console.log(`[ledger]   verified=${verified ?? 'null'} is STRUCTURAL (${checkCmd ?? 'no check-cmd'}); mutationSweep is BEHAVIOURAL and still null.`)
      console.log(`[ledger]   The audit question is not "did the check pass" but "would these tests have caught the rule breaking".`)
    }
  } catch (e) {
    console.log(`[ledger] spot-audit count failed (reminder skipped): ${e?.message ?? e}`)
  }
} catch (e) {
  console.log(`[ledger] FAILED to write record: ${e?.message ?? e}`)
}

// F131: the C4 wave-3 engine wrote its landed row and then sat alive for 7.3
// hours — children (llama-server, jlens) up, watcher blind, dashboard showing
// a mission that had already been graded. The ledger row above IS the verdict;
// nothing after it needs this engine. Opt-in (dispatch-mission.sh sets
// CYNCO_TEARDOWN_ENGINE=1) because this driver is also pointed at engines it
// does not own, and killing someone's live session over a shared socket is
// worse than the undead engine was. The engine's /quit path runs cleanShutdown,
// which stops llama-server and the sidecars — a bare exit would orphan them.
// NOTE: the 9161 dashboard rides the engine process and goes down with it.
// F131 residual (C5 wave 3): the engine can close the MISSION socket at the
// end of its turn loop and keep running — wsClosed proves the socket died,
// not the process. Probe with a fresh connection: if it accepts, the engine
// is alive and gets its /quit over the new socket; if it refuses, it is gone.
//
// F131 residual 2 (c6-wave3): /quit is a request, not a guarantee. The wave-3
// engine got its /quit over an open socket and sat undead for ~18h anyway —
// the driver exits on ITS timeout, so the engine can still be mid-iteration
// with the command parked behind the busy loop, and the polite 20s wait loses.
// When any teardown path ends in "kill the tree by hand", the driver now IS
// the hand: same match rules as dispatch-mission.sh (engines by command line,
// llama-server by ExecutablePath under ~/.cynco so Ollama's copy is never
// touched).
function killEngineTree(reason) {
  const ps = (q) => (spawnSync('powershell', ['-NoProfile', '-Command', q], { encoding: 'utf-8' }).stdout ?? '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const pids = [
    ...ps("Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -like '*engine/main.ts*' } | Select-Object -ExpandProperty ProcessId"),
    ...ps("Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { $_.ExecutablePath -like '*\\.cynco\\*' } | Select-Object -ExpandProperty ProcessId"),
  ]
  if (pids.length === 0) {
    console.log(`[driver] F131 escalation (${reason}): no engine tree found — already gone`)
    return
  }
  for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { encoding: 'utf-8' })
  console.log(`[driver] F131 escalation (${reason}): tree-killed PID(s) ${pids.join(', ')}`)
}
if (process.env.CYNCO_TEARDOWN_ENGINE === '1' && wsClosed) {
  await new Promise((done) => {
    let probe
    let opened = false
    let settled = false
    const settle = (msg) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      console.log(msg)
      done()
    }
    const t = setTimeout(() => {
      try { probe?.close() } catch {}
      killEngineTree('reconnect probe hung 20s')
      settle('[driver] F131 teardown: reconnect probe hung 20s — escalated to tree-kill')
    }, 20000)
    try {
      probe = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${bridgeToken}` } })
      probe.onopen = () => {
        opened = true
        console.log('[driver] F131 teardown: mission socket was closed but the engine still accepts connections — sending /quit over a fresh socket')
        try { probe.send(JSON.stringify({ type: 'command', command: '/quit', args: '' })) } catch {}
      }
      probe.onclose = () => settle(opened
        ? '[driver] F131 teardown: probe socket closed — engine and children are down (dashboard 9161 included)'
        : '[driver] F131 teardown: reconnect refused — engine really is gone, nothing to quit')
      probe.onerror = () => { if (!opened) settle('[driver] F131 teardown: reconnect refused — engine really is gone, nothing to quit') }
    } catch (e) {
      settle(`[driver] F131 teardown: reconnect probe failed (${e?.message ?? e}) — engine really is gone, nothing to quit`)
    }
  })
} else if (process.env.CYNCO_TEARDOWN_ENGINE === '1') {
  await new Promise((done) => {
    const t = setTimeout(() => {
      console.log('[driver] F131 teardown: engine did not close its socket within 20s of /quit — still undead, escalating')
      killEngineTree('no socket close within 20s of /quit')
      done()
    }, 20000)
    ws.onclose = () => { wsClosed = true; clearTimeout(t); console.log('[driver] F131 teardown: engine socket closed — engine and children are down (dashboard 9161 included)'); done() }
    try {
      console.log('[driver] F131 teardown: sending /quit — engine exits via cleanShutdown, llama-server and sidecars go with it')
      ws.send(JSON.stringify({ type: 'command', command: '/quit', args: '' }))
    } catch (e) {
      clearTimeout(t)
      console.log(`[driver] F131 teardown: /quit send failed (${e?.message ?? e}) — escalating to tree-kill`)
      killEngineTree('/quit send failed')
      done()
    }
  })
}

process.exit(landed ? 0 : 1)
