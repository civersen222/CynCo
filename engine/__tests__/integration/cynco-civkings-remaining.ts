#!/usr/bin/env bun
/**
 * CivKings remaining tasks — contracts forced, 27B dense.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Remaining Tasks — Contracts Forced ═══')
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

// ── 1: Faith from temples in city.py ──
await task('Faith from temples in city.py',
`Edit the file city.py to add faith generation from religious buildings.

Grep for "def process" or "def update" or "def end_turn" in city.py to find the per-turn method. Read 30 lines around it. Then add this code at the end of that method, before the return:

        # Faith from religious buildings
        faith = sum(2 for b in self.buildings if hasattr(b, 'name') and b.name in ("Temple", "Shrine", "Cathedral", "Monastery"))
        if faith > 0 and hasattr(self.game, 'faith_points') and self.civ in self.game.faith_points:
            self.game.faith_points[self.civ] += faith

Use the Edit tool to make this change. Then git add city.py && git commit -m "feat: generate faith from religious buildings each turn".`
)

// ── 2: Faith in resource bar ──
await task('Faith in resource bar',
`Edit the file pygame_app/panels/resource_bar.py to display faith points.

Grep for "gold\|Gold\|science\|Science\|food\|Food" in pygame_app/panels/resource_bar.py to find where resources are rendered. Read 30 lines around the match. Then add faith display following the exact same pattern. Get faith with:

    faith = getattr(self.game, 'faith_points', {}).get(player_civ, 0)

Add a label "Faith: {faith}" rendered the same way as the other resource labels. Use the Edit tool. Then git add && git commit -m "feat: display faith in resource bar".`
)

// ── 3: Wire combat popup into game screen ──
await task('Wire combat into game_screen.py',
`Edit pygame_app/screens/game_screen.py to show CombatPopup when clicking an enemy unit.

Grep for "def.*click\|on_click\|handle.*click\|mouse.*button" in game_screen.py to find the click handler. Read 30 lines. Then:

1. Add import at top of file: from pygame_app.popups.combat_popup import CombatPopup
2. In the click handler, after detecting which tile was clicked, add logic to check if there's an enemy unit on that tile when a friendly unit is selected. If so, create CombatPopup.

Use Edit for both changes. Then git add && git commit -m "feat: wire combat popup into game screen click handler".`
)

// ── 4: Add gather_intel to game.py ──
await task('Add gather_intel to game.py',
`Edit game.py to add a gather_intel method to the Game class.

Grep for "class Game" in game.py. Then grep for the last method definition. Read 20 lines at the end of the class. Add this method:

    def gather_intel(self, spy_unit, target_city):
        """Gather intelligence on a foreign city."""
        return {
            "city": target_city.name,
            "production": [b.name for b in getattr(target_city, 'build_queue', [])],
            "garrison": len([u for u in self.military_manager.units
                           if u.civ == target_city.civ and u.position == target_city.position]),
        }

Use Edit to add it. Then git add game.py && git commit -m "feat: add gather_intel espionage action".`
)

// ── 5: Delete dead code ──
await task('Delete dead fix scripts',
`Run bash: ls fix_*.py gui_popups_backup.py gui_popups_original.py 2>/dev/null

If any files exist, delete them with bash: rm -f fix_*.py gui_popups_backup.py gui_popups_original.py

Then run: git add -A && git commit -m "chore: remove dead fix scripts and backup files"

If no files matched, just say "already clean".`, 120
)

// ── 6: Verify game starts ──
await task('Verify game starts',
`Run this bash command to verify the game still works:

python -c "from game import Game; g = Game('Player', ['Rome','Greece']); print(f'OK: {len(g.civilizations)} civs, faith={hasattr(g, \"faith_points\")}, victory={hasattr(g, \"victory_tracker\")}')"

Report the output.`, 120
)

// ── Summary ──
log('\n═══════════════════════════════════════')
log('═══ RESULTS ═══')
log('═══════════════════════════════════════\n')

for (const r of results) {
  log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.ok ? r.secs + 's' : 'TIMEOUT'}`)
}
log(`\n${results.filter(r => r.ok).length}/${results.length} completed`)

const writes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Write').length
const edits = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Edit').length
const contracts = allEvents.filter(e => e.type === 'tool.start' && (e.toolName as string ?? '').includes('Contract')).length
log(`Writes: ${writes}, Edits: ${edits}, Contracts: ${contracts}`)

const fs = require('fs'), os = require('os'), path = require('path')
try {
  const s5 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl'), 'utf-8').trim().split('\n').length
  const s1 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's1-decisions.jsonl'), 'utf-8').trim().split('\n').length
  log(`Training: S5=${s5}, S1=${s1}`)
} catch {}

try {
  const { execSync } = require('child_process')
  log(`\nCivKings commits:\n${execSync('git log --oneline -12', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
