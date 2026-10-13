/**
 * engine/imagegen/client.ts — the ComfyUI HTTP API, and the probe that asks
 * whether a configured server can paint with the configured workflow.
 *
 * Plain `fetch` through an injectable `fetchFn` (as `JlensClient` does), never
 * `fetchGuarded`/`validateUrl`: those refuse 192.168/16, and this URL is the
 * operator's choice, not the model's. Every call carries its own
 * `AbortSignal.timeout`. Every failure is a `ComfyError` whose `reason` is a
 * sentence the dashboard card and the model can show as is.
 *
 * The server's output filename is only ever a query parameter of `/view`; no
 * local path is built from anything the server sends.
 */
import type { ComfyConfig } from './config.js'
import { workflowClasses, type ComfyGraph } from './workflow.js'
import { isPng, RUN_ID, type ImageRef } from './store.js'

export class ComfyError extends Error {
  /** `refused`: ComfyUI answered POST /prompt with a 400 and queued nothing, so there is nothing of ours on it to cancel. */
  constructor(readonly reason: string, readonly refused = false) {
    super(reason)
    this.name = 'ComfyError'
  }
}

export type SystemStats = { version: string; device: string; vramGB: number | null }
/** One `/history/{id}` entry: present only once ComfyUI has finished (or failed) the prompt. */
export type HistoryEntry = {
  outputs: Record<string, unknown>
  status: { status_str?: string; completed?: boolean; messages?: unknown[] }
}

/** Per-call deadlines, ms. A test seam; production uses these. */
export const CLIENT_TIMEOUTS = { stats: 3000, models: 5000, node: 5000, submit: 15_000, history: 5000, view: 30_000, control: 2000 }
export type ClientTimeouts = typeof CLIENT_TIMEOUTS

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The short cause of a failed fetch: ECONNREFUSED, ENOTFOUND, timeout, … */
function netCause(e: unknown): string {
  const err = e as { name?: string; code?: unknown; message?: string; cause?: { code?: unknown; message?: string } } | null
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout'
  if (typeof err?.cause?.code === 'string') return err.cause.code
  if (typeof err?.code === 'string') return err.code
  return (err?.cause?.message ?? err?.message ?? String(e)).slice(0, 120)
}

function megabytes(n: number): string {
  return `${Math.round(n / (1024 * 1024))} MB`
}

export class ComfyClient {
  readonly host: string
  private readonly port: string
  private readonly timeouts: ClientTimeouts

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    timeouts: Partial<ClientTimeouts> = {},
  ) {
    const u = new URL(baseUrl)
    this.host = u.host
    this.port = u.port || (u.protocol === 'https:' ? '443' : '80')
    this.timeouts = { ...CLIENT_TIMEOUTS, ...timeouts }
  }

  /** One request. A network failure or timeout becomes the "did not answer" reason. */
  private async call(path: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      const cause = netCause(e)
      console.log(`[imagegen] ${init.method ?? 'GET'} ${this.baseUrl}${path.split('?')[0]} failed: ${cause}`)
      throw new ComfyError(`ComfyUI did not answer at ${this.baseUrl} (${cause}) — it listens on 127.0.0.1 unless started with --listen, and the PC's firewall must allow port ${this.port}`)
    }
  }

  private async json(res: Response, what: string): Promise<unknown> {
    try {
      return await res.json()
    } catch (e) {
      console.log(`[imagegen] ${what} from ${this.host} is not JSON: ${netCause(e)}`)
      throw new ComfyError(`ComfyUI at ${this.host} answered ${what} with something that is not JSON`)
    }
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    return this.call(path, timeoutMs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  async systemStats(): Promise<SystemStats> {
    const res = await this.call('/system_stats', this.timeouts.stats)
    const notComfy = () => new ComfyError(`${this.baseUrl} answered /system_stats with HTTP ${res.status} — is that ComfyUI?`)
    if (!res.ok) throw notComfy()
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      console.log(`[imagegen] /system_stats from ${this.host} is not JSON: ${netCause(e)}`)
      throw notComfy()
    }
    if (!isObj(body) || !isObj(body.system)) throw notComfy()
    const dev = Array.isArray(body.devices) && isObj(body.devices[0]) ? body.devices[0] : null
    const vram = dev && typeof dev.vram_total === 'number' ? Math.round((dev.vram_total / 2 ** 30) * 10) / 10 : null
    return {
      version: typeof body.system.comfyui_version === 'string' ? body.system.comfyui_version : 'unknown version',
      device: dev && typeof dev.name === 'string' ? dev.name : 'unknown device',
      vramGB: vram,
    }
  }

  async checkpoints(): Promise<string[]> {
    const res = await this.call('/models/checkpoints', this.timeouts.models)
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /models/checkpoints with HTTP ${res.status}`)
    const body = await this.json(res, '/models/checkpoints')
    if (!Array.isArray(body)) throw new ComfyError(`ComfyUI at ${this.host} answered /models/checkpoints with something that is not a list`)
    return body.filter((x): x is string => typeof x === 'string')
  }

  /** Whether the server has node class `cls`: `/object_info/<cls>` answers `{}` for one it lacks. */
  async hasNode(cls: string): Promise<boolean> {
    const res = await this.call(`/object_info/${encodeURIComponent(cls)}`, this.timeouts.node)
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /object_info/${cls} with HTTP ${res.status}`)
    const body = await this.json(res, `/object_info/${cls}`)
    return isObj(body) && Object.hasOwn(body, cls)
  }

  /**
   * Queue a filled graph. Returns the server's prompt_id, which is
   * authoritative: an older server ignores the id the client sends.
   */
  async submit(graph: ComfyGraph, promptId: string): Promise<string> {
    const res = await this.post('/prompt', { prompt: graph, prompt_id: promptId, client_id: `cynco-${RUN_ID}` }, this.timeouts.submit)
    if (res.status === 400) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch (e) {
        console.log(`[imagegen] /prompt 400 from ${this.host} is not JSON: ${netCause(e)}`)
      }
      throw new ComfyError(refusalReason(body), true)
    }
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /prompt with HTTP ${res.status}`)
    const body = await this.json(res, '/prompt')
    return isObj(body) && typeof body.prompt_id === 'string' && body.prompt_id ? body.prompt_id : promptId
  }

  /** null while the prompt is pending or running (`{}`); the entry once it has finished. */
  async history(id: string): Promise<HistoryEntry | null> {
    const res = await this.call(`/history/${encodeURIComponent(id)}`, this.timeouts.history)
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /history with HTTP ${res.status}`)
    const body = await this.json(res, '/history')
    if (!isObj(body) || !Object.hasOwn(body, id)) return null
    const entry = body[id]
    if (!isObj(entry)) throw new ComfyError(`ComfyUI at ${this.host} sent a history entry that is not an object`)
    return { outputs: isObj(entry.outputs) ? entry.outputs : {}, status: isObj(entry.status) ? (entry.status as HistoryEntry['status']) : {} }
  }

  /**
   * One saved picture's bytes. The filename the server named is sent back to
   * it as a query parameter and never touches the local filesystem. Refused
   * over `maxBytes` (before reading when Content-Length says so, else at the
   * cap while streaming) and when the bytes are not a PNG.
   */
  async download(ref: ImageRef, maxBytes: number): Promise<Uint8Array> {
    if (typeof ref.filename !== 'string' || !ref.filename || ref.filename.length > 255) throw new ComfyError('ComfyUI named an output file the engine will not fetch (a missing or over-long filename)')
    if (typeof ref.subfolder !== 'string' || ref.subfolder.length > 255) throw new ComfyError('ComfyUI named an output folder the engine will not fetch (not a short string)')
    if (ref.type !== 'output' && ref.type !== 'temp') throw new ComfyError(`ComfyUI named an output of type "${String(ref.type).slice(0, 20)}"; only output and temp are fetched`)
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
    const res = await this.call(`/view?${q}`, this.timeouts.view)
    const tooBig = `the picture from ComfyUI is larger than ${megabytes(maxBytes)}; refused`
    const cancel = (why: string) => res.body?.cancel().catch(e => console.log(`[imagegen] cancelling the /view body (${why}) failed: ${netCause(e)}`))
    if (!res.ok) { await cancel(`HTTP ${res.status}`); throw new ComfyError(`ComfyUI answered /view with HTTP ${res.status}`) }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) { await cancel('Content-Length over the cap'); throw new ComfyError(tooBig) }
    const chunks: Uint8Array[] = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(e => console.log(`[imagegen] cancelling an oversized /view stream failed: ${netCause(e)}`))
            throw new ComfyError(tooBig)
          }
          chunks.push(value)
        }
      } catch (e) {
        if (e instanceof ComfyError) throw e
        console.log(`[imagegen] reading /view from ${this.host} failed: ${netCause(e)}`)
        throw new ComfyError(`ComfyUI stopped sending the picture (${netCause(e)})`)
      }
    }
    const bytes = new Uint8Array(total)
    let at = 0
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
    if (!isPng(bytes)) throw new ComfyError(`ComfyUI sent a ${total}-byte file that is not a PNG`)
    return bytes
  }

  /** Stop prompt `id` if it is the one running (targeted on current ComfyUI). */
  async interrupt(id: string): Promise<void> {
    const res = await this.post('/interrupt', { prompt_id: id }, this.timeouts.control)
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /interrupt with HTTP ${res.status}`)
  }

  /** Remove prompts from ComfyUI's pending queue by exact id. */
  async dequeue(ids: string[]): Promise<void> {
    const res = await this.post('/queue', { delete: ids }, this.timeouts.control)
    if (!res.ok) throw new ComfyError(`ComfyUI at ${this.host} answered /queue with HTTP ${res.status}`)
  }
}

/** The one-line reason for a 400 from POST /prompt, cut to 300 characters. */
function refusalReason(body: unknown): string {
  const err = isObj(body) ? body.error : undefined
  const head = typeof err === 'string' ? err : isObj(err) && typeof err.message === 'string' ? err.message : 'no reason given'
  let reason = `ComfyUI refused the workflow: ${head}`
  const nodeErrors = isObj(body) && isObj(body.node_errors) ? body.node_errors : {}
  for (const id of Object.keys(nodeErrors)) {
    const ne = nodeErrors[id]
    if (!isObj(ne)) continue
    const first = Array.isArray(ne.errors) && isObj(ne.errors[0]) ? ne.errors[0] : null
    const cls = typeof ne.class_type === 'string' ? ne.class_type : 'unknown node'
    const msg = first && typeof first.message === 'string' ? first.message : 'error'
    const details = first && typeof first.details === 'string' && first.details ? `: ${first.details}` : ''
    reason += `; node ${id} (${cls}): ${msg}${details}`
    break
  }
  return reason.length > 300 ? reason.slice(0, 299) + '…' : reason
}

// ─── the probe ────────────────────────────────────────────────────────

/**
 * A good probe carries `checkpoints`, the server's `/models/checkpoints` list as sent (strings only), when the workflow
 * has `{{checkpoint}}`; `runJob` checks the checkpoint a picture was keyed on against it before the POST (F179).
 */
export type ProbeResult =
  | { ok: true; version: string; device: string; vramGB: number | null; checkpoint: string | null; picked: boolean; checkpointCount: number; checkpoints?: string[] }
  | { ok: false; reason: string }

function sample(list: string[]): string {
  return list.length ? list.slice(0, 10).join(', ') + (list.length > 10 ? ', …' : '') : 'none'
}

/**
 * Can this server paint with this config? System stats, then the checkpoint
 * (only when the workflow has `{{checkpoint}}`: a configured name must be
 * listed exactly; otherwise the alphabetically first /juggernaut/i, else /xl/i;
 * a good answer then carries the list), then every node class the workflow
 * uses. Never throws.
 */
export async function probeComfy(cfg: ComfyConfig, fetchFn: typeof fetch = fetch, timeouts: Partial<ClientTimeouts> = {}): Promise<ProbeResult> {
  try {
    const client = new ComfyClient(cfg.url, fetchFn, timeouts)
    const stats = await client.systemStats()
    let checkpoint: string | null = null, picked = false, checkpointCount = 0, checkpoints: string[] | null = null
    if (cfg.workflow.usesCheckpoint) {
      const list = await client.checkpoints()
      checkpointCount = list.length
      checkpoints = list
      if (cfg.checkpoint) {
        if (!list.includes(cfg.checkpoint)) return { ok: false, reason: `ComfyUI at ${client.host} has no checkpoint "${cfg.checkpoint}" (it has: ${sample(list)})` }
        checkpoint = cfg.checkpoint
      } else {
        const sorted = [...list].sort()
        checkpoint = sorted.find(n => /juggernaut/i.test(n)) ?? sorted.find(n => /xl/i.test(n)) ?? null
        if (!checkpoint) return { ok: false, reason: `ComfyUI at ${client.host} has no SDXL checkpoint to pick (it has: ${sample(list)}); set LOCALCODE_COMFYUI_CHECKPOINT, or LOCALCODE_COMFYUI_WORKFLOW for another model family` }
        picked = true
      }
    }
    for (const cls of workflowClasses(cfg.workflow.graph)) {
      if (!(await client.hasNode(cls))) return { ok: false, reason: `ComfyUI at ${client.host} has no "${cls}" node, which the workflow uses — install it or change the workflow` }
    }
    return { ok: true, ...stats, checkpoint, picked, checkpointCount, ...(checkpoints ? { checkpoints } : {}) }
  } catch (e) {
    if (e instanceof ComfyError) return { ok: false, reason: e.reason }
    console.log(`[imagegen] probe of ${cfg.url} failed unexpectedly: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    return { ok: false, reason: `checking ComfyUI at ${cfg.host} failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
