#!/usr/bin/env bun
const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Last 2 Tasks ═══')
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
      if (['Edit', 'Write', 'Bash', 'ContractAssertPass', 'ContractStatus'].includes(name)) log(`  ★ ${name}`)
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

// ── 1: gather_intel ──
await task('Add gather_intel to game.py',
`Edit the file game.py to add a gather_intel method to the Game class.

Step 1: Run this grep to find the end of the Game class:
  grep -n "^    def " game.py | tail -5

Step 2: Read the last 20 lines of the last method found.

Step 3: Use the Edit tool to add this method right after the last method in the Game class. Use the last line of the last method as old_string, and new_string should be that same line followed by the new method:

    def gather_intel(self, spy_unit, target_city):
        """Gather intelligence on a foreign city."""
        return {
            "city": target_city.name,
            "production": [b.name for b in getattr(target_city, 'build_queue', [])],
            "garrison": len([u for u in self.military_manager.units
                           if u.civ == target_city.civ and u.position == target_city.position]),
        }

Step 4: Run git add game.py && git commit -m "feat: add gather_intel espionage action"

You MUST use the Edit tool to modify game.py. You MUST commit.`
)

// ── 2: Wire combat popup ──
await task('Wire combat into game_screen.py',
`Edit the file pygame_app/screens/game_screen.py to wire in the combat popup.

Step 1: Grep for "import" at the top of game_screen.py to see existing imports. Read the first 20 lines.

Step 2: Use Edit to add this import after the other imports:
  from pygame_app.popups.combat_popup import CombatPopup

Step 3: Grep for "click\|select.*tile\|on_tile\|handle.*event" in game_screen.py to find where tile clicks are processed. Read 30 lines around it.

Step 4: Use Edit to add combat detection in the click handler. When a selected unit clicks a tile with an enemy unit, create the popup. Add something like:
  # Check for enemy unit on clicked tile
  if self.selected_unit and target_tile:
      enemy_units = [u for u in self.game.military_manager.units if u.position == target_tile.position and u.civ != self.selected_unit.civ]
      if enemy_units:
          self.combat_popup = CombatPopup(self.ui_manager, self.selected_unit, enemy_units[0], self.game)

Step 5: Run git add pygame_app/screens/game_screen.py && git commit -m "feat: wire combat popup into game screen"

You MUST use Edit to modify the file. You MUST commit.`
)

// ── Verify ──
log('\n═══ Verify ═══')
const { execSync } = require('child_process')
try {
  const gi = execSync('grep -c "gather_intel" game.py', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' }).trim()
  log(`gather_intel in game.py: ${gi} occurrences`)
} catch { log('gather_intel: NOT FOUND') }

try {
  const cp = execSync('grep -c "CombatPopup" pygame_app/screens/game_screen.py', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' }).trim()
  log(`CombatPopup in game_screen.py: ${cp} occurrences`)
} catch { log('CombatPopup in game_screen: NOT FOUND') }

try {
  log(`\n${execSync('git log --oneline -5', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

const edits = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Edit').length
const contracts = allEvents.filter(e => e.type === 'tool.start' && (e.toolName as string ?? '').includes('Contract')).length
log(`Edits: ${edits}, Contracts: ${contracts}`)

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
