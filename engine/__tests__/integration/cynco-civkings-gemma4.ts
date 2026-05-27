#!/usr/bin/env bun
/**
 * CivKings sprint with gemma4:31b — 3 quick tasks to see if it edits.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Sprint — gemma4:31b ═══')
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
      if (['Edit', 'Write', 'Bash', 'Git'].includes(name)) log(`  ★ ${name}`)
      else log(`  ${name}`)
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

// ── Quick test: does gemma4 edit at all? ──
await task('Simple file edit test',
`Edit the file game.py. Add this comment as the very first line of the file:

# CivKings — A Civilization + Crusader Kings strategy game

Use the Edit tool. The old_string should be whatever the current first line is (read the file first to see it). The new_string should be the comment followed by the original first line. Then commit with message "docs: add file header comment to game.py".`
)

// ── If that worked, try faith_points ──
await task('Add faith_points',
`Edit game.py. Search for where self.gold or gold is initialized in the Game class __init__ method. Add this line right after it:

        self.faith_points = {civ: 0 for civ in self.civilizations}

Use the Edit tool — old_string is the gold line, new_string is the gold line plus the faith_points line. Commit with message "feat: add faith_points tracking".`
)

// ── Write a new file ──
await task('Create combat popup',
`Write a new file at pygame_app/popups/combat_popup.py with this exact content:

"""Combat resolution popup."""
import pygame
import pygame_gui


class CombatPopup:
    def __init__(self, manager, attacker, defender, game):
        self.manager = manager
        self.attacker = attacker
        self.defender = defender
        self.game = game
        self.window = pygame_gui.elements.UIWindow(
            rect=pygame.Rect(200, 150, 400, 300),
            manager=manager,
            window_display_title="Combat"
        )
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 10, 380, 30),
            text=f"ATK: {attacker.name} ({attacker.attack}/{attacker.hp}hp)",
            manager=manager, container=self.window
        )
        pygame_gui.elements.UILabel(
            relative_rect=pygame.Rect(10, 50, 380, 30),
            text=f"DEF: {defender.name} ({defender.defense}/{defender.hp}hp)",
            manager=manager, container=self.window
        )
        self.fight_btn = pygame_gui.elements.UIButton(
            relative_rect=pygame.Rect(100, 100, 200, 50),
            text="Fight!", manager=manager, container=self.window
        )

Use the Write tool to create this file. Then commit with message "feat: add combat popup".`, 120
)

log('\n═══ Results ═══')
const edits = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Edit' || e.toolName === 'Write')).length
const reads = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Read').length
log(`Edits/Writes: ${edits}, Reads: ${reads}, Completed: ${completes}/3`)

const fs = require('fs'), os = require('os'), path = require('path')
try {
  const { execSync } = require('child_process')
  const commits = execSync('git log --oneline -5', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })
  log(`\nCivKings commits:\n${commits}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
log('Done.')
