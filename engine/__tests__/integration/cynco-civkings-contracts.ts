#!/usr/bin/env bun
/**
 * CivKings with forced contracts — test if model actually writes files.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Contract Test — 27B Dense ═══')
const ws = new WebSocket(WS_URL)
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 10000)
  ws.onopen = () => { clearTimeout(t); log('Connected'); res() }
  ws.onerror = () => { clearTimeout(t); rej(new Error('err')) }
})

ws.onmessage = (msg) => {
  try {
    const evt = JSON.parse(msg.data as string) as Event
    allEvents.push(evt)
    const name = evt.toolName as string ?? ''
    if (evt.type === 'tool.start') {
      if (['Edit', 'Write', 'Bash', 'Git', 'ContractCreate', 'ContractAssertPass', 'ContractStatus'].includes(name))
        log(`  ★ ${name}`)
      else if (['Grep', 'CodeIndex'].includes(name)) log(`  🔍 ${name}`)
      else log(`  ${name}`)
    }
    else if (evt.type === 'tool.complete' && evt.isError) log(`  ✗ FAIL: ${name}`)
    else if (evt.type === 'approval.request') {
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') {
      completes++
      log(`  ── done (${Math.round((Date.now() - taskStart) / 1000)}s) ──`)
    }
  } catch {}
}

await sleep(3000)
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)
completes = 0

async function task(name: string, prompt: string, sec = 600) {
  log(`\n═══ ${name} ═══`)
  const pre = completes
  taskStart = Date.now()
  ws.send(JSON.stringify({ type: 'user.message', text: prompt }))
  for (let i = 0; i < sec; i++) {
    if (completes > pre) return true
    await sleep(1000)
  }
  log('  TIMEOUT')
  return false
}

// ── Task 1: Create combat popup (the model kept faking this) ──
await task('Create combat_popup.py',
`Create a new file pygame_app/popups/combat_popup.py with a CombatPopup class. It should:
- Import pygame and pygame_gui
- Have __init__(self, manager, attacker, defender, game) that creates a UIWindow with attacker/defender stats labels and a "Fight!" button
- Have handle_event(self, event) that resolves combat when Fight is clicked
- Use resolve_combat from combat.py

Write the file with the Write tool. Then git add and git commit with message "feat: add combat popup".`
)

// ── Task 2: Create religion popup ──
await task('Create religion_popup.py',
`Create a new file pygame_app/popups/religion_popup.py with a ReligionPopup class. It should:
- Import pygame and pygame_gui
- Have __init__(self, manager, game, player_civ) that creates a UIWindow showing faith points and founded religions
- Display each religion's name, founder, and follower count

Write the file with the Write tool. Then git add and git commit with message "feat: add religion popup".`
)

// ── Summary ──
log('\n═══ Results ═══')
const writes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Write').length
const edits = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Edit').length
const contracts = allEvents.filter(e => e.type === 'tool.start' && (e.toolName as string ?? '').includes('Contract')).length
const bashes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Bash').length
log(`Writes: ${writes}, Edits: ${edits}, Contracts: ${contracts}, Bash: ${bashes}`)
log(`Completed: ${completes}/2`)

// Verify files actually exist
const { execSync } = require('child_process')
try {
  execSync('ls pygame_app/popups/combat_popup.py', { cwd: 'C:\\Users\\civer\\civkings' })
  log('✓ combat_popup.py EXISTS')
} catch { log('✗ combat_popup.py MISSING') }

try {
  execSync('ls pygame_app/popups/religion_popup.py', { cwd: 'C:\\Users\\civer\\civkings' })
  log('✓ religion_popup.py EXISTS')
} catch { log('✗ religion_popup.py MISSING') }

try {
  log(`\n${execSync('git log --oneline -5', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

// Check engine log for contract auto-creation
try {
  const log_content = require('fs').readFileSync('C:\\Users\\civer\\AppData\\Local\\Temp\\cynco-contracts.log', 'utf-8')
  const contractLines = log_content.split('\n').filter((l: string) => l.includes('[contract]'))
  for (const l of contractLines) console.log(`  ${l}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
