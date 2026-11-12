/**
 * engine/power/reporter/engineFacts.ts — what this box's CynCo parts are doing, read from outside them.
 *
 * The reporter is its own process, so everything here is a look at something
 * that already exists: the engine's `/api/session` on loopback (model state,
 * whether a turn is running, and the open activities of
 * `engine/power/activity.ts`), the model port itself (`/health`, `/props`,
 * `/slots`), the embedding service's `/health`, the daemon in the process
 * list, `gpu-busy.json`, and whose server holds the model port.
 *
 * Nothing here changes anything. In particular the port holder is read with
 * `readPortTree` + `classifyPortOwner` + `matchApp`, not `identifyPortHolder`:
 * that one registers an app it discovers in `apps.json`, and observing must
 * not write. An app the engine has not registered yet therefore reads as
 * `foreign` here until the engine meets it.
 *
 * Every reader answers null (or `up: false`) when it cannot tell.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { cyncoHome, missionsDir } from '../../paths.js'
import { readGpuBusy } from '../../daemon/gpuBusyFile.js'
import { classifyPortOwner } from '../../llama/portOwner.js'
import { readPortTree, listProcesses, type ListedProc, type PortTree } from '../../apps/portTree.js'
import { matchApp } from '../../apps/identify.js'
import { loadApps, type LocalApp } from '../../apps/registry.js'
import { TOKEN_FILENAME, DEVICE_PREFIX } from '../../security/localToken.js'
import type { EngineRow, HolderRow, ModelRow, ServiceRow } from './types.js'

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** GET `url` as JSON within `timeoutMs`; `ok: false` with the status (0 = no answer) on any failure. */
export async function getJson(fetchImpl: FetchLike, url: string, timeoutMs = 2000, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const resp = await fetchImpl(url, { headers, signal: ctl.signal })
    if (!resp.ok) return { ok: false, status: resp.status, body: null }
    return { ok: true, status: resp.status, body: await resp.json().catch(() => null) }
  } catch {
    return { ok: false, status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The shared `inference` secret from `tokens.json`, read and never written: the reporter must not
 * mint or rotate anything (`loadOrCreateTokens` would, on a file it cannot parse). Null = no file.
 */
export function readInferenceToken(home: string = cyncoHome()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, TOKEN_FILENAME), 'utf-8')) as { tokens?: Array<{ name?: unknown; scopes?: unknown; secret?: unknown }> }
    for (const t of parsed.tokens ?? []) {
      if (typeof t?.secret !== 'string' || typeof t?.name !== 'string' || t.name.startsWith(DEVICE_PREFIX)) continue
      if (Array.isArray(t.scopes) && t.scopes.includes('inference')) return t.secret
    }
    return null
  } catch {
    return null
  }
}

/** The engine, from its dashboard on loopback. `up` is the page answering at all; the rest needs the token. */
export async function readEngine(fetchImpl: FetchLike, dashboardUrl: string, token: string | null, now: number): Promise<EngineRow> {
  const base = dashboardUrl.replace(/\/$/, '')
  const session = token ? await getJson(fetchImpl, `${base}/api/session`, 2000, { Authorization: `Bearer ${token}` }) : { ok: false, status: 0, body: null }
  if (!session.ok) {
    // No token, or a refused one: the manifest is the dashboard's one static route and says whether it is there.
    const there = session.status >= 400 || (await getJson(fetchImpl, `${base}/manifest.webmanifest`, 2000)).ok
    return { up: there, modelState: null, processing: null, open: null }
  }
  const s = (session.body ?? {}) as Record<string, unknown>
  const raw = Array.isArray(s.activity) ? s.activity as Array<Record<string, unknown>> : null
  return {
    up: true,
    modelState: typeof s.modelState === 'string' ? s.modelState : null,
    processing: typeof s.processing === 'boolean' ? s.processing : null,
    open: raw && raw.filter(a => typeof a?.kind === 'string').map(a => ({
      kind: String(a.kind),
      ...(typeof a.label === 'string' ? { label: a.label.slice(0, 80) } : {}),
      sinceS: typeof a.since === 'number' ? Math.max(0, Math.round((now - a.since) / 1000)) : 0,
    })),
  }
}

export type ModelPortFacts = { up: boolean; name: string | null; busy: boolean | null }

/** The llama-server on the model port: is one there, which model, and is a slot working. */
export async function readModelPort(fetchImpl: FetchLike, port: number): Promise<ModelPortFacts> {
  const base = `http://127.0.0.1:${port}`
  // llama-server answers /health with 503 while it loads: something is there either way.
  const health = await getJson(fetchImpl, `${base}/health`, 1500)
  if (!health.ok && health.status !== 503) return { up: false, name: null, busy: null }
  const props = await getJson(fetchImpl, `${base}/props`, 1500)
  const path = (props.body as { model_path?: unknown } | null)?.model_path
  const slots = await getJson(fetchImpl, `${base}/slots`, 1500)
  const list = Array.isArray(slots.body) ? slots.body as Array<{ is_processing?: unknown }> : null
  return {
    up: true,
    name: typeof path === 'string' && path ? (path.split(/[\\/]/).pop() ?? path) : null,
    busy: slots.ok && list ? list.some(s => s?.is_processing === true) : null,
  }
}

const DAEMON = /engine[\\/]daemon[\\/]main/

/** Is the liveness daemon in the process list. Null when the list cannot be read. */
export async function readDaemonUp(list: () => Promise<ListedProc[]> = listProcesses): Promise<boolean | null> {
  try {
    return (await list()).some(p => DAEMON.test(p.commandLine))
  } catch {
    return null
  }
}

/** Is there a mission for the daemon to run: any `<missionsDir>/<id>/mission.json`. */
export function daemonHasWork(dir: string = missionsDir()): boolean {
  try {
    return existsSync(dir) && readdirSync(dir, { withFileTypes: true }).some(e => e.isDirectory() && existsSync(join(dir, e.name, 'mission.json')))
  } catch {
    return false
  }
}

export type ServiceDeps = {
  fetchImpl: FetchLike
  embedUrl: string
  daemonUp: () => Promise<boolean | null>
  daemonHasWork: () => boolean
}

/**
 * The services something on this box depends on. `wanted` is this box's own knowledge of the
 * dependency: the dashboard is what the phone and the desk page open, the embedding service is
 * what a running engine searches with, the daemon is what runs the scheduled jobs. A daemon whose
 * state cannot be read is left out, not called down.
 */
export async function readServices(engine: EngineRow | null, deps: ServiceDeps): Promise<ServiceRow[]> {
  const out: ServiceRow[] = []
  if (engine) out.push({ name: 'dashboard', up: engine.up, wanted: true, by: 'the phone and the desk page' })
  const embed = await getJson(deps.fetchImpl, `${deps.embedUrl.replace(/\/$/, '')}/health`, 1500)
  out.push({ name: 'embed', up: embed.ok, wanted: engine?.up === true, by: 'the engine (code and project search)' })
  const daemon = await deps.daemonUp()
  if (daemon !== null) out.push({ name: 'daemon', up: daemon, wanted: deps.daemonHasWork(), by: 'the scheduled jobs' })
  return out
}

export type HolderDeps = {
  readBusy?: () => { triggerId: string; task: string } | null
  readTree?: (port: number) => Promise<PortTree | null>
  apps?: () => LocalApp[]
  now?: () => number
  /** How long one reading of the port's owner is trusted while the port stays up (it is a PowerShell call). */
  trustMs?: number
}

/**
 * Who holds the GPU by CynCo's own reckoning: a daemon one-shot (`gpu-busy.json`), else whose
 * server is on the model port. Returns a reader that remembers its last look at the port's owner.
 */
export function holderReader(port: number, deps: HolderDeps = {}): (modelUp: boolean) => Promise<HolderRow> {
  const readBusy = deps.readBusy ?? (() => readGpuBusy())
  const readTree = deps.readTree ?? ((p: number) => readPortTree(p, undefined, () => {}))
  const apps = deps.apps ?? (() => loadApps(undefined, () => {}))
  const now = deps.now ?? Date.now
  const trustMs = deps.trustMs ?? 5 * 60_000
  let last: { at: number; row: HolderRow } | null = null
  return async (modelUp: boolean) => {
    const busy = readBusy()
    if (busy) return { unit: `oneshot:${busy.triggerId}`, detail: `the daemon's one-shot ${busy.task}` }
    if (!modelUp) { last = null; return { unit: 'none', detail: 'nothing answers on the model port' } }
    if (last && now() - last.at < trustMs) return last.row
    const tree = await readTree(port)
    let row: HolderRow
    if (!tree) row = { unit: 'unknown', detail: 'the process on the model port could not be read' }
    else {
      const parent = tree.ancestors[0] ?? null
      const base = classifyPortOwner({ pid: tree.listener.pid, name: tree.listener.name, parentName: parent?.name ?? null, parentIsOlder: parent !== null })
      if (base.owner === 'engine') row = { unit: 'engine', detail: base.detail }
      else {
        const app = matchApp(tree, apps())
        row = app ? { unit: `app:${app.id}`, detail: `${app.name}'s model server (pid ${tree.listener.pid})` } : { unit: 'foreign', detail: base.detail }
      }
    }
    // An unreadable port is asked again at the next look; a read one is trusted for a while.
    last = tree ? { at: now(), row } : null
    return row
  }
}

/** The model rows of a sample: the model port's server, then what Ollama holds. */
export function modelRows(port: number, model: ModelPortFacts | null, holder: HolderRow | null, engine: EngineRow | null, ollama: ModelRow[]): ModelRow[] | null {
  if (model === null) return ollama.length ? ollama : null
  const rows: ModelRow[] = []
  if (model.up) {
    let busy = model.busy
    // A server that does not show its slots: the engine's own open work says whether its model is in use.
    if (busy === null && holder?.unit === 'engine' && engine?.open) busy = engine.open.length > 0 || engine.processing === true
    if (holder?.unit.startsWith('oneshot:')) busy = true
    rows.push({ server: `llama:${port}`, name: model.name ?? 'a model', busy })
  }
  return [...rows, ...ollama]
}
