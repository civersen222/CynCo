/**
 * engine/apps/registry.ts — the owner's local-LLM apps CynCo knows about.
 *
 * `~/.cynco/apps.json`: one entry per app whose model server CynCo may take the
 * GPU from and start again (docs/decisions/2026-11-11-local-llm-apps.md).
 * Written by discovery (`identify.ts`) with the evidence in `source`, and
 * editable by the owner: `"manage": false` turns management off for that app.
 * A file that is missing or malformed reads as empty and is logged; it never
 * stops the engine.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { cyncoHome } from '../paths.js'

/** How to start an app's model server again: the interpreter that ran it, the script, the app's folder. */
export type AppLaunch = { exe: string; args: string[]; cwd: string }

/**
 * One thing an app needs running before it can be opened, in the order the recipe lists them
 * (`start.ts`; docs/decisions/2026-11-11-local-llm-apps.md, decision 7).
 */
export type AppStep = {
  /** How the owner is told: `database`, `web app`. */
  name: string
  /** The app's own model server: started from the entry's `launch`, by the rule for the model port. Needs `port`. */
  model?: boolean
  /** Ready when something listens on this port of this PC. */
  port?: number
  /** Ready only when this address answers 2xx, for what listens before it can answer (a model server that is still loading). */
  url?: string
  /** Ready when this command exits 0, for what has no port (`docker info`). */
  check?: { exe: string; args: string[] }
  /** How it is started when it is not ready. Absent: CynCo does not start it, and says so. */
  exe?: string
  args?: string[]
  /** Relative to the app's folder. */
  cwd?: string
  /** Left running when the launcher's window is closed (Docker Desktop). */
  keep?: boolean
  /** How long to wait for it to be ready. Default 60, and 240 for the model server. */
  waitSeconds?: number
}

/** How the owner's click starts the whole app: what must run, and the address to open when it does. */
export type AppStart = { steps: AppStep[]; open?: string; icon?: string }

export type LocalApp = {
  /** A short name for records and logs: the folder name, lowercased. */
  id: string
  /** How the owner is told: the folder name. */
  name: string
  /** The app's folder. A process running from here means the app is in use. */
  root: string
  /** The launcher script, relative to `root`, forward slashes: what a live server is matched on. */
  script: string
  launch: AppLaunch
  /** false: CynCo treats this app's server as any server that is not its own (F202). */
  manage: boolean
  /** Where the entry came from: `by hand`, or what discovery saw. */
  source: string
  /** Written by hand: discovery knows the model server, not the rest of the app. */
  start?: AppStart
}

/**
 * An app that has no model server of its own: it asks Ollama, and Ollama holds
 * its model in GPU memory (`ollama.ts`). `models` are the Ollama model names it
 * was found using.
 */
export type OllamaApp = { id: string; name: string; root: string; models: string[]; manage: boolean; source: string; start?: AppStart }

/** The Ollama on this PC the owner's apps talk to. `manage: false`: CynCo never asks it to unload anything. */
export type OllamaSettings = { url: string; manage: boolean }

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/**
 * What a search of the owner's project folders found for one Ollama model: the projects whose files name it.
 * Remembered so the search, which reads thousands of files, runs once per model and not at every model load.
 * It is evidence, not an app: only `ollamaApps` are managed and shown.
 */
export type OllamaFinding = { model: string; projects: Array<{ name: string; root: string }>; at: string }

export type Registry = { apps: LocalApp[]; ollamaApps: OllamaApp[]; ollama: OllamaSettings; ollamaFindings: OllamaFinding[] }

export function appsFile(): string {
  return join(cyncoHome(), 'apps.json')
}

function isOllamaApp(v: unknown): v is OllamaApp {
  const a = v as OllamaApp
  return !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.root === 'string' && Array.isArray(a.models)
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

/** A recipe as far as it can be trusted: a step that is not one is dropped, and a recipe with no steps and no address is none. */
function readStart(v: unknown): AppStart | undefined {
  const s = v as { steps?: unknown; open?: unknown; icon?: unknown } | null
  if (!s || typeof s !== 'object') return undefined
  const steps: AppStep[] = []
  for (const raw of Array.isArray(s.steps) ? s.steps as Array<Partial<AppStep> | null> : []) {
    if (!raw || typeof raw.name !== 'string' || !raw.name) continue
    const check = raw.check && typeof raw.check.exe === 'string' && isStrings(raw.check.args) ? { exe: raw.check.exe, args: raw.check.args } : undefined
    steps.push({
      name: raw.name,
      ...(raw.model === true ? { model: true } : {}),
      ...(Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? { port: raw.port } : {}),
      ...(typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? { url: raw.url } : {}),
      ...(check ? { check } : {}),
      ...(typeof raw.exe === 'string' && raw.exe ? { exe: raw.exe, args: isStrings(raw.args) ? raw.args : [] } : {}),
      ...(typeof raw.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
      ...(raw.keep === true ? { keep: true } : {}),
      ...(typeof raw.waitSeconds === 'number' && raw.waitSeconds > 0 ? { waitSeconds: raw.waitSeconds } : {}),
    })
  }
  const open = typeof s.open === 'string' && s.open ? s.open : undefined
  if (steps.length === 0 && !open) return undefined
  return { steps, ...(open ? { open } : {}), ...(typeof s.icon === 'string' && s.icon ? { icon: s.icon } : {}) }
}

/** `start` as read, or no `start` key at all: an entry without a recipe is written back without one. */
const withStart = <T extends { start?: unknown }>(a: T): { start?: AppStart } => {
  const start = readStart(a.start)
  return start ? { start } : {}
}

/** The whole file. Missing or malformed reads as empty with the defaults, and is logged. */
export function loadRegistry(file: string = appsFile(), log: (line: string) => void = console.log): Registry {
  const empty: Registry = { apps: [], ollamaApps: [], ollama: { url: DEFAULT_OLLAMA_URL, manage: true }, ollamaFindings: [] }
  if (!existsSync(file)) return empty
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as { apps?: unknown; ollamaApps?: unknown; ollama?: { url?: unknown; manage?: unknown }; ollamaFindings?: unknown }
    const src = (a: { source?: unknown }) => (typeof a.source === 'string' ? a.source : 'by hand')
    return {
      apps: (Array.isArray(j.apps) ? j.apps.filter(isApp) : []).map(({ start, ...a }) => ({ ...a, manage: a.manage !== false, source: src(a), ...withStart({ start }) })),
      ollamaApps: (Array.isArray(j.ollamaApps) ? j.ollamaApps.filter(isOllamaApp) : [])
        .map(({ start, ...a }) => ({ ...a, models: a.models.filter((m): m is string => typeof m === 'string'), manage: a.manage !== false, source: src(a), ...withStart({ start }) })),
      ollama: {
        url: typeof j.ollama?.url === 'string' && j.ollama.url ? j.ollama.url.replace(/\/+$/, '') : DEFAULT_OLLAMA_URL,
        manage: j.ollama?.manage !== false,
      },
      ollamaFindings: (Array.isArray(j.ollamaFindings) ? j.ollamaFindings : [])
        .filter((f): f is OllamaFinding => !!f && typeof f.model === 'string' && typeof f.at === 'string' && Array.isArray(f.projects))
        .map(f => ({ model: f.model, at: f.at, projects: f.projects.filter(p => !!p && typeof p.name === 'string' && typeof p.root === 'string') })),
    }
  } catch (e) {
    log(`[apps] ${file} could not be read (${e instanceof Error ? e.message : String(e)}); no apps are known until it is fixed`)
    return empty
  }
}

export function saveRegistry(r: Registry, file: string = appsFile()): void {
  writeJsonAtomic(file, { version: 1, apps: r.apps, ollamaApps: r.ollamaApps, ollama: r.ollama, ollamaFindings: r.ollamaFindings })
}

/** Remember what a search found for one model, replacing what was remembered for it. The rest of the file is kept. */
export function saveOllamaFinding(finding: OllamaFinding, file: string = appsFile()): void {
  const r = loadRegistry(file, () => {})
  saveRegistry({ ...r, ollamaFindings: [...r.ollamaFindings.filter(f => f.model !== finding.model), finding] }, file)
}

function isApp(v: unknown): v is LocalApp {
  const a = v as LocalApp
  return !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.root === 'string' && typeof a.script === 'string'
    && !!a.launch && typeof a.launch.exe === 'string' && Array.isArray(a.launch.args) && typeof a.launch.cwd === 'string'
}

export function loadApps(file: string = appsFile(), log: (line: string) => void = console.log): LocalApp[] {
  return loadRegistry(file, log).apps
}

export function loadOllamaApps(file: string = appsFile(), log: (line: string) => void = console.log): OllamaApp[] {
  return loadRegistry(file, log).ollamaApps
}

/** Write through a temp file: a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Add an app, or replace the entry with the same id. The rest of the file is kept. */
export function saveApp(app: LocalApp, file: string = appsFile()): void {
  const r = loadRegistry(file, () => {})
  saveRegistry({ ...r, apps: [...r.apps.filter(a => a.id !== app.id), app] }, file)
}

/** Add an Ollama app, or add models to the entry with the same id. The rest of the file is kept. */
export function saveOllamaApp(app: OllamaApp, file: string = appsFile()): void {
  const r = loadRegistry(file, () => {})
  const had = r.ollamaApps.find(a => a.id === app.id)
  const merged: OllamaApp = had ? { ...had, models: [...new Set([...had.models, ...app.models])] } : app
  saveRegistry({ ...r, ollamaApps: [...r.ollamaApps.filter(a => a.id !== app.id), merged] }, file)
}

/** The entry with this id, whichever kind it is: what a launcher needs of it. */
export function findApp(id: string, r: Registry): (LocalApp | OllamaApp) | null {
  return r.apps.find(a => a.id === id) ?? r.ollamaApps.find(a => a.id === id) ?? null
}

/** Switch management of one app on or off, whichever kind it is. False when no app has that id. */
export function setAppManaged(id: string, manage: boolean, file: string = appsFile()): boolean {
  const r = loadRegistry(file, () => {})
  let found = false
  const flip = <T extends { id: string; manage: boolean }>(a: T): T => (a.id === id ? (found = true, { ...a, manage }) : a)
  const next: Registry = { ...r, apps: r.apps.map(flip), ollamaApps: r.ollamaApps.map(flip) }
  if (found) saveRegistry(next, file)
  return found
}
