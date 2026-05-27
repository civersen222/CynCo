#!/usr/bin/env bun
/**
 * CynCo CivKings Finish Sprint — ultra-specific prompts.
 * Each prompt tells the model EXACTLY what to do with minimal exploration.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CynCo CivKings Finish Sprint ═══')
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
    if (evt.type === 'tool.start') {
      const name = evt.toolName as string
      if (name === 'Edit' || name === 'Write' || name === 'Bash' || name === 'Git') {
        log(`  ★ ${name}`)
      } else {
        log(`  ${name}`)
      }
    }
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

async function task(name: string, prompt: string, sec = 240) {
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

// ── 1: Add faith_points to Game.__init__ ──
await task('Add faith_points dict',
`Edit the file game.py. Find the line that initializes gold (search for "gold" in the __init__ method). Right after that line, add this line:

        self.faith_points = {civ: 0 for civ in self.civilizations}

Use the Edit tool with old_string being the gold initialization line you find, and new_string being that same line plus the faith_points line after it. Then commit with message "feat: add faith_points tracking per civilization".`
)

// ── 2: Generate faith from temples ──
await task('Faith from temples in cities',
`Edit the file city.py. Find the method that processes production or yields each turn (search for "def process" or "def update" or "def produce"). In that method, after the existing yield calculations, add this code:

        # Faith generation from religious buildings
        faith = 0
        for building in self.buildings:
            if building.name in ("Temple", "Shrine", "Cathedral", "Monastery"):
                faith += 2
        if hasattr(self.game, 'faith_points') and self.civ in self.game.faith_points:
            self.game.faith_points[self.civ] += faith

Find the right spot by reading city.py first, then make the edit. Commit with message "feat: generate faith from religious buildings".`
)

// ── 3: Add faith to resource bar ──
await task('Faith in resource bar',
`Read pygame_app/panels/resource_bar.py. Find where it renders gold, science, or food values. Add faith in the same pattern. The faith value comes from:

    faith = getattr(self.game, 'faith_points', {}).get(player_civ, 0)

Display it with a label like "Faith: {faith}". Follow the exact same rendering pattern as the other resources. Commit with message "feat: display faith in resource bar".`
)

// ── 4: Create combat popup ──
await task('Create combat popup',
`Create a new file pygame_app/popups/combat_popup.py with this content:

import pygame
import pygame_gui

class CombatPopup:
    """Simple combat resolution popup."""

    def __init__(self, manager, attacker, defender, game):
        self.manager = manager
        self.attacker = attacker
        self.defender = defender
        self.game = game
        self.result = None

        # Create window
        self.window = pygame_gui.elements.UIWindow(
            rect=pygame.Rect(200, 150, 400, 300),
            manager=manager,
            window_display_title="Combat"
        )

        # Attacker info
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 10, 380, 30),
            text=f"Attacker: {attacker.name} (ATK:{attacker.attack} HP:{attacker.hp})",
            manager=manager, container=self.window
        )

        # Defender info
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 50, 380, 30),
            text=f"Defender: {defender.name} (DEF:{defender.defense} HP:{defender.hp})",
            manager=manager, container=self.window
        )

        # Fight button
        self.fight_btn = pygame_gui.elements.UIButton(
            relative_rect=pygame.Rect(100, 100, 200, 50),
            text="Fight!",
            manager=manager, container=self.window
        )

        self.result_label = None
        self.close_btn = None

    def handle_event(self, event):
        if event.type == pygame_gui.UI_BUTTON_PRESSED:
            if event.ui_element == self.fight_btn:
                self._resolve()
            elif self.close_btn and event.ui_element == self.close_btn:
                self.window.kill()
                return "closed"
        return None

    def _resolve(self):
        from combat import resolve_combat
        result = resolve_combat(self.attacker, self.defender, self.game)

        self.fight_btn.kill()

        outcome = "Victory!" if result.get("winner") == self.attacker else "Defeat!"
        self.result_label = pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 100, 380, 30),
            text=f"{outcome} Casualties: {result.get('attacker_losses', 0)} / {result.get('defender_losses', 0)}",
            manager=self.manager, container=self.window
        )

        self.close_btn = pygame_gui.elements.UIButton(
            relative_rect=pygame.Rect(100, 150, 200, 50),
            text="Close",
            manager=self.manager, container=self.window
        )

Write this file and commit with message "feat: add CombatPopup for interactive combat resolution".`, 120
)

// ── 5: Add gather_intel to game.py ──
await task('Add gather_intel method',
`Edit game.py. Find the last method in the Game class (search for the last "def " in the class). After it, add this method:

    def gather_intel(self, spy_unit, target_city):
        """Gather intelligence on a foreign city."""
        return {
            "city": target_city.name,
            "production": [b.name for b in getattr(target_city, 'build_queue', [])],
            "garrison": len([u for u in self.military_manager.units if u.civ == target_city.civ and u.position == target_city.position]),
        }

Commit with message "feat: add gather_intel espionage action".`
)

// ── 6: Wire victory checks ──
await task('Wire victory checks',
`Read game.py and search for "process_turn". Check if check_victory or victory_tracker is called anywhere in that method. If NOT, add at the end of process_turn:

        # Check victory conditions
        if hasattr(self, 'victory_tracker'):
            self.victory_tracker.check_victory()

Commit with message "feat: wire victory condition checks into turn processing".`
)

// ── 7: Delete dead fix scripts ──
await task('Delete fix scripts',
`Run these bash commands to delete dead code:

rm -f fix_*.py gui_popups_backup.py gui_popups_original.py 2>/dev/null
ls fix_*.py gui_popups_backup.py gui_popups_original.py 2>/dev/null || echo "All dead code deleted"
git add -A && git commit -m "chore: remove fix scripts and backup files"`, 60
)

// ── Summary ──
log('\n═══ Sprint Complete ═══')
const edits = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Edit' || e.toolName === 'Write')).length
const bashes = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Bash').length
log(`Edits/Writes: ${edits}, Bash: ${bashes}, Tasks: ${completes}`)

const fs = require('fs'), os = require('os'), path = require('path')
try {
  const s5 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl'), 'utf-8').trim().split('\n').length
  const s1 = fs.readFileSync(path.join(os.homedir(), '.cynco', 'training', 's1-decisions.jsonl'), 'utf-8').trim().split('\n').length
  log(`Training: S5=${s5}, S1=${s1}`)
} catch { log('Training journal not found') }

// Check CivKings commits
try {
  const { execSync } = require('child_process')
  const commits = execSync('git log --oneline -10', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })
  log(`\nCivKings recent commits:\n${commits}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
