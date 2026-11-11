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

export function appsFile(): string {
  return join(cyncoHome(), 'apps.json')
}

function isApp(v: unknown): v is LocalApp {
  const a = v as LocalApp
  return !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.root === 'string' && typeof a.script === 'string'
    && !!a.launch && typeof a.launch.exe === 'string' && Array.isArray(a.launch.args) && typeof a.launch.cwd === 'string'
}

export function loadApps(file: string = appsFile(), log: (line: string) => void = console.log): LocalApp[] {
  if (!existsSync(file)) return []
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as { apps?: unknown }
    const apps = Array.isArray(j.apps) ? j.apps.filter(isApp) : []
    return apps.map(a => ({ ...a, manage: a.manage !== false, source: typeof a.source === 'string' ? a.source : 'by hand' }))
  } catch (e) {
    log(`[apps] ${file} could not be read (${e instanceof Error ? e.message : String(e)}); no apps are known until it is fixed`)
    return []
  }
}

/** Write through a temp file: a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Add an app, or replace the entry with the same id. */
export function saveApp(app: LocalApp, file: string = appsFile()): void {
  const apps = loadApps(file, () => {}).filter(a => a.id !== app.id)
  writeJsonAtomic(file, { version: 1, apps: [...apps, app] })
}
