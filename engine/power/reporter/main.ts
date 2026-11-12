/**
 * engine/power/reporter/main.ts — this box tells the watcher what it is doing.
 *
 *   bun engine/power/reporter/main.ts [--box main] [--once]
 *
 * The main PC's part of the metasystem's first slice
 * (docs/decisions/2026-11-11-metasystem-design.md): a small process of its own,
 * not part of the engine, started at logon as the task "CynCo box reporter"
 * (`scripts/run-box-reporter.cmd`, `scripts/cynco-services.ps1` row `watch`).
 * It looks at the box every `lookMs`, pushes a sample when something worth
 * telling changed or `sampleMs` has passed, and pushes events (sleep and wake
 * from the System log, scheduled-job runs, the engine's own log lines) with
 * the time they happened. It listens on nothing and changes nothing: no
 * process is stopped or started, no file outside `<cyncoHome>/watch/` is
 * written.
 *
 * Switched on by `LOCALCODE_WATCHER_URL` (the watcher's address on the
 * doorman, `http://100.110.117.10:9171`). Unset: it says so and exits 0.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cyncoHome, missionsDir } from '../../paths.js'
import { ollamaLoaded } from '../../apps/ollama.js'
import { loadRegistry } from '../../apps/registry.js'
import { daemonHasWork, holderReader, readDaemonUp, readEngine, readInferenceToken, readModelPort, readServices, type FetchLike } from './engineFacts.js'
import { readGpus } from './gpu.js'
import { readIdleSeconds } from './idle.js'
import { JobTails } from './jobs.js'
import { FileTail, logLineEvents } from './logTail.js'
import { Outbox } from './outbox.js'
import { powerEventsFromRows, readSystemLog, type SystemLogRow } from './powerEvents.js'
import { fingerprint, gatherSample, type Sources } from './sample.js'
import type { WatchEvent, WatchRecord } from './types.js'

export const LOOK_MS = 15_000
export const SAMPLE_MS = 60_000
/** The System log is read at the first look, after a gap in our own looks, and this often regardless. */
export const POWER_EVERY_MS = 10 * 60_000
/** A look this much later than it was due means the box was suspended (or badly stalled): read the System log now. */
export const GAP_MS = 90_000
/** How far back the first read of the System log goes. */
export const FIRST_POWER_LOOKBACK_MS = 3 * 24 * 60 * 60_000
/** Re-read this much before the newest row seen: the wake's own row is written a moment after the wake. */
const POWER_OVERLAP_MS = 2 * 60_000
/** Backlog batches sent in one look. */
const MAX_FLUSHES_PER_LOOK = 10

/** The watcher's address, or undefined when the reporter is switched off. */
export function watcherUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (env.LOCALCODE_WATCHER_URL ?? '').trim()
  return v === '' ? undefined : v
}

export type ReporterState = { powerSince?: string; engineLogOffset?: number; jobs?: Record<string, number> }

export type ReporterDeps = {
  sources: Sources
  outbox: Pick<Outbox, 'add' | 'flush' | 'size'>
  readPower: (sinceIso: string) => Promise<SystemLogRow[] | null>
  /** New lines of the engine's log since the last look. */
  engineLog: () => string[]
  /** New scheduled-job runs since the last look. */
  jobs: () => WatchEvent[]
  state: ReporterState
  saveState: (s: ReporterState) => void
  modelPort: number
  now?: () => Date
  log?: (line: string) => void
  lookMs?: number
  sampleMs?: number
}

/** The loop's body, with the timer left to the caller: `tick()` is one look. */
export function createReporter(deps: ReporterDeps): { tick: () => Promise<void> } {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? console.log
  const lookMs = deps.lookMs ?? LOOK_MS
  const sampleMs = deps.sampleMs ?? SAMPLE_MS
  const told = new Set<string>() // event keys already handed to the outbox by this process
  let lastTickAt: number | null = null
  let lastPowerAt: number | null = null
  let lastSampleAt = 0
  let lastPrint = ''

  const tell = (events: WatchEvent[]): void => {
    const fresh = events.filter(e => !told.has(`${e.kind}|${e.key}`))
    if (told.size > 5000) told.clear() // the watcher stores nothing twice; this set only saves traffic
    for (const e of fresh) told.add(`${e.kind}|${e.key}`)
    deps.outbox.add(fresh)
  }

  const readPower = async (at: number): Promise<void> => {
    // Fixed at the first try, so a read that fails is asked again for the same window.
    const since = deps.state.powerSince ??= new Date(at - FIRST_POWER_LOOKBACK_MS).toISOString()
    const rows = await deps.readPower(since)
    if (rows === null) return // could not be read: the same window is asked again next time
    lastPowerAt = at
    tell(powerEventsFromRows(rows))
    const newest = Math.max(...rows.map(r => Date.parse(r.at)).filter(Number.isFinite), Date.parse(since))
    deps.state.powerSince = new Date(Math.max(Date.parse(since), newest - POWER_OVERLAP_MS)).toISOString()
  }

  return {
    tick: async () => {
      const at = now()
      const t = at.getTime()
      const first = lastTickAt === null
      const gap = lastTickAt !== null && t - lastTickAt > lookMs + GAP_MS
      if (first) tell([{ t: 'event', at: at.toISOString(), kind: 'reporter.start', key: `start:${at.toISOString()}`, data: { pid: process.pid, protocol: 1 } }])
      if (gap) log(`[watch] ${Math.round((t - lastTickAt!) / 1000)} s since the last look: the box was asleep or stalled; reading the System log`)
      lastTickAt = t
      if (first || gap || lastPowerAt === null || t - lastPowerAt >= POWER_EVERY_MS) await readPower(t)

      try { tell(logLineEvents(deps.engineLog(), at)) } catch (err) { log(`[watch] the engine log could not be read: ${err instanceof Error ? err.message : String(err)}`) }
      try { tell(deps.jobs()) } catch (err) { log(`[watch] the job runs could not be read: ${err instanceof Error ? err.message : String(err)}`) }

      const sample = await gatherSample(deps.sources, at, { modelPort: deps.modelPort, log })
      const print = fingerprint(sample)
      if (print !== lastPrint || t - lastSampleAt >= sampleMs) {
        deps.outbox.add([sample as WatchRecord])
        lastPrint = print
        lastSampleAt = t
      }

      for (let i = 0; i < MAX_FLUSHES_PER_LOOK; i++) {
        if ((await deps.outbox.flush()) !== 'sent' || deps.outbox.size() === 0) break
      }
      deps.saveState(deps.state)
    },
  }
}

/** A source whose answer is kept for `ttlMs`: nvidia-smi and the process list are not asked every 15 s. */
export function cached<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: T } | null = null
  return async () => {
    if (last && now() - last.at < ttlMs) return last.value
    const value = await fn()
    last = { at: now(), value }
    return value
  }
}

function loadState(file: string): ReporterState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf-8')) as ReporterState
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {} // no file yet, or a torn one: start from the end of each log and three days of the System log
  }
}

function stateSaver(file: string, log: (line: string) => void): (s: ReporterState) => void {
  let written = ''
  return s => {
    const text = JSON.stringify(s)
    if (text === written) return
    try {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, text, 'utf-8')
      renameSync(tmp, file)
      written = text
    } catch (err) {
      log(`[watch] the reporter's state could not be written to ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The real sources of this box. */
export function liveSources(env: NodeJS.ProcessEnv, modelPort: number): Sources {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init)
  const bridgePort = parseInt(env.LOCALCODE_WS_PORT ?? '9160', 10)
  const dashboardUrl = `http://127.0.0.1:${(Number.isFinite(bridgePort) ? bridgePort : 9160) + 1}`
  const embedUrl = env.LOCALCODE_EMBED_BASE_URL ?? 'http://127.0.0.1:9165'
  const daemonUp = cached(() => readDaemonUp(), 55_000)
  const holder = holderReader(modelPort)
  return {
    idleS: readIdleSeconds,
    gpus: cached(() => readGpus(), 55_000),
    // The token is read each time: an engine that started after us may have minted the file.
    engine: () => readEngine(fetchImpl, dashboardUrl, readInferenceToken(), Date.now()),
    modelPort: () => readModelPort(fetchImpl, modelPort),
    holder,
    services: engine => readServices(engine, { fetchImpl, embedUrl, daemonUp, daemonHasWork: () => daemonHasWork() }),
    // Ollama not running is nothing loaded, and is not worth a log line a minute.
    ollama: cached(async () => (await ollamaLoaded(loadRegistry(undefined, () => {}).ollama.url)).map(m => ({ server: 'ollama', name: m.name, busy: null })), 55_000),
  }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): Promise<number> {
  const url = watcherUrl(env)
  if (!url) {
    log('[watch] off: LOCALCODE_WATCHER_URL is not set, so nothing is gathered and nothing is sent')
    return 0
  }
  const boxAt = argv.indexOf('--box')
  const box = boxAt >= 0 && argv[boxAt + 1] ? argv[boxAt + 1]! : 'main'
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(box)) { log(`[watch] not a box name: ${box}`); return 2 }
  const dir = join(cyncoHome(), 'watch')
  mkdirSync(dir, { recursive: true })
  const stateFile = join(dir, 'state.json')
  const state = loadState(stateFile)
  const saveState = stateSaver(stateFile, log)
  const modelPort = parseInt(env.LOCALCODE_PORT ?? '8081', 10)
  const engineLogFile = join(cyncoHome(), 'engine-headless.log')
  const engineTail = new FileTail(engineLogFile, state.engineLogOffset ?? null)
  const jobTails = new JobTails(missionsDir(), state.jobs ?? {})
  const reporter = createReporter({
    sources: liveSources(env, Number.isFinite(modelPort) ? modelPort : 8081),
    outbox: new Outbox({ url, box, file: join(dir, 'outbox.jsonl'), log }),
    readPower: since => readSystemLog(since, undefined, log),
    engineLog: () => { const lines = engineTail.read(); if (engineTail.offset !== null) state.engineLogOffset = engineTail.offset; return lines },
    jobs: () => { const events = jobTails.read(); state.jobs = jobTails.positions(); return events },
    state,
    saveState,
    modelPort: Number.isFinite(modelPort) ? modelPort : 8081,
    log,
  })
  log(`[watch] reporting this box as "${box}" to ${url} every ${SAMPLE_MS / 1000} s and on change (looking every ${LOOK_MS / 1000} s); engine log ${existsSync(engineLogFile) ? engineLogFile : `${engineLogFile} (not there yet)`}`)
  let busy = false
  const look = async (): Promise<void> => {
    if (busy) return // a slow look (a hung PowerShell) must not stack up behind itself
    busy = true
    try { await reporter.tick() } catch (err) { log(`[watch] a look failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`) } finally { busy = false }
  }
  await look()
  if (argv.includes('--once')) return 0 // one look, sent, and out: for trying it by hand
  setInterval(() => { void look() }, LOOK_MS)
  return await new Promise<number>(() => {}) // runs until the task is stopped
}

if (import.meta.main) {
  main().then(code => { if (code !== 0) process.exit(code) }, err => { console.error(err); process.exit(1) })
}
