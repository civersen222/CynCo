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
 * Whose model it was cannot be read: Ollama does not say who asked. The
 * registry answers first. Otherwise the owner's project folders are searched
 * for files that name the model beside Ollama, which is evidence and not an
 * answer (several projects share a model, and scratch copies name it too), so
 * those projects are listed in the notice, and one of them becomes a managed
 * app only when it is the single one running (F220).
 */
import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { appInUse } from './displace.js'
import { projectDirs } from './identify.js'
import { listProcesses, type ListedProc } from './portTree.js'
import { appsFile, loadRegistry, saveOllamaApp, saveOllamaFinding, type OllamaApp } from './registry.js'

export type LoadedModel = { name: string; vramMib: number }

const API_TIMEOUT_MS = 5_000
const MIB = 1024 * 1024

/**
 * `fetch` with a deadline, by a timer that is cleared when the request settles. Not `AbortSignal.timeout`:
 * this module is also reached from a Bun script (`scripts/cynco-apps.mjs`), where that is a known hazard,
 * and a timer left running would hold a short script open.
 */
async function fetchWithin(ms: number, url: string, init: RequestInit = {}): Promise<Response> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${ms} ms`)), ms)
  try {
    return await fetch(url, { ...init, signal: abort.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** What Ollama holds in GPU memory right now. Ollama not running, or not answering, is nothing loaded. */
export async function ollamaLoaded(url: string, log: (line: string) => void = () => {}): Promise<LoadedModel[]> {
  try {
    const resp = await fetchWithin(API_TIMEOUT_MS, `${url}/api/ps`)
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
    const resp = await fetchWithin(API_TIMEOUT_MS * 2, `${url}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
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
/** How long one search may take. The owner's folders took 31 s to read cold and 2 to 3 s warm (F220). */
const SEARCH_BUDGET_MS = 4_000
/** How long what a search found is believed before the folders are read again. */
export const FINDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type ModelUsers = { projects: Array<{ name: string; root: string }>; complete: boolean }
export type SearchOpts = { budgetMs?: number; now?: () => number; log?: (line: string) => void }

const OUT_OF_TIME = Symbol('out of time')
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * A folder with CynCo's failure log is a checkout of CynCo (a worktree or a campaign copy included), which names
 * every model in its tests and docs. The log and not this module: a checkout from before this module is one too.
 */
const isCyncoCheckout = (root: string): Promise<boolean> =>
  stat(join(root, 'docs', 'cynco-failure-log.md')).then(s => s.isFile(), () => false)

/**
 * The owner's projects whose files name this Ollama model: a source or config
 * file that names the model as a whole token (as Ollama lists it, or without
 * `:latest`) and names Ollama or its port. Bounded: four folders deep, 1,500
 * files a project, no dependencies or build output, not CynCo's own checkouts,
 * and a time budget, after which it answers with what it has and
 * `complete: false`. It awaits every read, so the engine keeps answering
 * while it runs.
 */
export async function findModelUsers(model: string, roots: string[], opts: SearchOpts = {}): Promise<ModelUsers> {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const deadline = now() + (opts.budgetMs ?? SEARCH_BUDGET_MS)
  const names = spellings(model).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const token = new RegExp(`(^|[^A-Za-z0-9_.:-])(${names})($|[^A-Za-z0-9_.:-])`)

  const usesModel = async (root: string): Promise<boolean> => {
    let seen = 0
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (now() > deadline) throw OUT_OF_TIME
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (e) {
        log(`[apps] ${dir} could not be read while looking for ${model}: ${reason(e)}`)
        return false
      }
      for (const entry of entries) {
        if (seen >= MAX_FILES_PER_PROJECT) return false
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name) && await walk(full, depth + 1)) return true
          continue
        }
        if (!entry.isFile() || !CONFIG_FILE.test(entry.name)) continue
        seen++
        try {
          if ((await stat(full)).size > MAX_FILE_BYTES) continue
          const text = await readFile(full, 'utf-8')
          if (MENTIONS_OLLAMA.test(text) && token.test(text)) return true
        } catch (e) {
          log(`[apps] ${full} could not be read while looking for ${model}: ${reason(e)}`)
        }
      }
      return false
    }
    return walk(root, 0)
  }

  const projects: ModelUsers['projects'] = []
  for (const root of roots) {
    try {
      if (await isCyncoCheckout(root)) continue
      if (await usesModel(root)) projects.push({ name: basename(root), root })
    } catch (e) {
      if (e !== OUT_OF_TIME) throw e
      log(`[apps] the search for projects that name ${model} stopped at its time budget, ${projects.length} found so far`)
      return { projects, complete: false }
    }
  }
  return { projects, complete: true }
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
  /** The search itself. Default: `findModelUsers`. */
  search?: (model: string, roots: string[], opts: SearchOpts) => Promise<ModelUsers>
  /** What is running, to tell which of the projects that name a model is in use. Default: `listProcesses`. */
  listProcesses?: () => Promise<ListedProc[]>
  now?: () => Date
}

const gb = (mib: number): string => (mib / 1024).toFixed(1)
const orList = (names: string[]): string => names.join(' or ')
const shortList = (names: string[]): string =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')

/** The projects whose files name this model: what was found within the last week, else a search now. */
async function modelUsers(model: string, ctx: FreeOllamaCtx, file: string, log: (line: string) => void): Promise<ModelUsers> {
  const now = (ctx.now ?? (() => new Date()))()
  const names = spellings(model)
  const known = loadRegistry(file, log).ollamaFindings.find(f => names.includes(f.model))
  if (known && now.getTime() - Date.parse(known.at) < FINDING_MAX_AGE_MS) return { projects: known.projects, complete: true }
  const found = await (ctx.search ?? findModelUsers)(model, ctx.roots ?? projectDirs(), { log })
  // A search that ran out of time is not remembered: the next one starts from a warmer disk and gets further.
  if (found.complete) {
    try {
      saveOllamaFinding({ model, projects: found.projects, at: now.toISOString() }, file)
    } catch (e) {
      log(`[apps] what was found for ${model} could not be written to ${file}: ${reason(e)}`)
    }
  }
  return found
}

/** The one project among these that has a process running from its folder, or null: none, several, or no process list. */
async function theOneRunning(projects: ModelUsers['projects'], ctx: FreeOllamaCtx, log: (line: string) => void): Promise<ModelUsers['projects'][number] | null> {
  if (projects.length === 0) return null
  let procs: ListedProc[]
  try {
    procs = await (ctx.listProcesses ?? listProcesses)()
  } catch (e) {
    log(`[apps] the process list could not be read, so no project is taken to be the one using Ollama: ${reason(e)}`)
    return null
  }
  const running = projects.filter(p => appInUse(p, -1, procs))
  return running.length === 1 ? running[0] : null
}

/**
 * CynCo needs the GPU: ask Ollama to unload what it holds, and say whose it
 * was as far as that is known. Resolves to how many models were unloaded;
 * never throws. A model whose every registered app has `"manage": false`
 * stays, and that is said instead.
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
    const held = `${model.name} (${gb(model.vramMib)} GB of GPU memory)`
    const users = loadRegistry(file, log).ollamaApps.filter(a => a.models.some(m => names.includes(m)))
    const managed = users.filter(a => a.manage)
    if (users.length > 0 && managed.length === 0) {
      ctx.say(`Ollama holds ${held} for ${orList(users.map(a => a.name))}, which CynCo does not manage ("manage": false in apps.json): it stays loaded.`)
      continue
    }
    // The unload comes first: the search below only decides the wording, and the card empties meanwhile.
    const r = await unload(url, model.name)
    if (!r.ok) { ctx.say(`Ollama did not unload ${model.name}: ${r.reason}`); continue }
    unloaded++
    const asked = `CynCo asked Ollama to unload it for ${ctx.by}`
    if (managed.length > 0) {
      ctx.say(`Ollama held ${held} for ${orList(managed.map(a => a.name))}. ${asked}; Ollama loads it again on ${managed.length === 1 ? `${managed[0].name}'s` : 'their'} next request.`)
      continue
    }
    let found: ModelUsers
    try {
      found = await modelUsers(model.name, ctx, file, log)
    } catch (e) {
      log(`[apps] the search for projects that name ${model.name} failed: ${reason(e)}`)
      found = { projects: [], complete: false }
    }
    const one = await theOneRunning(found.projects, ctx, log)
    if (one) {
      const app: OllamaApp = {
        id: one.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name: one.name, root: one.root, models: [model.name], manage: true,
        source: `discovered ${(ctx.now ?? (() => new Date()))().toISOString()}: Ollama held ${model.name}, and ${one.root} names that model beside Ollama and was running, the only such project`,
      }
      try { saveOllamaApp(app, file) } catch (e) { log(`[apps] ${app.name} could not be written to ${file}: ${reason(e)}`) }
      log(`[apps] ${app.source}; registered as ${app.name} in ${file}`)
      ctx.say(`Ollama held ${held} for ${one.name}. ${asked}; Ollama loads it again on ${one.name}'s next request.`)
      continue
    }
    const again = `${asked}; Ollama loads it again on the next request for it.`
    if (found.projects.length > 0) ctx.say(`Ollama held ${held}. Projects of yours that name this model: ${shortList(found.projects.map(p => p.name))}. ${again}`)
    else if (found.complete) ctx.say(`Ollama held ${held}; none of your projects was found naming it. ${again}`)
    else ctx.say(`Ollama held ${held}; CynCo did not finish looking through your projects for who uses it. ${again}`)
  }
  return unloaded
}
