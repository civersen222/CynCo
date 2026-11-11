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
}

/**
 * An app that has no model server of its own: it asks Ollama, and Ollama holds
 * its model in GPU memory (`ollama.ts`). `models` are the Ollama model names it
 * was found using.
 */
export type OllamaApp = { id: string; name: string; root: string; models: string[]; manage: boolean; source: string }

/** The Ollama on this PC the owner's apps talk to. `manage: false`: CynCo never asks it to unload anything. */
export type OllamaSettings = { url: string; manage: boolean }

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export type Registry = { apps: LocalApp[]; ollamaApps: OllamaApp[]; ollama: OllamaSettings }

export function appsFile(): string {
  return join(cyncoHome(), 'apps.json')
}

function isOllamaApp(v: unknown): v is OllamaApp {
  const a = v as OllamaApp
  return !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.root === 'string' && Array.isArray(a.models)
}

/** The whole file. Missing or malformed reads as empty with the defaults, and is logged. */
export function loadRegistry(file: string = appsFile(), log: (line: string) => void = console.log): Registry {
  const empty: Registry = { apps: [], ollamaApps: [], ollama: { url: DEFAULT_OLLAMA_URL, manage: true } }
  if (!existsSync(file)) return empty
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as { apps?: unknown; ollamaApps?: unknown; ollama?: { url?: unknown; manage?: unknown } }
    const src = (a: { source?: unknown }) => (typeof a.source === 'string' ? a.source : 'by hand')
    return {
      apps: (Array.isArray(j.apps) ? j.apps.filter(isApp) : []).map(a => ({ ...a, manage: a.manage !== false, source: src(a) })),
      ollamaApps: (Array.isArray(j.ollamaApps) ? j.ollamaApps.filter(isOllamaApp) : [])
        .map(a => ({ ...a, models: a.models.filter((m): m is string => typeof m === 'string'), manage: a.manage !== false, source: src(a) })),
      ollama: {
        url: typeof j.ollama?.url === 'string' && j.ollama.url ? j.ollama.url.replace(/\/+$/, '') : DEFAULT_OLLAMA_URL,
        manage: j.ollama?.manage !== false,
      },
    }
  } catch (e) {
    log(`[apps] ${file} could not be read (${e instanceof Error ? e.message : String(e)}); no apps are known until it is fixed`)
    return empty
  }
}

export function saveRegistry(r: Registry, file: string = appsFile()): void {
  writeJsonAtomic(file, { version: 1, apps: r.apps, ollamaApps: r.ollamaApps, ollama: r.ollama })
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

/** Switch management of one app on or off, whichever kind it is. False when no app has that id. */
export function setAppManaged(id: string, manage: boolean, file: string = appsFile()): boolean {
  const r = loadRegistry(file, () => {})
  let found = false
  const flip = <T extends { id: string; manage: boolean }>(a: T): T => (a.id === id ? (found = true, { ...a, manage }) : a)
  const next: Registry = { ...r, apps: r.apps.map(flip), ollamaApps: r.ollamaApps.map(flip) }
  if (found) saveRegistry(next, file)
  return found
}
