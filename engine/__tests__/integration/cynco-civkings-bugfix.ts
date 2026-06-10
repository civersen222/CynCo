#!/usr/bin/env bun
/**
 * CivKings bugfix sprint — 5 bugs found during 200-turn headless playtest.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Bugfix Sprint ═══')
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

const results: { name: string; ok: boolean; secs: number }[] = []

async function task(name: string, prompt: string, sec = 600) {
  log(`\n═══ ${name} ═══`)
  const pre = completes
  taskStart = Date.now()
  ws.send(JSON.stringify({ type: 'user.message', text: prompt }))
  for (let i = 0; i < sec; i++) {
    if (completes > pre) {
      results.push({ name, ok: true, secs: Math.round((Date.now() - taskStart) / 1000) })
      return true
    }
    await sleep(1000)
  }
  log('  TIMEOUT')
  results.push({ name, ok: false, secs: sec })
  return false
}

// ── Bug 1: StabilitySystem.apply_change missing ──
await task('Fix StabilitySystem.apply_change',
`BUG: game.py line 693 calls self.stability_system.apply_change() during _handle_succession but StabilitySystem has no method called apply_change.

Fix: Grep for "class StabilitySystem" in stability_system.py. Read 30 lines to see what methods exist. Then grep for "apply_change" in game.py to see how it's called. Either rename the call to match an existing method, or add the missing method to StabilitySystem.

Edit the file that needs fixing. git add && git commit -m "fix: add missing apply_change to StabilitySystem for succession".`
)

// ── Bug 2: unit.civ should be unit.owner ──
await task('Fix unit.civ to unit.owner',
`BUG: The Unit class in military.py uses .owner (not .civ) for the civilization name. But these files incorrectly use .civ:
- pygame_app/popups/combat_popup.py uses self.attacker.civ
- game.py gather_intel uses u.civ

Grep for ".civ" in pygame_app/popups/combat_popup.py and in the gather_intel method of game.py. Replace every .civ with .owner.

Edit both files. git add && git commit -m "fix: use unit.owner instead of unit.civ everywhere".`
)

// ── Bug 3: Faith never accumulates ──
await task('Fix faith generation in city.py',
`BUG: Faith points are always 0 after 200 turns. The faith generation code in city.py is not working.

Grep for "faith" in city.py to find what was added. Read those lines. The problem is likely that:
1. The code is in the wrong method (not called each turn), OR
2. self.game is not accessible, OR
3. self.buildings is empty or buildings don't have .name attribute

Check what method is called per turn by grepping for "process_turn\|end_turn\|update" in city.py. Make sure faith generation runs in the right place. Debug by checking if self.buildings exists and what format it's in.

Fix the issue. git add && git commit -m "fix: faith generation actually runs during city turn processing".`
)

// ── Bug 4: Noisy Effect: print spam ──
await task('Suppress Effect: print spam',
`BUG: The game prints "Effect: gold 25", "Effect: science 10" etc. on every event, flooding the console.

Grep for 'Effect:' or 'print.*Effect' in all .py files to find where this print is. Read those lines. Either remove the print statement or wrap it in a debug flag check.

Edit the file. git add && git commit -m "fix: suppress noisy Effect: print spam from events".`
)

// ── Bug 5: AI never expands (no new cities/units in 200 turns) ──
await task('Fix AI expansion',
`BUG: After 200 turns, the game still has only 3 cities and 4 units — nobody is building anything.

Grep for "build\|produce\|queue\|train" in ai.py to see if the AI tries to build units/cities. Read 30 lines. Then grep for "produce\|build_queue\|production" in city.py to see how production works.

The issue is likely that:
1. AI is not queuing any production in cities
2. Or production is queued but never completes
3. Or cities don't have the production method called each turn

Find the root cause and fix it. git add && git commit -m "fix: AI actually produces units and buildings".`
)

// ── Verify ──
log('\n═══ Verify: 100-turn headless test ═══')
const preV = completes
taskStart = Date.now()
ws.send(JSON.stringify({
  type: 'user.message',
  text: `Run this Python test and tell me the output:

python -c "
from game import Game
from game_data import CIVILIZATIONS
g = Game(CIVILIZATIONS['Rome'], [CIVILIZATIONS['Greece'], CIVILIZATIONS['Egypt']])
bugs = 0
for i in range(100):
    try:
        g.process_turn()
    except:
        bugs += 1
print(f'Turns: {g.state.turn}, Bugs: {bugs}, Cities: {len(g.cities)}, Units: {len(g.military_manager.units)}, Faith: {g.faith_points}')
"`,
}))

for (let i = 0; i < 120; i++) {
  if (completes > preV) break
  await sleep(1000)
}

// ── Summary ──
log('\n═══════════════════════════════════════')
log('═══ RESULTS ═══')
log('═══════════════════════════════════════\n')

for (const r of results) {
  log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.ok ? r.secs + 's' : 'TIMEOUT'}`)
}
log(`\n${results.filter(r => r.ok).length}/${results.length} completed`)

const edits = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Edit').length
const contracts = allEvents.filter(e => e.type === 'tool.start' && (e.toolName as string ?? '').includes('Contract')).length
log(`Edits: ${edits}, Contracts: ${contracts}`)

try {
  const { execSync } = require('child_process')
  log(`\n${execSync('git log --oneline -15', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
