// engine/daemon/main.ts
// CynCo liveness daemon: tiny always-on sentinel. No model is ever loaded here.
//
// Usage:
//   CYNCO_NTFY_URL=http://100.x.y.z:8090 CYNCO_NTFY_TOKEN=tk_... bun engine/daemon/main.ts
import { existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MissionLedger } from './missionLedger.js'
import { MissionRunner } from './missionRunner.js'
import { NtfyChannel, ntfyOptionsFromEnv } from './ntfyChannel.js'
import { TaskRunner } from './taskRunner.js'
import { defaultControlPath, readControl } from './control.js'
import { runPrecheck } from './precheck.js'
import { auditRefusal } from '../audit/toolAudit.js'
import { buildMflExportUrl, loadMflApiKey } from '../tools/impl/mfl.js'
import { createHash } from 'crypto'
import { cyncoHome, guardDir, missionsDir as resolveMissionsDir, sandboxRoot } from '../paths.js'
import { checkModelsRecord, flushUnsentPages, haltRefusal, haltState, openBaselines, settleOrphans, settleRun, takeBaseline } from '../integrity.js'
import { engineCheckout, establishContainment, releaseContainment, sweepSandboxes } from '../containment.js'
import { giveGpuBack, takeGpuForOneShot } from '../apps/gpu.js'
import { freeOllamaForCynco } from '../apps/ollama.js'
import { activity } from '../power/activity.js'
import { wireHoldAwake } from '../power/awake.js'
import { WakePublisher } from './wakeSchedule.js'
import { runHousekeeping } from './housekeeping.js'

// Wakefulness (slice 3): while a one-shot runs, the PC may not sleep. The
// daemon itself holds nothing while idle, so Windows' own timer can sleep the
// box between triggers; the doorman wakes it ahead of the next one.
wireHoldAwake(activity, { log: (line) => console.log(`[daemon] ${line}`) })

const TICK_MS = 30000

const missionsDir = resolveMissionsDir()
// The desk widget's pause switch (engine/daemon/control.ts). Read on every tick and every 5 s inside a run.
const controlPath = process.env.CYNCO_CONTROL_FILE ?? defaultControlPath(cyncoHome())
const controlPaused = () => readControl(controlPath).paused
// F242: the integrity latch stops the daemon like a pause, but it is a separate file in the guard folder
// that neither the widget nor POST /api/daemon/pause can clear.
const latchWhy = (): string | null => haltRefusal()
// Only a latch that stands pauses the daemon. A guard folder that cannot be used is not a pause: each due run
// is then refused with the sentence and paged at normal priority, since no latch was written to page about it.
const latchStands = (): string | null => { const s = haltState(); return s.state === 'latched' ? s.summary : null }
const isPaused = () => controlPaused() || latchStands() !== null
const pauseReason = (): string | null => {
  const why = latchStands()
  return why ? `stopped by the integrity latch (${why})` : controlPaused() ? 'paused by the control file' : null
}

const ntfyOptions = ntfyOptionsFromEnv(process.env)
if (!ntfyOptions) {
  console.error('[daemon] CYNCO_NTFY_URL is required (e.g. http://<tailscale-ip>:8090)')
  process.exit(1)
}

process.on('unhandledRejection', (err) => {
  console.error('[daemon] unhandled rejection (continuing):', err)
})

const ntfy = new NtfyChannel(ntfyOptions)
// F242: the integrity layer's pager. Not queued in memory: a page that cannot be sent is kept in <guard>/unsent.
const pageOwner = (p: { title: string; message: string; priority: number }) => ntfy.publish(p, { queueOnFailure: false })

// The owner's local-LLM apps (engine/apps): what the daemon did with an app's model server is said in the log and
// on the phone, the same notification channel as a mission's results. A failed push is dropped, not queued.
const modelPort = parseInt(process.env.LOCALCODE_PORT ?? '8081', 10)
const sayApps = (message: string): void => {
  console.log(`[apps] ${message}`)
  void ntfy.publish({ title: 'CynCo and the GPU', message }, { queueOnFailure: false }).catch((e) => console.log(`[apps] not sent to the phone: ${e instanceof Error ? e.message : String(e)}`))
}
// A daemon that died owing an app its server: give it back now, if the GPU is free.
void giveGpuBack(sayApps)

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
// F242: remove sandboxes older than a week and give back the label of any run whose holder is gone
// (a daemon stopped mid-task leaves its mission folder labelled).
sweepSandboxes({ log: (line) => console.log(`[daemon] ${line}`) })
/** Why an unattended run may not start now, as `<layer>: <reason>`, or null. Asked before the GPU is taken. */
const refuseRun = (): string | null => {
  // F242 (ruling 3.13): the integrity latch, then the models record, then the audit, then the sandbox root.
  const latch = latchWhy()
  if (latch) return `integrity: ${latch}`
  const models = checkModelsRecord()
  if (models) return `integrity: ${models}`
  // F242: a run whose tool calls cannot be recorded does not start. A probe record is written and
  // fsynced each time this is asked, so "fine" is a measurement made now.
  const audit = auditRefusal({ by: 'task-runner' })
  if (audit) return `audit: ${audit}`
  return existsSync(sandboxRoot())
    ? null
    : `containment: the sandbox root ${sandboxRoot()} is not an existing folder; create it once with scripts/cynco-containment-setup.ps1`
}
const runners: MissionRunner[] = []
for (const entry of readdirSync(missionsDir)) {
  const dir = join(missionsDir, entry)
  if (!existsSync(join(dir, 'mission.json'))) continue
  const ledger = MissionLedger.load(dir)
  const taskRunner = new TaskRunner({
    workDir: join(dir, 'tasks'), shouldPause: controlPaused,
    // F242: the latch kills a running one-shot within the poll and does not park it.
    halted: latchWhy,
    // F242: the integrity baseline before the sandbox is made, the settling compare after the child tree is dead.
    // The daemon names itself the baseline's holder, with the task's own time limit and half an hour more:
    // a daemon killed mid-task leaves an orphan that the next daemon (or any starter) finds (review of wave 5).
    integrity: {
      before: (runId, cwd, timeoutMs) => { takeBaseline({ runId, cwd, by: 'daemon', holderPid: process.pid, maxRunMs: timeoutMs + 1_800_000 }) },
      after: async (runId, notConfirmedDead) => {
        const c = await settleRun(runId, { by: 'daemon', page: pageOwner, ...(notConfirmedDead !== undefined ? { notConfirmedDead } : {}) })
        return c.changed || notConfirmedDead !== undefined ? c.publicSummary : null
      },
    },
    // The owner's local-LLM apps (engine/apps): a one-shot takes the model port from an app's server by the rule
    // the chat engine uses, and the app gets its server back after the run.
    // Then Ollama: a model it holds for one of the owner's apps would read as a busy GPU and defer the run.
    takeGpu: (why) => takeGpuForOneShot({ port: modelPort, by: `the one-shot ${why}`, say: sayApps })
      .then(() => freeOllamaForCynco({ by: `the one-shot ${why}`, say: sayApps })).then(() => {}),
    giveGpuBack: () => giveGpuBack(sayApps),
    // F242: a one-shot is a contained run. No sandbox root, no run; the task runner makes the run's
    // sandbox after the busy check, the child engine adopts it, and it is released however the child ended.
    refuse: refuseRun,
    contain: (input, runId) => input.cwd
      ? establishContainment({ kind: 'daemon-task', runId, missionCwd: input.cwd })
      : { ok: false, reason: `this task names no cwd, so it would work in the engine's own checkout ${engineCheckout()}; give the mission a cwd` },
    release: (c) => releaseContainment(c),
  })
  runners.push(new MissionRunner(ledger, {
    runTask: (input) => taskRunner.run(input),
    publish: (p) => ntfy.publish(p),
    publishRecommendation: (rec) => ntfy.publishRecommendation(rec),
    fetchMflSnapshot,
    fetchRosterSnapshot,
    now: () => new Date(),
    runPrecheck,
    isPaused,
    pauseReason,
    refuse: refuseRun,
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

// Wakefulness (slice 3): after each tick round, tell the doorman when the next
// triggers are due so it can wake this PC 3 min ahead. Unset = nothing sent.
const wakePublisher = new WakePublisher({
  url: process.env.CYNCO_DOORMAN_URL,
  target: process.env.CYNCO_DOORMAN_TARGET ?? 'main',
  log: (line) => console.log(line),
})
if (!process.env.CYNCO_DOORMAN_URL) console.log('[daemon] CYNCO_DOORMAN_URL unset — no wake schedule is published; the PC must stay awake for triggers')

let ticking = false
const interval = setInterval(async () => {
  if (ticking) return // a long engine run is in progress — skip overlapping ticks
  ticking = true
  try {
    // F242: a baseline whose starter died before its compare (a daemon or dispatch killed, a restart) is
    // compared here; one not confirmed dead latches. Nothing is done while a latch stands.
    const orphans = await settleOrphans({ by: 'daemon (a run that was never compared)', page: pageOwner })
    for (const c of orphans) console.log(`[daemon] run ${c.run} was never compared; compared now: ${c.publicSummary}`)
    // F242: a page the integrity layer could not send (a mission engine has no ntfy settings) goes out from here.
    await flushUnsentPages(guardDir(), pageOwner).catch((e) => console.error(`[daemon] unsent pages not flushed: ${e instanceof Error ? e.message : e}`))
    for (const runner of runners) await runner.tick()
    // Only switched-on passes wake the PC (schedule.json can turn one off).
    const enabledIds = new Set(runners.flatMap((r) => r.effectiveTriggers().filter((t) => t.enabled).map((t) => t.id)))
    await wakePublisher.publishIfChanged(runners.map((r) => r.ledger), enabledIds)
  } catch (err) {
    console.error(`[daemon] Tick error: ${err instanceof Error ? err.message : err}`)
  } finally {
    ticking = false
  }
}, TICK_MS)

// Hourly: one page a day for a service log over 1 GiB. A `>>` log is rotated only when its
// service starts (scripts/rotate-log.cmd), so this is what bounds one between restarts (F242).
// Read-only: it lists the *.log files directly in the CynCo home and changes nothing on disk.
const lastLogPage = new Map<string, number>()
const housekeep = (): void => {
  void runHousekeeping({
    logsDir: cyncoHome(), now: () => Date.now(), lastPaged: lastLogPage,
    publish: (p) => ntfy.publish(p, { queueOnFailure: false }),
  }).catch((e) => console.error(`[daemon] housekeeping failed: ${e instanceof Error ? e.message : String(e)}`))
}
housekeep()
const housekeeping = setInterval(housekeep, 3_600_000)

const shutdown = () => {
  console.log('[daemon] Shutting down')
  clearInterval(interval)
  clearInterval(housekeeping)
  stopSubscription()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`[daemon] CynCo liveness daemon up — ${runners.length} mission(s), tick every ${TICK_MS / 1000}s; pause switch ${controlPath}${pauseReason() ? ` (${pauseReason()})` : ''}`)
try {
  const open = openBaselines()
  if (open.length > 0) {
    const first = open[0]!
    console.log(`[daemon] ${open.length} integrity baseline(s) still open from an earlier run (${first.runId}, ${Math.round(first.ageMs / 60000)} min old): settle with bun scripts/cynco-guard.mjs post ${first.runId}`)
  }
} catch (e) {
  console.error(`[daemon] ${e instanceof Error ? e.message : String(e)}`)
}
