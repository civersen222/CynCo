/**
 * engine/dashboard/appsApi.ts — the owner's local-LLM apps, for the dashboard.
 *
 * `GET /api/apps`: the apps CynCo knows (`~/.cynco/apps.json`), how each serves
 * its model, whether it holds the GPU now, whether CynCo manages it, and whether
 * it is owed its server back. `PUT /api/apps/<id>` `{ "manage": boolean }`
 * switches management for one app. Reading is the read scope; switching is
 * configuration and so management scope, which the remote rule makes desk-only
 * (`server.ts`). Pure of HTTP, like `missionsApi.ts`. The rule itself is
 * `engine/apps`; design: docs/decisions/2026-11-11-local-llm-apps.md.
 */
import { basename } from 'path'
import { readDisplaced } from '../apps/displace.js'
import { loadRegistry, setAppManaged, type OllamaSettings } from '../apps/registry.js'
import type { LoadedModel } from '../apps/ollama.js'

export type AppRow = {
  id: string
  name: string
  /** `server`: it starts a model server of its own. `ollama`: it asks Ollama. */
  kind: 'server' | 'ollama'
  /** How it serves its model, in words. */
  serves: string
  root: string
  manage: boolean
  holdsGpu: boolean
  /** What it holds, when it does: `port 8081 (pid 4242)`, `qwen3.6:27b in Ollama, 17.0 GB of GPU memory`. */
  holding: string | null
  /** CynCo stopped its server and will start it again when it is done. */
  owed: boolean
}

export type AppsView = { apps: AppRow[]; port: number; ollama: OllamaSettings }

export type AppsDeps = {
  /** CynCo's model port. */
  port: number
  /** The app whose server is on the model port right now, or null. */
  portHolder: () => Promise<{ appId: string; pid: number } | null>
  /** What Ollama holds in GPU memory right now. */
  ollamaLoaded: (url: string) => Promise<LoadedModel[]>
  registryFile?: string
  displacedFile?: string
}

const withoutLatest = (m: string): string => (m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m)

/** A probe that fails is "not known to be holding", said in the log, never an error on the page. */
async function probe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    console.log(`[dashboard] apps: ${what} could not be read (${e instanceof Error ? e.message : String(e)})`)
    return fallback
  }
}

export async function readAppsView(deps: AppsDeps): Promise<AppsView> {
  const registry = loadRegistry(deps.registryFile)
  const owed = new Set(readDisplaced(deps.displacedFile).map(d => d.appId))
  const holder = registry.apps.length > 0 ? await probe('the model port', deps.portHolder, null) : null
  const loaded = registry.ollamaApps.length > 0 ? await probe('Ollama', () => deps.ollamaLoaded(registry.ollama.url), [] as LoadedModel[]) : []
  const apps: AppRow[] = [
    ...registry.apps.map((a): AppRow => {
      const holds = holder?.appId === a.id
      return {
        id: a.id, name: a.name, kind: 'server', root: a.root, manage: a.manage,
        serves: `its own model server, started by ${basename(a.launch.exe.replace(/\\/g, '/'))} ${a.script}`,
        holdsGpu: holds, holding: holds ? `port ${deps.port} (pid ${holder!.pid})` : null, owed: owed.has(a.id),
      }
    }),
    ...registry.ollamaApps.map((a): AppRow => {
      const names = new Set(a.models.map(withoutLatest))
      const mine = loaded.filter(m => names.has(withoutLatest(m.name)))
      return {
        id: a.id, name: a.name, kind: 'ollama', root: a.root, manage: a.manage,
        serves: `Ollama (${a.models.join(', ')})`,
        holdsGpu: mine.length > 0,
        holding: mine.length > 0 ? mine.map(m => `${m.name} in Ollama, ${(m.vramMib / 1024).toFixed(1)} GB of GPU memory`).join('; ') : null,
        owed: false,
      }
    }),
  ]
  return { apps, port: deps.port, ollama: registry.ollama }
}

export async function setAppManagedApi(deps: AppsDeps, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const manage = (body as { manage?: unknown } | null)?.manage
  if (typeof manage !== 'boolean') return { status: 400, json: { error: 'the body must be { "manage": true } or { "manage": false }' } }
  let found: boolean
  try {
    found = setAppManaged(id, manage, deps.registryFile)
  } catch (e) {
    return { status: 500, json: { error: `apps.json could not be written: ${e instanceof Error ? e.message : String(e)}` } }
  }
  if (!found) return { status: 404, json: { error: `no app named ${id}` } }
  console.log(`[dashboard] apps: ${id} is ${manage ? 'managed by CynCo' : 'no longer managed by CynCo'}`)
  return { status: 200, json: await readAppsView(deps) }
}

/** How long one reading of the model port's holder is trusted: it is a PowerShell call, and the page may ask often. */
const HOLDER_TTL_MS = 5_000

/** The real probes, for `main.ts`: who holds the model port (`engine/apps/identify.ts`) and what Ollama has loaded. */
export function liveAppsDeps(port: number): AppsDeps {
  let last: { at: number; value: { appId: string; pid: number } | null } | null = null
  return {
    port,
    portHolder: async () => {
      if (last && Date.now() - last.at < HOLDER_TTL_MS) return last.value
      const [{ portBound }, { identifyPortHolder }] = await Promise.all([import('../apps/gpu.js'), import('../apps/identify.js')])
      const holder = (await portBound(port)) ? await identifyPortHolder(port) : null
      last = { at: Date.now(), value: holder && holder.owner === 'app' ? { appId: holder.app.id, pid: holder.listener.pid } : null }
      return last.value
    },
    ollamaLoaded: async (url) => (await import('../apps/ollama.js')).ollamaLoaded(url),
  }
}
