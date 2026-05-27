#!/usr/bin/env bun
/**
 * CynCo CivKings Sprint — Automated task runner.
 *
 * Sends real coding tasks to CynCo pointed at the CivKings repo.
 * CynCo reads, edits, and commits. We just send prompts and wait.
 * Generates S5 decision training data in ~/.cynco/training/
 *
 * Usage: Start engine in civkings dir first:
 *   cd C:/Users/civer/civkings && LOCALCODE_MODEL=qwen3.6 bun C:/Users/civer/localcode/engine/main.ts
 *
 * Then:
 *   bun engine/__tests__/integration/cynco-civkings-sprint.ts
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`

type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let messageCompleteCount = 0
let taskStartTime = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Connect ──────────────────────────────────────────────────

log('═══ CynCo CivKings Sprint ═══')
log(`Connecting to ${WS_URL}...`)

const ws = new WebSocket(WS_URL)
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 10000)
  ws.onopen = () => { clearTimeout(t); log('Connected'); resolve() }
  ws.onerror = () => { clearTimeout(t); reject(new Error('WS error')) }
})

ws.onmessage = (msg) => {
  try {
    const evt = JSON.parse(msg.data as string) as Event
    allEvents.push(evt)
    if (evt.type === 'tool.start') log(`  tool: ${evt.toolName}`)
    else if (evt.type === 'tool.complete' && evt.isError) log(`  tool FAIL: ${evt.toolName}`)
    else if (evt.type === 'approval.request') {
      log(`  auto-approve: ${evt.toolName}`)
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') {
      messageCompleteCount++
      const elapsed = Math.round((Date.now() - taskStartTime) / 1000)
      log(`  ── message.complete (${elapsed}s) ──`)
    }
    else if (evt.type === 'governance.status') {
      log(`  governance: ${evt.health}`)
    }
    else if (evt.type === 'governance.recommendation') {
      log(`  ★ recommendation: ${evt.signal} — ${(evt.title as string ?? '').slice(0, 60)}`)
    }
  } catch {}
}

await sleep(3000)

// Auto-approve everything
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)
messageCompleteCount = 0

async function sendTask(name: string, prompt: string, timeoutSec: number = 300): Promise<boolean> {
  log('')
  log(`═══ TASK: ${name} ═══`)
  const preCount = messageCompleteCount
  taskStartTime = Date.now()

  ws.send(JSON.stringify({ type: 'user.message', text: prompt }))

  for (let i = 0; i < timeoutSec; i++) {
    if (messageCompleteCount > preCount) return true
    await sleep(1000)
  }
  log(`  TIMEOUT after ${timeoutSec}s`)
  return false
}

// ═══════════════════════════════════════════════════════════════
// Task 1: Fix settler city founding crash
// ═══════════════════════════════════════════════════════════════

await sendTask('Fix settler crash', `
There is a critical crash when a Settler unit tries to found a city. Read the crash log in crash_log.txt to see the exact error. The bug is in pygame_app/screens/game_screen.py — it calls game.map.remove_unit(unit) but HexMap has no remove_unit method. It should call game.military_manager.remove_unit(unit) instead. Find the exact line, fix it, and commit the change.
`)

// ═══════════════════════════════════════════════════════════════
// Task 2: Ensure AI players exist
// ═══════════════════════════════════════════════════════════════

await sendTask('Ensure AI players', `
Read pygame_app/app.py and game.py to understand how the game is created. Make sure the game always starts with at least 2 AI civilizations (Rome and Greece) even if ai_civs is not explicitly passed. Check the Game constructor in game.py — if ai_civs is empty or None, default it to at least 2 AI civs. Fix and commit.
`)

// ═══════════════════════════════════════════════════════════════
// Task 3: Add combat popup
// ═══════════════════════════════════════════════════════════════

await sendTask('Add combat popup', `
The combat system exists in combat.py with resolve_combat() but there is no interactive combat UI in the pygame interface. Create a CombatPopup in pygame_app/popups/combat_popup.py that shows:
- The attacking and defending unit names and stats (attack, defense, hp)
- Terrain name for the defending tile
- A "Fight" button that resolves combat
- The result (winner, casualties)

Look at pygame_app/popups/diplomacy_popup.py for the popup pattern to follow. Keep it simple — just a modal dialog with labels and a button. Commit when done.
`, 600)

// ═══════════════════════════════════════════════════════════════
// Task 4: Wire combat popup into game screen
// ═══════════════════════════════════════════════════════════════

await sendTask('Wire combat into game screen', `
Read pygame_app/screens/game_screen.py and find where tile clicks are handled. When a unit is selected and the player clicks on a tile containing an enemy unit, show the CombatPopup (from pygame_app/popups/combat_popup.py). You need to:
1. Import the CombatPopup
2. In the click handler, detect when clicking an enemy-occupied tile with a selected friendly unit
3. Create and show the popup
4. Handle the popup result (apply combat outcome to units)

Read game.py to understand how to check if a tile has enemy units. Commit when done.
`, 600)

// ═══════════════════════════════════════════════════════════════
// Task 5: Add faith tracking to religion
// ═══════════════════════════════════════════════════════════════

await sendTask('Add faith tracking', `
Read religion.py. The religion system is very basic. Add faith point tracking:
1. In game.py, add a faith_points dict tracking faith per civilization (similar to how gold is tracked)
2. In city.py, when a city has a "Temple" or "Shrine" building, generate +2 faith per turn during the city's production step
3. Make sure faith is displayed in the pygame resource bar — read pygame_app/panels/resource_bar.py to see how gold/science/food are displayed, and add faith the same way

Keep changes minimal. Commit when done.
`, 600)

// ═══════════════════════════════════════════════════════════════
// Task 6: Clean dead code
// ═══════════════════════════════════════════════════════════════

await sendTask('Clean dead code', `
List all fix_*.py files and backup files (gui_popups_backup.py, gui_popups_original.py) in the root directory. These are dead code from early development. Delete them all. Also delete any __pycache__ directories. Commit the cleanup.
`)

// ═══════════════════════════════════════════════════════════════
// Task 7: Verify victory conditions
// ═══════════════════════════════════════════════════════════════

await sendTask('Verify victory conditions', `
Read victory.py and game.py. Check that all 5 victory conditions (Domination, Science, Culture, Diplomacy, Dynasty) are actually checked each turn during turn processing in game.py. If any are missing, wire them in. Read game.py's process_turn method to see what happens each turn. Commit any fixes.
`)

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

log('')
log('═══ Sprint Complete ═══')
log(`Total events: ${allEvents.length}`)

const toolStarts = allEvents.filter(e => e.type === 'tool.start')
const toolFails = allEvents.filter(e => e.type === 'tool.complete' && e.isError)
const govEvents = allEvents.filter(e => e.type === 'governance.status')
const govRecs = allEvents.filter(e => e.type === 'governance.recommendation')

log(`Tool calls: ${toolStarts.length}`)
log(`Tool failures: ${toolFails.length}`)
log(`Governance events: ${govEvents.length}`)
log(`Governance recommendations: ${govRecs.length}`)
log(`Messages completed: ${messageCompleteCount}`)

// Check training data
const fs = require('fs')
const os = require('os')
const path = require('path')
const journalPath = path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl')
try {
  const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n').length
  log(`S5 training entries: ${lines}`)
} catch {
  log('S5 training journal not found')
}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(3000)
ws.close()
log('Done.')
