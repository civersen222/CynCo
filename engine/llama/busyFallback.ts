/**
 * engine/llama/busyFallback.ts — wakefulness slice 2b: while a daemon one-shot
 * owns the 5090, a lazy engine answers on the secondary box instead of waiting.
 *
 * Two switches, read here and nowhere else:
 *   LOCALCODE_FALLBACK_URL     an Ollama base URL on another box (unset = off).
 *                              The 4070 Ti Super box already serves Ollama for
 *                              ComfyUI's neighbours, so the existing OllamaProvider
 *                              is the fallback — no llama-server to install there.
 *   LOCALCODE_FALLBACK_MODEL   the model to ask for there (default qwen3:14b:
 *                              9.3 GB Q4_K_M, native tools, fits 16 GB).
 *
 * Routing, decided per request: GPU free, or our own server already warm → the
 * primary (today's path). Our server is cold and something holds the GPU that
 * the lazy wait would wait on → if the fallback answers a bounded health check,
 * the request goes there with `model` rewritten and the chat is told once per
 * holder through the same `onWaiting` channel as the busy notice; if the
 * fallback is down, the primary waits exactly as before. "Something the lazy
 * wait would wait on" is a one-shot named by `gpu-busy.json`, or (F213) a
 * healthy server on the model port that is another engine's or whose owner
 * cannot be read: a dispatched mission's engine holds the port for hours with
 * no busy file, and a chat turn waited up to 30 minutes behind it with no
 * answer at all. A server that is not CynCo's is not such a holder: the lazy
 * path takes the port from it (F202). `countTokens` follows the route because
 * the primary tokenizer would itself wait on the busy GPU. Everything else
 * (adapters, capability probe, listModels, `processManager` for main.ts) is the
 * primary's. Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 2b).
 */
import type { CompletionRequest, ModelCapabilities, ModelInfo, Provider } from '../provider.js'
import type { CompletionResponse, StreamEvent } from '../types.js'
import type { GpuBusy } from '../daemon/gpuBusyFile.js'
import { abortError } from './processManager.js'
import type { PortOwner } from './portOwner.js'

export type FallbackSettings = { url: string | null; model: string }

const DEFAULT_FALLBACK_MODEL = 'qwen3:14b'
const HEALTH_TIMEOUT_MS = 2000

export function fallbackSettings(env: NodeJS.ProcessEnv = process.env): FallbackSettings {
  const raw = (env.LOCALCODE_FALLBACK_URL ?? '').trim()
  const model = (env.LOCALCODE_FALLBACK_MODEL ?? '').trim() || DEFAULT_FALLBACK_MODEL
  return { url: raw ? raw.replace(/\/+$/, '') : null, model }
}

/** A server on the model port that the lazy wait will wait on: `key` tells one holder from the next, `says` names it to the owner. */
export type PortHolder = { key: string; says: string }

/** How long one reading of the port's owner is trusted. A turn asks once per message it counts; the owner is a PowerShell call. */
const PORT_HOLDER_TTL_MS = 5_000

/**
 * "Does something hold the model port that the lazy wait would wait on?", asked per request.
 * The same three questions as `ProcessManager.ensureRunningLazy`, in the same order, so the two
 * cannot disagree: bound, healthy, whose. Cheap when the port is free (one connect) and when our
 * own server is up (nothing asked); the owner is read at most once per `ttlMs`, and a port found
 * free forgets it at once.
 */
export function portHolderReader(deps: {
  port: number
  /** Our own llama-server exists, loading or warm: whatever is on the port is ours. */
  ownServerUp: () => boolean
  isPortOccupied: () => Promise<boolean>
  isHealthy: () => Promise<boolean>
  portOwner: () => Promise<PortOwner>
  now?: () => number
  ttlMs?: number
}): () => Promise<PortHolder | null> {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? PORT_HOLDER_TTL_MS
  let remembered: { at: number; holder: PortHolder | null } | null = null
  return async () => {
    if (deps.ownServerUp()) { remembered = null; return null }
    if (!(await deps.isPortOccupied())) { remembered = null; return null }
    if (remembered && now() - remembered.at < ttlMs) return remembered.holder
    let holder: PortHolder | null = null
    if (await deps.isHealthy()) {
      const owner = await deps.portOwner()
      if (owner.owner === 'engine') holder = { key: owner.detail, says: `another CynCo engine's model server (${owner.detail})` }
      else if (owner.owner === 'unknown') holder = { key: `unknown:${deps.port}`, says: `a model server on port ${deps.port} whose owner could not be read` }
    }
    remembered = { at: now(), holder }
    return holder
  }
}

export type BusyFallbackDeps = {
  primary: Provider
  fallback: Provider
  fallbackModel: string
  /** How the chat names the box, e.g. `192.168.0.47:11434`. */
  fallbackLabel: string
  /** The one-shot that owns the GPU right now, or null (gpu-busy.json). */
  readBusy: () => GpuBusy | null
  remainingMs: (busy: GpuBusy) => number | null
  /** Our own llama-server is up: never leave it for the fallback. */
  primaryWarm: () => boolean
  /** A server on the model port the lazy wait would wait on, with no one-shot (`portHolderReader`, F213). Absent: only a one-shot routes away. */
  readPortHolder?: () => Promise<PortHolder | null>
  fallbackHealthy: () => Promise<boolean>
  /** The busy-notice channel (ProcessManager.onWaiting → governance.alert → the chat). */
  notify: (message: string) => void
  log: (line: string) => void
}

export class BusyFallbackProvider implements Provider {
  readonly name: string
  private noticedTrigger: string | null = null

  constructor(private readonly deps: BusyFallbackDeps) {
    this.name = deps.primary.name
  }

  /** main.ts reaches the llama ProcessManager through `provider.processManager`; keep that path. */
  get processManager(): unknown {
    return (this.deps.primary as unknown as { processManager?: unknown }).processManager
  }

  private async route(): Promise<Provider> {
    if (this.deps.primaryWarm()) return this.deps.primary
    const busy = this.deps.readBusy()
    // The busy file is the answer when there is one; the port is asked about only without it.
    const holder = busy ? null : await this.readPortHolder()
    if (!busy && !holder) return this.deps.primary
    const who = busy ? `GPU busy with ${busy.triggerId}` : `the model port is held by ${holder!.says}`
    let healthy = false
    try {
      healthy = await Promise.race([
        this.deps.fallbackHealthy(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS)),
      ])
    } catch (e) {
      this.deps.log(`[fallback] health check threw (${e instanceof Error ? e.message : String(e)})`)
    }
    if (!healthy) {
      this.deps.log(`[fallback] ${who} and the fallback at ${this.deps.fallbackLabel} is not answering — waiting on the GPU as usual`)
      return this.deps.primary
    }
    const key = busy ? busy.triggerId : `port:${holder!.key}`
    if (this.noticedTrigger !== key) {
      this.noticedTrigger = key
      if (busy) {
        const rem = this.deps.remainingMs(busy)
        const mins = rem === null ? '?' : String(Math.max(1, Math.ceil(rem / 60000)))
        this.deps.notify(`GPU busy with ${busy.task} (${busy.triggerId}) — about ${mins} min left; answering on ${this.deps.fallbackModel} at ${this.deps.fallbackLabel} meanwhile`)
      } else {
        // Nobody knows when a mission or a second engine lets go of the port: no minutes are promised.
        this.deps.notify(`The model port is held by ${holder!.says}; answering on ${this.deps.fallbackModel} at ${this.deps.fallbackLabel} until it is free`)
      }
    }
    return this.deps.fallback
  }

  /** A reader that throws is a port nobody could be asked about: the primary's own wait decides, as before. */
  private async readPortHolder(): Promise<PortHolder | null> {
    if (!this.deps.readPortHolder) return null
    try {
      return await this.deps.readPortHolder()
    } catch (e) {
      this.deps.log(`[fallback] could not ask who holds the model port (${e instanceof Error ? e.message : String(e)})`)
      return null
    }
  }

  private forFallback(request: CompletionRequest): CompletionRequest {
    return { ...request, model: this.deps.fallbackModel }
  }

  // A stopped turn is not routed (F205): `route` asks the fallback box for health and waits up to
  // HEALTH_TIMEOUT_MS when it is down, once per call, and a turn makes one call per message it counts.
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (request.signal?.aborted) throw abortError(request.signal)
    const p = await this.route()
    return p === this.deps.fallback ? p.complete(this.forFallback(request)) : p.complete(request)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (request.signal?.aborted) throw abortError(request.signal)
    const p = await this.route()
    yield* p === this.deps.fallback ? p.stream(this.forFallback(request)) : p.stream(request)
  }

  async countTokens(text: string, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Math.ceil(text.length / 4)
    const p = await this.route()
    if (p.countTokens) return p.countTokens(text, signal)
    return Math.ceil(text.length / 4)
  }

  listModels(): Promise<ModelInfo[]> { return this.deps.primary.listModels() }
  probeCapabilities(model: string): Promise<ModelCapabilities> { return this.deps.primary.probeCapabilities(model) }
  healthCheck(): Promise<boolean> { return this.deps.primary.healthCheck() }
  loadAdapter(adapterId: string): Promise<void> { return this.deps.primary.loadAdapter ? this.deps.primary.loadAdapter(adapterId) : Promise.resolve() }
  unloadAdapter(): Promise<void> { return this.deps.primary.unloadAdapter ? this.deps.primary.unloadAdapter() : Promise.resolve() }
  activeAdapter(): string | null { return this.deps.primary.activeAdapter ? this.deps.primary.activeAdapter() : null }
}
