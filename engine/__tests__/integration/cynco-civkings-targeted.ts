#!/usr/bin/env bun
/**
 * CynCo CivKings Sprint v2 — Targeted prompts with exact file paths.
 * Simpler prompts that small models can execute without getting lost.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0
let taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CynCo CivKings Sprint v2 (targeted) ═══')
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
    if (evt.type === 'tool.start') log(`  ${evt.toolName}`)
    else if (evt.type === 'tool.complete' && evt.isError) log(`  FAIL: ${evt.toolName}`)
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

async function task(name: string, prompt: string, sec = 180) {
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

// ── Task 1: Default AI civs ──
await task('Default AI civs',
`In game.py, find the __init__ method of the Game class. The ai_civs parameter might be empty. Add this at the start of __init__, right after the parameters are received:

if not ai_civs:
    ai_civs = ["Rome", "Greece"]

Read game.py first, find the exact spot, make the edit, and commit with message "fix: default to Rome and Greece AI civs if none provided".`
)

// ── Task 2: Faith tracking in game.py ──
await task('Add faith dict to game.py',
`In game.py, find where gold or gold_per_civ is initialized in the Game.__init__ method. Add a similar line for faith:

self.faith_points = {civ: 0 for civ in self.civilizations}

Read game.py, find the gold initialization, add faith_points right after it, and commit with message "feat: add faith_points tracking per civilization".`
)

// ── Task 3: Faith in resource bar ──
await task('Add faith to resource bar',
`In pygame_app/panels/resource_bar.py, find where gold/science/food are displayed. Add faith to the display in the same pattern. The faith value should come from self.game.faith_points.get(player_civ, 0). Read the file first to see the exact pattern, then add faith. Commit with message "feat: display faith in resource bar".`
)

// ── Task 4: Delete dead code ──
await task('Delete dead code',
`Run: ls *.py | grep -E "^fix_|backup|original"
Then delete all the files that match. These are dead code from early development. Use rm for each file. Then commit with message "chore: remove fix scripts and backup files".`
)

// ── Task 5: Victory check wiring ──
await task('Wire victory checks',
`Read victory.py to see what the VictoryTracker class looks like and what check methods it has. Then read game.py and search for "victory" to see if check_victory is called during process_turn. If it is NOT called, add a call to self.victory_tracker.check_victory() at the end of process_turn(). Commit with message "feat: wire victory condition checks into turn processing".`, 240
)

// ── Task 6: Simple espionage action ──
await task('Add espionage gather intel',
`In game.py, add a method called gather_intel(self, spy_unit, target_city) that returns the target city's production queue and garrison units as a dict:

def gather_intel(self, spy_unit, target_city):
    """Gather intelligence on a foreign city."""
    return {
        "city": target_city.name,
        "production": [b.name for b in target_city.build_queue] if hasattr(target_city, 'build_queue') else [],
        "garrison": len([u for u in self.military_manager.units if u.civ == target_city.civ and u.position == target_city.position]),
    }

Read game.py, add this method to the Game class, and commit with message "feat: add gather_intel espionage action".`, 240
)

// ── Summary ──
log('\n═══ Sprint Complete ═══')
const tools = allEvents.filter(e => e.type === 'tool.start').length
const edits = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Edit' || e.toolName === 'Write')).length
const bashes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Bash').length
const gits = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Git').length
log(`Tool calls: ${tools} (${edits} edits, ${bashes} bash, ${gits} git)`)
log(`Tasks completed: ${completes}`)

const fs = require('fs')
const os = require('os')
const path = require('path')
try {
  const lines = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl'), 'utf-8').trim().split('\n').length
  log(`S5 training entries: ${lines}`)
} catch { log('No training journal found') }

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
