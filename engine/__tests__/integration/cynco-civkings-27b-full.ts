#!/usr/bin/env bun
/**
 * CivKings full sprint with Qwen3.6-27B dense (27B active params).
 * 10-minute timeouts per task to account for slower throughput.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Full Sprint — Qwen3.6-27B Dense ═══')
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
      if (['Edit', 'Write', 'Bash', 'Git'].includes(name)) log(`  ★ ${name}`)
      else if (['Grep', 'CodeIndex'].includes(name)) log(`  🔍 ${name}`)
      else if (name === 'Read') log(`  📖 Read`)
      else log(`  ${name}`)
    }
    else if (evt.type === 'tool.complete' && evt.isError) log(`  ✗ FAIL: ${name}`)
    else if (evt.type === 'approval.request') {
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') {
      completes++
      const secs = Math.round((Date.now() - taskStart) / 1000)
      log(`  ── done (${secs}s) ──`)
    }
  } catch {}
}

await sleep(3000)
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)
completes = 0

const taskResults: { name: string; completed: boolean; seconds: number }[] = []

async function task(name: string, prompt: string, sec = 600) {
  log(`\n═══ ${name} ═══`)
  const pre = completes
  taskStart = Date.now()
  ws.send(JSON.stringify({ type: 'user.message', text: prompt }))
  for (let i = 0; i < sec; i++) {
    if (completes > pre) {
      const elapsed = Math.round((Date.now() - taskStart) / 1000)
      taskResults.push({ name, completed: true, seconds: elapsed })
      return true
    }
    await sleep(1000)
  }
  log('  TIMEOUT')
  taskResults.push({ name, completed: false, seconds: sec })
  return false
}

// ── 1: Faith points (may already exist from earlier sprint) ──
await task('Add faith_points to Game',
`In game.py, grep for "gold" to find where gold is tracked in the Game.__init__ method. Read those 20 lines. If faith_points is NOT already there, add this line right after the gold initialization:

        self.faith_points = {civ: 0 for civ in self.civilizations}

If it already exists, just say "already done". Then commit with "feat: add faith_points tracking".`
)

// ── 2: Faith generation from temples ──
await task('Faith from temples',
`In city.py, grep for "def process" or "def update" to find the method that runs each turn. Read 30 lines around it. Add faith generation from religious buildings — after existing yield calculations, add:

        faith = sum(2 for b in self.buildings if hasattr(b, 'name') and b.name in ("Temple", "Shrine", "Cathedral", "Monastery"))
        if faith > 0 and hasattr(self.game, 'faith_points') and self.civ in self.game.faith_points:
            self.game.faith_points[self.civ] += faith

Commit with "feat: generate faith from religious buildings".`
)

// ── 3: Faith in resource bar ──
await task('Faith in resource bar',
`In pygame_app/panels/resource_bar.py, grep for "gold\|Gold\|science\|Science" to find where resources are displayed. Read 30 lines around the match. Add faith display following the same pattern as gold. Get the value with:

    faith = getattr(self.game, 'faith_points', {}).get(player_civ, 0)

Display "Faith: {faith}" with the same styling as the other resources. Commit with "feat: display faith in resource bar".`
)

// ── 4: Create combat popup ──
await task('Create combat popup',
`Write a new file pygame_app/popups/combat_popup.py with this content:

"""Combat resolution popup for CivKings."""
import pygame
import pygame_gui


class CombatPopup:
    """Shows attacker vs defender stats and resolves combat."""

    def __init__(self, manager, attacker, defender, game):
        self.manager = manager
        self.attacker = attacker
        self.defender = defender
        self.game = game
        self.resolved = False

        self.window = pygame_gui.elements.UIWindow(
            rect=pygame.Rect(250, 150, 400, 280),
            manager=manager,
            window_display_title="Combat"
        )

        atk_text = f"Attacker: {attacker.name} (ATK:{attacker.attack} DEF:{attacker.defense} HP:{attacker.hp})"
        def_text = f"Defender: {defender.name} (ATK:{defender.attack} DEF:{defender.defense} HP:{defender.hp})"

        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 10, 380, 30),
            text=atk_text, manager=manager, container=self.window
        )
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 50, 380, 30),
            text=def_text, manager=manager, container=self.window
        )

        self.fight_btn = pygame_gui.elements.UIButton(
            relative_rect=pygame.Rect(100, 100, 200, 50),
            text="Fight!", manager=manager, container=self.window
        )

    def handle_event(self, event):
        if event.type == pygame_gui.UI_BUTTON_PRESSED and event.ui_element == self.fight_btn:
            self._resolve_combat()
        return self.resolved

    def _resolve_combat(self):
        from combat import resolve_combat
        result = resolve_combat(self.attacker, self.defender, self.game)
        self.fight_btn.kill()
        outcome = "Victory!" if result.get("winner") == self.attacker.civ else "Defeat!"
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 110, 380, 30),
            text=outcome, manager=self.manager, container=self.window
        )
        self.resolved = True

Then commit with "feat: add CombatPopup for interactive combat".`
)

// ── 5: Wire combat into game screen ──
await task('Wire combat into game screen',
`In pygame_app/screens/game_screen.py, grep for "def.*click\|def.*select\|on_tile" to find the click handler. Read 30 lines. When a tile with an enemy unit is clicked while a friendly unit is selected, it should create a CombatPopup.

Add at the top: from pygame_app.popups.combat_popup import CombatPopup

In the click handler, add logic: if selected_unit and clicked tile has enemy unit, create CombatPopup(self.ui_manager, selected_unit, enemy_unit, self.game). Commit with "feat: wire combat popup into game screen".`
)

// ── 6: Espionage gather_intel ──
await task('Add gather_intel',
`In game.py, grep for "class Game" to find the class, then grep for the last "def " method. Read those lines. Add this method at the end of the Game class:

    def gather_intel(self, spy_unit, target_city):
        """Gather intelligence on a foreign city."""
        return {
            "city": target_city.name,
            "production": [b.name for b in getattr(target_city, 'build_queue', [])],
            "garrison": len([u for u in self.military_manager.units
                           if u.civ == target_city.civ and u.position == target_city.position]),
        }

Commit with "feat: add gather_intel espionage action".`
)

// ── 7: Wire victory checks ──
await task('Wire victory checks',
`Grep for "process_turn" in game.py. Read 40 lines of that method. Check if victory_tracker.check_victory() is called. If NOT, add at the end of process_turn:

        if hasattr(self, 'victory_tracker'):
            result = self.victory_tracker.check_victory()
            if result:
                self.game_over = True
                self.winner = result

Commit with "feat: wire victory condition checks into turn processing".`
)

// ── 8: Delete dead code ──
await task('Delete dead code',
`Run this bash command: ls -la fix_*.py gui_popups_backup.py gui_popups_original.py 2>/dev/null

If any files exist, delete them with rm. Then run: git add -A && git commit -m "chore: remove dead fix scripts and backup files"

If no files exist, just say "already clean".`, 120
)

// ── 9: Religion popup ──
await task('Create religion popup',
`Write a new file pygame_app/popups/religion_popup.py:

"""Religion overview popup."""
import pygame
import pygame_gui


class ReligionPopup:
    """Shows founded religions and faith points."""

    def __init__(self, manager, game, player_civ):
        self.manager = manager
        self.window = pygame_gui.elements.UIWindow(
            rect=pygame.Rect(200, 100, 500, 400),
            manager=manager,
            window_display_title="Religion"
        )

        y = 10
        faith = getattr(game, 'faith_points', {}).get(player_civ, 0)
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, y, 480, 30),
            text=f"Your Faith: {faith}",
            manager=manager, container=self.window
        )
        y += 40

        if hasattr(game, 'religions'):
            for name, religion in game.religions.items():
                pygame_gui.elements.UILabel(
                    relative_rect=pygame.Rect(10, y, 480, 25),
                    text=f"{name} (Founded by: {religion.founder}) — Followers: {len(religion.followers)}",
                    manager=manager, container=self.window
                )
                y += 30
        else:
            pygame_gui.elements.UILabel(
                relative_rect=pygame.Rect(10, y, 480, 25),
                text="No religions founded yet.",
                manager=manager, container=self.window
            )

Commit with "feat: add ReligionPopup".`
)

// ── 10: Verify game starts ──
await task('Verify game starts',
`Run: python -c "from game import Game; g = Game('Player', ['Rome','Greece']); print(f'OK: {len(g.civilizations)} civs, faith={hasattr(g, \"faith_points\")}')"

Report the output.`, 120
)

// ── Summary ──
log('\n═══════════════════════════════════════')
log('═══ SPRINT COMPLETE ═══')
log('═══════════════════════════════════════\n')

for (const r of taskResults) {
  log(`  ${r.completed ? '✓' : '✗'} ${r.name}: ${r.completed ? r.seconds + 's' : 'TIMEOUT'}`)
}

const passed = taskResults.filter(r => r.completed).length
const total = taskResults.length
log(`\n${passed}/${total} tasks completed`)

const edits = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Edit' || e.toolName === 'Write')).length
const greps = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Grep' || e.toolName === 'CodeIndex')).length
const reads = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Read').length
const bashes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Bash').length
log(`Tools: ${greps} searches, ${reads} reads, ${edits} edits/writes, ${bashes} bash`)

const fs = require('fs'), os = require('os'), path = require('path')
try {
  const s5 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl'), 'utf-8').trim().split('\n').length
  const s1 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's1-decisions.jsonl'), 'utf-8').trim().split('\n').length
  log(`Training data: S5=${s5}, S1=${s1}`)
} catch { log('Training journal not found') }

try {
  const { execSync } = require('child_process')
  log(`\nCivKings commits:\n${execSync('git log --oneline -15', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(3000)
ws.close()
log('Done.')
