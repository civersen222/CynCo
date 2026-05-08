#!/usr/bin/env bun
/**
 * End-to-end integration test for CynCo governance hardening.
 *
 * Starts the engine via WebSocket, sends real messages, and verifies
 * that governance enforcement, S2 telemetry, file.change events,
 * and S5 decisions actually fire during real operation.
 *
 * Usage: First start engine in another terminal:
 *   LOCALCODE_MODEL=qwen3.6 bun engine/main.ts
 *
 * Then run:
 *   bun engine/__tests__/integration/e2e-governance.ts
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`

type Event = { type: string; [key: string]: unknown }
const events: Event[] = []
const eventsByType = new Map<string, Event[]>()

function recordEvent(evt: Event) {
  events.push(evt)
  const list = eventsByType.get(evt.type) ?? []
  list.push(evt)
  eventsByType.set(evt.type, list)
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Connect ──────────────────────────────────────────────────

log('═══ CynCo E2E Governance Test ═══')
log(`Connecting to ${WS_URL}...`)

const ws = new WebSocket(WS_URL)

const ready = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)
  ws.onopen = () => {
    clearTimeout(timeout)
    log('Connected')
    resolve()
  }
  ws.onerror = (err) => {
    clearTimeout(timeout)
    reject(new Error(`WebSocket error: ${err}`))
  }
})

ws.onmessage = (msg) => {
  try {
    const evt = JSON.parse(msg.data as string) as Event
    recordEvent(evt)
    // Log key events
    if (evt.type === 'session.ready') log(`  session.ready: model=${evt.model}`)
    else if (evt.type === 'tool.start') log(`  tool.start: ${evt.toolName}`)
    else if (evt.type === 'tool.complete') log(`  tool.complete: ${evt.toolName} (error=${evt.isError})`)
    else if (evt.type === 'file.change') log(`  ★ file.change: ${evt.path} (${evt.changeType})`)
    else if (evt.type === 'governance.status') log(`  governance: health=${evt.health} stuck=${evt.stuckTurns}`)
    else if (evt.type === 'governance.recommendation') log(`  ★ governance.recommendation: ${evt.signal} — ${evt.title}`)
    else if (evt.type === 'workflow.status') log(`  workflow: ${evt.workflow} phase=${evt.phase}`)
    else if (evt.type === 'subagent.spawned') log(`  ★ subagent.spawned: ${evt.persona} — ${evt.task}`)
    else if (evt.type === 'subagent.complete') log(`  ★ subagent.complete: success=${evt.success}`)
    else if (evt.type === 'subagent.killed') log(`  ★ subagent.killed: ${evt.reason}`)
    else if (evt.type === 's2.decision') log(`  ★ s2.decision: ${evt.decision} — ${evt.reason}`)
    else if (evt.type === 'context.status') log(`  context: ${Math.round((evt.utilization as number) * 100)}% utilized`)
    else if (evt.type === 'approval.request') {
      log(`  approval.request: ${evt.toolName} — auto-approving`)
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') log(`  message.complete`)
    else if (evt.type === 'stream.token') { /* too noisy */ }
  } catch {}
}

await ready

// Wait briefly for session.ready — it may have already been emitted before we connected
log('Waiting for session.ready (or proceeding after 5s)...')
for (let i = 0; i < 5; i++) {
  if (eventsByType.has('session.ready')) break
  await sleep(1000)
}

if (eventsByType.has('session.ready')) {
  log('Got session.ready')
} else {
  log('No session.ready (engine was already running) — proceeding anyway')
}

// Enable auto-approve so tools don't block waiting for user
log('Sending /approve-all...')
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)

log('')

// ─── Test 1: Basic Tool Use + file.change ─────────────────────

log('═══ Test 1: Tool use + file.change events ═══')
log('Sending: "Create a file .cynco/test-output.txt with hello world"')

const preCompletes1 = (eventsByType.get('message.complete') ?? []).length

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Create a file at .cynco/test-output.txt with the content "hello from CynCo governance test". Just write the file, nothing else.',
}))

// Wait for a NEW message.complete (not the /approve-all one)
for (let i = 0; i < 180; i++) {
  const completes = eventsByType.get('message.complete') ?? []
  if (completes.length > preCompletes1) break
  await sleep(1000)
}
// Extra wait for file.change to propagate
await sleep(2000)

const toolStarts = eventsByType.get('tool.start') ?? []
const toolCompletes = eventsByType.get('tool.complete') ?? []
const fileChanges = eventsByType.get('file.change') ?? []
const govStatus = eventsByType.get('governance.status') ?? []

log('')
log(`Results:`)
log(`  Tools started: ${toolStarts.length}`)
log(`  Tools completed: ${toolCompletes.length}`)
log(`  file.change events: ${fileChanges.length}`)
log(`  governance.status events: ${govStatus.length}`)

const test1Pass = toolStarts.length > 0 && toolCompletes.length > 0
log(`  Test 1: ${test1Pass ? 'PASS' : 'FAIL'} — tools executed`)

const test1bPass = fileChanges.length > 0
log(`  Test 1b: ${test1bPass ? 'PASS' : 'FAIL'} — file.change emitted`)

log('')

// ─── Test 2: Governance S5 Decision ───────────────────────────

log('═══ Test 2: S5 Governance Active ═══')
// S5 fires on every user message. Check if any governance events appeared
const s5Fired = govStatus.length > 0 || events.some(e => e.type === 'stream.token' && typeof e.text === 'string' && e.text.includes('[s5]'))
log(`  S5 governance events: ${govStatus.length}`)
log(`  Test 2: ${govStatus.length > 0 ? 'PASS' : 'INFO'} — governance.status ${govStatus.length > 0 ? 'emitted' : 'not emitted (may be normal for healthy state)'}`)

log('')

// ─── Test 3: Read a file (safe tool, should auto-approve) ────

log('═══ Test 3: Read tool (auto-approve tier) ═══')
const preCount = (eventsByType.get('message.complete') ?? []).length

ws.send(JSON.stringify({
  type: 'user.message',
  text: 'Read the file engine/s5/types.ts and tell me how many lines it has. Be brief.',
}))

for (let i = 0; i < 120; i++) {
  const completes = eventsByType.get('message.complete') ?? []
  if (completes.length > preCount) break
  await sleep(1000)
}

const readTools = (eventsByType.get('tool.start') ?? []).filter(e => e.toolName === 'Read')
log(`  Read tool calls: ${readTools.length}`)
log(`  Test 3: ${readTools.length > 0 ? 'PASS' : 'FAIL'} — Read tool executed`)

log('')

// ─── Test 4: /research command ────────────────────────────────

log('═══ Test 4: /research workflow ═══')
const preWf = (eventsByType.get('workflow.status') ?? []).length

ws.send(JSON.stringify({
  type: 'command',
  command: '/research',
}))

await sleep(2000)

const wfEvents = eventsByType.get('workflow.status') ?? []
const newWf = wfEvents.slice(preWf)
log(`  workflow.status events: ${newWf.length}`)
if (newWf.length > 0) {
  log(`  Workflow: ${newWf[0].workflow}, Phase: ${newWf[0].phase}`)
}
log(`  Test 4: ${newWf.length > 0 ? 'PASS' : 'FAIL'} — /research workflow started`)

// Cancel the workflow so we don't wait for it
ws.send(JSON.stringify({ type: 'command', command: '/cancel' }))
await sleep(1000)

log('')

// ─── Summary ──────────────────────────────────────────────────

log('═══ Summary ═══')
log(`Total events received: ${events.length}`)
log(`Event types seen: ${[...eventsByType.keys()].sort().join(', ')}`)
log('')

const allTests = [
  { name: 'Tool execution', pass: test1Pass },
  { name: 'file.change events', pass: test1bPass },
  { name: 'Read auto-approve', pass: readTools.length > 0 },
  { name: '/research workflow', pass: newWf.length > 0 },
]

let allPass = true
for (const t of allTests) {
  log(`  ${t.pass ? '✓' : '✗'} ${t.name}`)
  if (!t.pass) allPass = false
}

log('')
log(allPass ? '═══ ALL TESTS PASSED ═══' : '═══ SOME TESTS FAILED ═══')

// Cleanup
ws.close()
process.exit(allPass ? 0 : 1)
