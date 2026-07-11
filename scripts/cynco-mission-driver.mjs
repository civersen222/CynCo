// Canonical CynCo mission driver (see docs/cynco-failure-log.md F5).
//
// Usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s]
//   task-file:     path to a text file containing the full mission brief
//   commit-marker: substring expected in `git log --oneline` when the mission lands
//   cwd:           target repo for the mission (default: C:\Users\civer\civkings)
//   timeout-s:     max wait (default 600)
//
// Requires the engine running headless with LOCALCODE_APPROVE_ALL=true (F2).
// Mission briefs should follow the F3 pattern: one focused task, single-line
// unique Edit anchor (grep-verified), full replacement block verbatim.

const [taskFile, marker, cwdArg, timeoutArg] = process.argv.slice(2)
if (!taskFile || !marker) {
  console.error('usage: bun scripts/cynco-mission-driver.mjs <task-file> <commit-marker> [cwd] [timeout-s]')
  process.exit(2)
}
const CWD = cwdArg ?? 'C:\\Users\\civer\\civkings'
const TIMEOUT_S = parseInt(timeoutArg ?? '600', 10)
const WS_URL = 'ws://localhost:9160'
const GOV_URL = 'http://localhost:9161/api/governance'

const task = await Bun.file(taskFile).text()
console.log(`[driver] mission from ${taskFile} (${task.length} chars), marker="${marker}", cwd=${CWD}`)

const ws = new WebSocket(WS_URL)
ws.onopen = () => {
  console.log('[driver] connected, dispatching mission')
  ws.send(JSON.stringify({ type: 'user.message', text: task, cwd: CWD }))
}
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data)
    if (m.type === 'tool.start') console.log(`[cynco] tool: ${m.toolName}`)
    if (m.type === 'tool.complete' && m.isError) console.log(`[cynco] TOOL ERROR (${m.toolName}): ${String(m.result).slice(0, 200)}`)
    if (m.type === 'approval.request') console.log(`[cynco] APPROVAL REQUESTED (${m.toolName ?? '?'}) — engine not in APPROVE_ALL mode? (F2)`)
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
while (!landed && (Date.now() - start) / 1000 < TIMEOUT_S) {
  await Bun.sleep(30000)
  try {
    const g = await fetch(GOV_URL).then(r => r.json())
    console.log(`[gov] status=${g.status} stuck=${g.stuckTurns} toolOK=${g.toolSuccessRate}`)
  } catch { console.log('[gov] unreachable') }
  const log = await gitLog()
  if (log.includes(marker)) {
    console.log('[driver] COMMIT LANDED:\n' + log)
    landed = true
  }
}
if (!landed) console.log('[driver] TIMEOUT without commit — log a failure entry (docs/cynco-failure-log.md)')
const p = Bun.spawn(['git', 'status', '--short'], { cwd: CWD, stdout: 'pipe' })
console.log('[git status]\n' + await new Response(p.stdout).text())
process.exit(landed ? 0 : 1)
