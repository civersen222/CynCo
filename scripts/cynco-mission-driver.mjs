// Canonical CynCo mission driver (see docs/cynco-failure-log.md F5).
//
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
//   check-cmd:     shell command run in cwd AFTER the mission ends (Phase 2b);
//                  exit 0 => verified:true, else verified:false. Omit => null.
//                  Also sent as a one-assertion DoD contract with the mission
//                  dispatch (P4.2) so taskError/errorTrend measure the run.
//
// Requires the engine running headless with LOCALCODE_APPROVE_ALL=true (F2)
// and LOCALCODE_S5_ENFORCE=false (F7 — S5 capped at recommend so enforcement
// can neither kill the mission nor confound the outcome-ledger labels).
// Mission briefs should follow the F3 pattern: one focused task, single-line
// unique Edit anchor (grep-verified), full replacement block verbatim.
//
// Every mission appends one labeled record to benchmark/cynco-ledger/missions.jsonl
// (governance falsification program, step 1). With a check-cmd the driver sets
// `verified` itself; without one, patch it after independent verification.
// Human spot-audit every 5th record either way (STATE doc Phase 2(b)).

import { basename, join, dirname, resolve } from 'node:path'
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMissionCollector, buildMissionRecord } from './cynco-ledger.mjs'
import { runCheck } from './cynco-verify.mjs'
import { loadOrCreateTokens } from '../engine/security/localToken.js'

const [taskFile, marker, cwdArg, timeoutArg, checkCmd] = process.argv.slice(2)
if (!taskFile || !marker) {
  console.error('usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd]')
  process.exit(2)
}
const CWD = cwdArg ?? 'C:\\Users\\civer\\civkings'
const TIMEOUT_S = parseInt(timeoutArg ?? '600', 10)
const WS_URL = 'ws://localhost:9160'
const GOV_URL = 'http://localhost:9161/api/governance'
const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'cynco-ledger', 'missions.jsonl')

const task = await Bun.file(taskFile).text()
console.log(`[driver] mission from ${taskFile} (${task.length} chars), marker="${marker}", cwd=${CWD}`)

const collector = createMissionCollector()
const dispatchedAt = new Date().toISOString()
const missionId = `${basename(taskFile).replace(/\.[^.]*$/, '')}-${Date.now()}`
let enforcedWarned = false

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
const QUIET_MS = 60000
ws.onopen = () => {
  console.log('[driver] connected, dispatching mission')
  // P4.2 (STATE doc Phase 4(a)): the check script IS the contract — the engine
  // creates a one-assertion DoD so taskError/errorTrend measure this mission.
  //
  // The command is REDACTED from the assertion text. Measured on Gilded Wave 5c
  // (2026-07-30): the run read `Verification command exits 0: <path>` out of its
  // own contract and ran that gate directly — the exact leak the held-out-gate
  // rule exists to prevent, since a visible gate can be tuned to. The assertion
  // still exists, so taskError/errorTrend still measure the mission; only the
  // path is withheld.
  const contract = checkCmd
    ? {
        title: `Mission: ${marker}`,
        brief: task.slice(0, 200),
        assertions: ['The held-out verification gate for this mission exits 0. The dispatcher runs it after the mission ends; it is not yours to run and you are not told what it is.'],
      }
    : undefined
  // Finding (ag): the brief is the instrument this mission is judged against, and
  // this driver is the only component that knows where it lives. Measured on
  // Gilded L4.6b, a run rewrote the brief it had been Read three times with a
  // plausible reconstruction of its own. Finding (ac) built the refusal but fed
  // it from LOCALCODE_IMMUTABLE_PATHS, read inside the engine process — which
  // this driver, a WebSocket client, cannot set. So it travels with the message.
  const readOnlyPaths = [resolve(taskFile).replace(/\\/g, '/')]
  ws.send(JSON.stringify({
    type: 'user.message', text: task, cwd: CWD, readOnlyPaths,
    // This driver is a script, not a person. An AskUser raised here is broadcast
    // to an empty room and "answered" only by the AskBroker's 300s timeout —
    // measured on Gilded UI Wave 6, five minutes spent learning nothing.
    unattended: true,
    ...(contract ? { contract } : {}),
  }))
}
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data)
    collector.ingest(m)
    if (m.type === 's5.decision' && m.enforced === true && !enforcedWarned) {
      // Engine was started without LOCALCODE_S5_ENFORCE=false: S5 can restrict
      // tools mid-mission (F7) and enforcement confounds the ledger labels.
      console.log('[driver] WARNING: S5 ENFORCEMENT ACTIVE — restart engine with LOCALCODE_S5_ENFORCE=false (F7 risk, ledger labels confounded)')
      enforcedWarned = true
    }
    if (m.type === 'tool.start') {
      toolCount++
      console.log(`[cynco] tool: ${m.toolName}`)
      // Any tool call means the run is still working, whatever it has committed.
      sawMessageComplete = false
      lastActivityAt = Date.now()
    }
    if (m.type === 'message.complete') { sawMessageComplete = true; lastActivityAt = Date.now() }
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
ws.onclose = () => {
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

async function gitHead() {
  const p = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: CWD, stdout: 'pipe', stderr: 'ignore' })
  const out = (await new Response(p.stdout).text()).trim()
  return /^[0-9a-f]{7,40}$/.test(out) ? out : null
}

// The marker must appear in a commit THIS mission made, not in one that was
// already there. Polling `git log -3` for the marker string meant a follow-up
// mission whose marker matched the previous mission's own subject line reported
// COMMIT LANDED on its first poll and closed after one turn — which is how UI
// Wave 1c died 30 seconds in, having matched Wave 1b's commit.
const baselineSha = await gitHead()
if (!baselineSha) {
  console.log('[driver] WARNING: could not read HEAD — commit detection will match ANY of the last 3 commits, including pre-existing ones')
}

async function gitLog() {
  const range = baselineSha ? [`${baselineSha}..HEAD`] : ['-3']
  const p = Bun.spawn(['git', 'log', '--oneline', ...range], { cwd: CWD, stdout: 'pipe' })
  return await new Response(p.stdout).text()
}

console.log(`[driver] baseline HEAD ${baselineSha ?? '(unknown)'} — looking for "${marker}" in commits after it`)
const start = Date.now()
let landed = false
let quiet = false
while (!quiet && !zeroToolCompletion && (Date.now() - start) / 1000 < TIMEOUT_S) {
  await Bun.sleep(30000)
  try {
    const g = await fetch(GOV_URL, { headers: { Authorization: `Bearer ${inferenceToken}` } }).then(r => r.json())
    console.log(`[gov] status=${g.status} stuck=${g.stuckTurns} toolOK=${g.toolSuccessRate}`)
  } catch { console.log('[gov] unreachable') }
  // Never let a git hiccup kill the loop — the ledger write at the end must run
  try {
    const log = await gitLog()
    if (log.includes(marker) && !landed) {
      console.log('[driver] COMMIT LANDED:\n' + log)
      landed = true
    }
  } catch (e) { console.log(`[driver] git poll failed: ${e?.message ?? e}`) }
  // Only a landed mission is worth waiting for quiescence on; if nothing has
  // landed the timeout is the right stop. A run that lands and then keeps
  // working — amending the commit, fixing a name — must finish before the
  // check runs, or the check measures a state that no longer exists.
  if (landed && sawMessageComplete && Date.now() - lastActivityAt >= QUIET_MS) {
    console.log(`[driver] run quiet for ${Math.round((Date.now() - lastActivityAt) / 1000)}s after a completed message — proceeding to verification`)
    quiet = true
  }
}
if (!landed) console.log('[driver] TIMEOUT without commit — log a failure entry (docs/cynco-failure-log.md)')
else if (!quiet) console.log('[driver] WARNING: commit landed but the run never went quiet — the check below may read a commit the run is still amending (see QUIET_MS)')
try {
  const p = Bun.spawn(['git', 'status', '--short'], { cwd: CWD, stdout: 'pipe' })
  console.log('[git status]\n' + await new Response(p.stdout).text())
} catch (e) { console.log(`[driver] git status failed: ${e?.message ?? e}`) }

// Phase 2(b): brief-supplied check command labels the record automatically.
// Runs for EVERY outcome — a timeout mission that somehow landed working code
// earns verified:true, and a "landed" commit that breaks the check earns
// verified:false. Both are exactly the labels the falsification program needs.
const CHECK_TIMEOUT_MS = 300000
let verified
let verify = null
if (checkCmd) {
  console.log(`[verify] running check in ${CWD}: ${checkCmd}`)
  const r = runCheck(checkCmd, CWD, CHECK_TIMEOUT_MS)
  verified = r.verified
  verify = { command: checkCmd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: r.outputTail }
  console.log(`[verify] ${verified ? 'PASS' : 'FAIL'} (exit=${r.exitCode ?? 'none'}${r.timedOut ? ', TIMED OUT' : ''}, ${r.durationMs}ms)`)
  if (!verified) console.log(`[verify] output tail:\n${r.outputTail}`)
}

// Append the labeled mission record to the outcome ledger
const outcome = landed ? 'landed' : zeroToolCompletion ? 'zero_tool_fail' : 'timeout'
try {
  const record = buildMissionRecord(collector, {
    missionId,
    briefFile: taskFile,
    marker,
    cwd: CWD,
    dispatchedAt,
    durationS: Math.round((Date.now() - start) / 1000),
    outcome,
    verified,
    verify,
  })
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n')
  console.log(`[ledger] ${outcome} record ${missionId} appended (${collector.turns.length} turns, ${collector.s5Decisions.length} S5 decisions) → ${LEDGER_PATH}`)
  if (!checkCmd) console.log('[ledger] no check-cmd given — patch "verified": true|false after independent verification')
  // `verified` is one check command's exit code. It cannot say whether the new
  // tests BITE — only a withheld mutation set can, and those run later. Say so
  // on every record, so nobody reads verified:true as accepted.
  console.log(`[ledger] mutationSweep: null (UNMEASURED) — patch it once the withheld set has run: { command, killed, total, survived[] }`)
  // 1-in-5 human spot-audit cadence (STATE doc Phase 2(b)).
  try {
    const count = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).length
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

process.exit(landed ? 0 : 1)
