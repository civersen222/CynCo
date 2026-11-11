/**
 * engine/apps/ollama.ts — the owner's apps that use Ollama.
 *
 * screenplayer, wagetheory and Gilded have no model server of their own: they
 * ask Ollama on this PC, and Ollama keeps their model in the GPU's memory for
 * minutes after the last request, or for as long as the app keeps asking. Such
 * a model never holds CynCo's port, so `identify.ts` never sees it; what it
 * does is leave the card too full for CynCo's own model (the F140 refusal) and
 * make a one-shot wait (docs/decisions/2026-11-11-local-llm-apps.md, slice 4).
 *
 * The rule is the same one as for an app's own server: when CynCo needs the
 * GPU, it takes it and says from whom. Taking is one request Ollama documents
 * for the purpose: `POST /api/generate` with `keep_alive: 0` and no prompt.
 * Ollama's HTTP API is the whole interface; its files, service and settings
 * are never touched. Giving back is nothing CynCo does: Ollama loads the model
 * again by itself on the app's next request.
 *
 * Which app a model belongs to is figured out the way a server's is: the
 * registry first, then the owner's project folders, looking for a file that
 * names the model beside Ollama.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { projectDirs } from './identify.js'
import { appsFile, loadRegistry, saveOllamaApp, type OllamaApp } from './registry.js'

export type LoadedModel = { name: string; vramMib: number }

const API_TIMEOUT_MS = 5_000
const MIB = 1024 * 1024

/** What Ollama holds in GPU memory right now. Ollama not running, or not answering, is nothing loaded. */
export async function ollamaLoaded(url: string, log: (line: string) => void = () => {}): Promise<LoadedModel[]> {
  try {
    const resp = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    if (!resp.ok) { log(`[apps] Ollama at ${url} answered /api/ps with HTTP ${resp.status}`); return [] }
    const j = (await resp.json()) as { models?: Array<{ name?: unknown; size_vram?: unknown }> }
    return (j.models ?? [])
      .filter(m => typeof m.name === 'string' && typeof m.size_vram === 'number' && m.size_vram > 0)
      .map(m => ({ name: m.name as string, vramMib: Math.round((m.size_vram as number) / MIB) }))
  } catch (e) {
    log(`[apps] Ollama at ${url} did not answer /api/ps: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function unload(url: string, model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const resp = await fetch(`${url}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS * 2),
    })
    return resp.ok ? { ok: true } : { ok: false, reason: `HTTP ${resp.status}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** `qwen3.6` in an app's config is what Ollama lists as `qwen3.6:latest`. */
function spellings(model: string): string[] {
  return model.endsWith(':latest') ? [model, model.slice(0, -':latest'.length)] : [model]
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.claude', '.worktrees', 'models', 'data', 'logs'])
const CONFIG_FILE = /\.(py|ts|tsx|js|mjs|cjs|json|ya?ml|toml|ini|cfg|env|sh|cmd|bat|ps1)$|^\.env|^Dockerfile|^docker-compose/i
const MENTIONS_OLLAMA = /ollama|11434/i
const MAX_FILE_BYTES = 256 * 1024
const MAX_FILES_PER_PROJECT = 1500
const MAX_DEPTH = 4

/** Does some source or config file of this project name the model as a whole token, in a file that also names Ollama? */
function projectUsesModel(root: string, names: string[]): boolean {
  const token = new RegExp(`(^|[^A-Za-z0-9_.:-])(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})($|[^A-Za-z0-9_.:-])`)
  let seen = 0
  const walk = (dir: string, depth: number): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (seen >= MAX_FILES_PER_PROJECT) return false
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name) && walk(full, depth + 1)) return true
        continue
      }
      if (!entry.isFile() || !CONFIG_FILE.test(entry.name)) continue
      seen++
      if (statSync(full).size > MAX_FILE_BYTES) continue
      const text = readFileSync(full, 'utf-8')
      if (MENTIONS_OLLAMA.test(text) && token.test(text)) return true
    }
    return false
  }
  return walk(root, 0)
}

/**
 * The owner's projects that use this Ollama model: a project folder with a
 * source or config file that names the model (as Ollama lists it, or without
 * `:latest`) and names Ollama or its port. Bounded: four folders deep, 1,500
 * files a project, no dependencies or build output.
 */
export function findOllamaApps(model: string, roots: string[], log: (line: string) => void = () => {}, now: () => Date = () => new Date()): OllamaApp[] {
  const names = spellings(model)
  const found: OllamaApp[] = []
  for (const root of roots) {
    try {
      if (!projectUsesModel(root, names)) continue
    } catch (e) {
      log(`[apps] ${root} could not be searched for ${model}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const name = basename(root)
    found.push({
      id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name, root, models: [model], manage: true,
      source: `discovered ${now().toISOString()}: Ollama held ${model}, and a file under ${root} names that model beside Ollama`,
    })
  }
  return found
}

export type FreeOllamaCtx = {
  /** Who needs the GPU, for the notice: `the chat engine`, `the one-shot digest-espn`. */
  by: string
  say: (message: string) => void
  /** Default: `ollama.url` in the registry, else `http://127.0.0.1:11434`. */
  url?: string
  registryFile?: string
  /** Project folders to search for a model nobody is registered as using. Default: `projectDirs()`. */
  roots?: string[]
  log?: (line: string) => void
}

const gb = (mib: number): string => (mib / 1024).toFixed(1)
const orList = (names: string[]): string => names.join(' or ')

/**
 * CynCo needs the GPU: ask Ollama to unload what it holds, and say whose it
 * was. Resolves to how many models were unloaded; never throws. A model whose
 * every known app has `"manage": false` stays, and that is said instead.
 */
export async function freeOllamaForCynco(ctx: FreeOllamaCtx): Promise<number> {
  const log = ctx.log ?? console.log
  const file = ctx.registryFile ?? appsFile()
  const registry = loadRegistry(file, log)
  if (!registry.ollama.manage) return 0
  const url = (ctx.url ?? registry.ollama.url).replace(/\/+$/, '')
  const loaded = await ollamaLoaded(url, log)
  let unloaded = 0
  for (const model of loaded) {
    const names = spellings(model.name)
    let users = loadRegistry(file, log).ollamaApps.filter(a => a.models.some(m => names.includes(m)))
    if (users.length === 0) {
      users = findOllamaApps(model.name, ctx.roots ?? projectDirs(), log)
      for (const app of users) {
        try { saveOllamaApp(app, file) } catch (e) { log(`[apps] ${app.name} could not be written to ${file}: ${e instanceof Error ? e.message : String(e)}`) }
        log(`[apps] ${app.source}; registered as ${app.name} in ${file}`)
      }
    }
    const held = `${model.name} (${gb(model.vramMib)} GB of GPU memory)`
    const managed = users.filter(a => a.manage)
    if (users.length > 0 && managed.length === 0) {
      ctx.say(`Ollama holds ${held} for ${orList(users.map(a => a.name))}, which CynCo does not manage ("manage": false in apps.json): it stays loaded.`)
      continue
    }
    const r = await unload(url, model.name)
    if (!r.ok) { ctx.say(`Ollama did not unload ${model.name}: ${r.reason}`); continue }
    unloaded++
    ctx.say(managed.length > 0
      ? `Ollama held ${held} for ${orList(managed.map(a => a.name))}. CynCo asked Ollama to unload it for ${ctx.by}; Ollama loads it again on ${managed.length === 1 ? `${managed[0].name}'s` : 'their'} next request.`
      : `Ollama held ${held}; none of your projects was found using it. CynCo asked Ollama to unload it for ${ctx.by}; Ollama loads it again on the next request for it.`)
  }
  return unloaded
}
