// Canonical CynCo mission driver (see docs/cynco-failure-log.md F5).
//
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s] [check-cmd]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
//   check-cmd:     shell command run in cwd AFTER the mission ends (Phase 2b);
//                  exit 0 => verified:true, else verified:false. Omit => null.
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

import { basename, join, dirname } from 'node:path'
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMissionCollector, buildMissionRecord } from './cynco-ledger.mjs'
import { runCheck } from './cynco-verify.mjs'

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

const ws = new WebSocket(WS_URL)
let toolCount = 0
let zeroToolCompletion = false
ws.onopen = () => {
  console.log('[driver] connected, dispatching mission')
  ws.send(JSON.stringify({ type: 'user.message', text: task, cwd: CWD }))
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
    if (m.type === 'tool.start') { toolCount++; console.log(`[cynco] tool: ${m.toolName}`) }
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
ws.onclose = () => console.log('[driver] ws closed')

async function gitLog() {
  const p = Bun.spawn(['git', 'log', '--oneline', '-3'], { cwd: CWD, stdout: 'pipe' })
  return await new Response(p.stdout).text()
}

const start = Date.now()
let landed = false
while (!landed && !zeroToolCompletion && (Date.now() - start) / 1000 < TIMEOUT_S) {
  await Bun.sleep(30000)
  try {
    const g = await fetch(GOV_URL).then(r => r.json())
    console.log(`[gov] status=${g.status} stuck=${g.stuckTurns} toolOK=${g.toolSuccessRate}`)
  } catch { console.log('[gov] unreachable') }
  // Never let a git hiccup kill the loop — the ledger write at the end must run
  try {
    const log = await gitLog()
    if (log.includes(marker)) {
      console.log('[driver] COMMIT LANDED:\n' + log)
      landed = true
    }
  } catch (e) { console.log(`[driver] git poll failed: ${e?.message ?? e}`) }
}
if (!landed) console.log('[driver] TIMEOUT without commit — log a failure entry (docs/cynco-failure-log.md)')
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
  // 1-in-5 human spot-audit cadence (STATE doc Phase 2(b)).
  try {
    const count = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).length
    if (count % 5 === 0) console.log(`[ledger] SPOT-AUDIT DUE: record #${count} — human-verify this mission's label (1-in-5 cadence)`)
  } catch {}
} catch (e) {
  console.log(`[ledger] FAILED to write record: ${e?.message ?? e}`)
}

process.exit(landed ? 0 : 1)
