// engine/daemon/main.ts
// CynCo liveness daemon: tiny always-on sentinel. No model is ever loaded here.
//
// Usage:
//   CYNCO_NTFY_URL=http://100.x.y.z:8090 CYNCO_NTFY_TOKEN=tk_... bun engine/daemon/main.ts
import { existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MissionLedger } from './missionLedger.js'
import { MissionRunner } from './missionRunner.js'
import { NtfyChannel } from './ntfyChannel.js'
import { TaskRunner } from './taskRunner.js'
import { defaultControlPath, readControl } from './control.js'
import { exec } from 'child_process'
import { buildMflExportUrl, loadMflApiKey } from '../tools/impl/mfl.js'
import { createHash } from 'crypto'
import { cyncoHome } from '../paths.js'

const TICK_MS = 30000

const missionsDir = process.env.CYNCO_MISSIONS_DIR ?? join(cyncoHome(), 'missions')
// The desk widget's pause switch (engine/daemon/control.ts). Read on every tick and every 5 s inside a run.
const controlPath = process.env.CYNCO_CONTROL_FILE ?? defaultControlPath(cyncoHome())
const isPaused = () => readControl(controlPath).paused

/** precheck 'command': the trigger's own gate, run in the mission workspace with a two-minute cap. */
function runPrecheck(command: string, cwd?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 120000, windowsHide: true, encoding: 'utf-8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })
}
const ntfyUrl = process.env.CYNCO_NTFY_URL
if (!ntfyUrl) {
  console.error('[daemon] CYNCO_NTFY_URL is required (e.g. http://<tailscale-ip>:8090)')
  process.exit(1)
}

process.on('unhandledRejection', (err) => {
  console.error('[daemon] unhandled rejection (continuing):', err)
})

const ntfy = new NtfyChannel({
  baseUrl: ntfyUrl,
  token: process.env.CYNCO_NTFY_TOKEN,
  alertTopic: process.env.CYNCO_NTFY_ALERT_TOPIC ?? 'cynco-alerts',
  commandTopic: process.env.CYNCO_NTFY_COMMAND_TOPIC ?? 'cynco-commands',
})

async function fetchMflSnapshot(leagueId: string, year: number): Promise<string> {
  const url = buildMflExportUrl({ query: 'transactions', league: leagueId, year, apiKey: loadMflApiKey() })
  const resp = await fetch(url, { headers: { 'User-Agent': 'CynCoMFL/1.0' }, signal: AbortSignal.timeout(30000) })
  if (!resp.ok) throw new Error(`MFL HTTP ${resp.status}`)
  return createHash('sha256').update(await resp.text()).digest('hex')
}

async function fetchRosterSnapshot(leagueId: string, year: number, franchiseId: string): Promise<string> {
  const url = buildMflExportUrl({
    query: 'rosters', league: leagueId, year, apiKey: loadMflApiKey(),
    extra: { FRANCHISE: franchiseId },
  })
  const resp = await fetch(url, { headers: { 'User-Agent': 'CynCoMFL/1.0' }, signal: AbortSignal.timeout(30000) })
  if (!resp.ok) throw new Error(`MFL HTTP ${resp.status}`)
  const text = await resp.text()
  // Keep the task file small — player ids are enough, the model can resolve
  // names via the Mfl tool when it needs them.
  return text.length > 4000 ? `${text.slice(0, 4000)}…(truncated)` : text
}

// Load all missions
mkdirSync(missionsDir, { recursive: true })
const runners: MissionRunner[] = []
for (const entry of readdirSync(missionsDir)) {
  const dir = join(missionsDir, entry)
  if (!existsSync(join(dir, 'mission.json'))) continue
  const ledger = MissionLedger.load(dir)
  const taskRunner = new TaskRunner({ workDir: join(dir, 'tasks'), shouldPause: isPaused })
  runners.push(new MissionRunner(ledger, {
    runTask: (input) => taskRunner.run(input),
    publish: (p) => ntfy.publish(p),
    publishRecommendation: (rec) => ntfy.publishRecommendation(rec),
    fetchMflSnapshot,
    fetchRosterSnapshot,
    now: () => new Date(),
    runPrecheck,
    isPaused,
  }))
  console.log(`[daemon] Loaded mission: ${ledger.config.id} (${ledger.config.triggers.length} triggers)`)
}

if (runners.length === 0) {
  console.log(`[daemon] No missions found in ${missionsDir} — create <mission-id>/mission.json. Idling.`)
}

// Phone commands: approvals → first mission that knows the recId;
// text commands (e.g. "lineup 5") → every mission runner.
const stopSubscription = ntfy.subscribe(async (cmd) => {
  try {
    if (cmd.kind === 'text') {
      for (const runner of runners) await runner.handleTextCommand(cmd.text)
      return
    }
    for (const runner of runners) {
      if (await runner.handleCommand(cmd)) return
    }
    console.log(`[daemon] Command for unknown recId: ${cmd.recId}`)
  } catch (err) {
    console.error('[daemon] command handling failed:', err)
  }
})

let ticking = false
const interval = setInterval(async () => {
  if (ticking) return // a long engine run is in progress — skip overlapping ticks
  ticking = true
  try {
    for (const runner of runners) await runner.tick()
  } catch (err) {
    console.error(`[daemon] Tick error: ${err instanceof Error ? err.message : err}`)
  } finally {
    ticking = false
  }
}, TICK_MS)

const shutdown = () => {
  console.log('[daemon] Shutting down')
  clearInterval(interval)
  stopSubscription()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`[daemon] CynCo liveness daemon up — ${runners.length} mission(s), tick every ${TICK_MS / 1000}s; pause switch ${controlPath}${isPaused() ? ' (PAUSED)' : ''}`)
