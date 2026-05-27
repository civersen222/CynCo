#!/usr/bin/env bun
/**
 * CivKings sprint — testing search-first workflow.
 * 2 tasks, tracking whether the model searches before reading.
 */

const WS_URL = `ws://localhost:${process.env.LOCALCODE_WS_PORT ?? '9160'}`
type Event = { type: string; [key: string]: unknown }
const allEvents: Event[] = []
let completes = 0, taskStart = 0
let grepCount = 0, readCount = 0, editCount = 0, writeCount = 0, bashCount = 0

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

log('═══ CivKings Search-First Test ═══')
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
      if (name === 'Grep' || name === 'CodeIndex') { grepCount++; log(`  🔍 ${name}`) }
      else if (name === 'Read') { readCount++; log(`  📖 Read`) }
      else if (name === 'Edit') { editCount++; log(`  ★ Edit`) }
      else if (name === 'Write') { writeCount++; log(`  ★ Write`) }
      else if (name === 'Bash') { bashCount++; log(`  ★ Bash`) }
      else log(`  ${name}`)
    }
    else if (evt.type === 'tool.complete' && evt.isError) log(`  ✗ FAIL: ${name}`)
    else if (evt.type === 'approval.request') {
      ws.send(JSON.stringify({ type: 'approval.response', requestId: evt.requestId, approved: true }))
    }
    else if (evt.type === 'message.complete') {
      completes++
      log(`  ── done (${Math.round((Date.now() - taskStart) / 1000)}s) | grep:${grepCount} read:${readCount} edit:${editCount} write:${writeCount} bash:${bashCount} ──`)
    }
  } catch {}
}

await sleep(3000)
ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
await sleep(1000)
completes = 0

async function task(name: string, prompt: string, sec = 240) {
  log(`\n═══ ${name} ═══`)
  grepCount = 0; readCount = 0; editCount = 0; writeCount = 0; bashCount = 0
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

// ── Task 1: Add faith_points — requires grep + targeted read + edit ──
await task('Add faith_points to game.py',
`Add faith tracking to the game. Use Grep to find where gold is initialized in game.py. Then read just those lines. Then edit to add faith_points right after the gold line. Then commit.

Specifically: grep for "gold" in game.py, read the 10 lines around the match, then use Edit to add:
        self.faith_points = {civ: 0 for civ in self.civilizations}
right after the gold initialization line.`
)

// ── Task 2: Write combat popup — simple file creation ──
await task('Create combat popup file',
`Create a new file pygame_app/popups/combat_popup.py. Use the Write tool to create it with this content:

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
            manager=manager, window_display_title="Combat"
        )

Then commit with message "feat: add combat popup".`, 120
)

log('\n═══ Summary ═══')
const totalGreps = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Grep' || e.toolName === 'CodeIndex')).length
const totalReads = allEvents.filter(e => e.type === 'tool.start' && e.toolName === 'Read').length
const totalEdits = allEvents.filter(e => e.type === 'tool.start' && (e.toolName === 'Edit' || e.toolName === 'Write')).length
log(`Search calls: ${totalGreps}, Reads: ${totalReads}, Edits/Writes: ${totalEdits}`)
log(`Completed: ${completes}/2`)
log(`Search-first ratio: ${totalGreps > 0 ? 'YES' : 'NO'} (${totalGreps} searches before ${totalReads} reads)`)

try {
  const { execSync } = require('child_process')
  log(`\n${execSync('git log --oneline -3', { cwd: 'C:\\Users\\civer\\civkings', encoding: 'utf-8' })}`)
} catch {}

ws.send(JSON.stringify({ type: 'session.end' }))
await sleep(2000)
ws.close()
