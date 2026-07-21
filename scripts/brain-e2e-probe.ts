/**
 * T17 Step 3 E2E probe: connect to the dashboard WS as a late-joining client,
 * drive one turn through the engine's TUI WS, and report every brain.* message
 * the dashboard receives. Run: bun scripts/brain-e2e-probe.ts
 */
const brainMsgs: Record<string, unknown[]> = {}
let done = false

const dash = new WebSocket('ws://127.0.0.1:9161/ws')
dash.onmessage = (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (typeof m.type === 'string' && m.type.startsWith('brain.')) {
      ;(brainMsgs[m.type] ??= []).push(m)
    }
  } catch {}
}
await new Promise<void>((res, rej) => { dash.onopen = () => res(); dash.onerror = rej })
console.log('[probe] dashboard WS connected')

const tui = new WebSocket('ws://127.0.0.1:9160')
tui.onmessage = (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'message.complete') done = true
    if (m.type === 'approval.request') {
      tui.send(JSON.stringify({ type: 'approval.response', requestId: m.requestId, approved: false }))
    }
  } catch {}
}
await new Promise<void>((res, rej) => { tui.onopen = () => res(); tui.onerror = rej })
console.log('[probe] TUI WS connected — sending prompt')
tui.send(JSON.stringify({
  type: 'user.message',
  text: 'What city is the Eiffel Tower in? Answer in one short sentence. Do not use any tools.',
}))

const deadline = Date.now() + 180_000
while (!done && Date.now() < deadline) await new Promise(r => setTimeout(r, 500))
await new Promise(r => setTimeout(r, 2000))  // let trailing broadcasts land

console.log(`[probe] turn complete=${done}`)
for (const [type, msgs] of Object.entries(brainMsgs)) {
  console.log(`\n=== ${type}: ${msgs.length} messages ===`)
  if (type === 'brain.tier') console.log(JSON.stringify(msgs))
  if (type === 'brain.uncertainty') {
    const pts = msgs.flatMap((m: any) => m.points ?? [])
    console.log(`total points: ${pts.length}; sample:`, JSON.stringify(pts.slice(0, 3)))
  }
  if (type === 'brain.workspace') {
    for (const m of msgs.slice(-5) as any[]) {
      const top = (m.top ?? []).slice(0, 5).map((t: any) => t.token ?? t[0])
      console.log(`layer ${m.layer} pos ${m.pos}:`, JSON.stringify(top))
    }
  }
  if (type === 'brain.thinking') console.log(JSON.stringify((msgs as any[]).slice(-1)[0]).slice(0, 300))
}
dash.close(); tui.close()
process.exit(done && brainMsgs['brain.tier'] ? 0 : 1)
