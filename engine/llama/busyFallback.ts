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
 * primary (today's path). A one-shot holds `gpu-busy.json` and our server is
 * cold → if the fallback answers a bounded health check, the request goes there
 * with `model` rewritten and the chat is told once per one-shot through the same
 * `onWaiting` channel as the busy notice; if the fallback is down, the primary
 * waits exactly as before. `countTokens` follows the route because the primary
 * tokenizer would itself wait on the busy GPU. Everything else (adapters,
 * capability probe, listModels, `processManager` for main.ts) is the primary's.
 * Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 2b).
 */
import type { CompletionRequest, ModelCapabilities, ModelInfo, Provider } from '../provider.js'
import type { CompletionResponse, StreamEvent } from '../types.js'
import type { GpuBusy } from '../daemon/gpuBusyFile.js'
import { abortError } from './processManager.js'

export type FallbackSettings = { url: string | null; model: string }

const DEFAULT_FALLBACK_MODEL = 'qwen3:14b'
const HEALTH_TIMEOUT_MS = 2000

export function fallbackSettings(env: NodeJS.ProcessEnv = process.env): FallbackSettings {
  const raw = (env.LOCALCODE_FALLBACK_URL ?? '').trim()
  const model = (env.LOCALCODE_FALLBACK_MODEL ?? '').trim() || DEFAULT_FALLBACK_MODEL
  return { url: raw ? raw.replace(/\/+$/, '') : null, model }
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
    const busy = this.deps.readBusy()
    if (!busy || this.deps.primaryWarm()) return this.deps.primary
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
      this.deps.log(`[fallback] GPU busy with ${busy.triggerId} and the fallback at ${this.deps.fallbackLabel} is not answering — waiting on the GPU as usual`)
      return this.deps.primary
    }
    if (this.noticedTrigger !== busy.triggerId) {
      this.noticedTrigger = busy.triggerId
      const rem = this.deps.remainingMs(busy)
      const mins = rem === null ? '?' : String(Math.max(1, Math.ceil(rem / 60000)))
      this.deps.notify(`GPU busy with ${busy.task} (${busy.triggerId}) — about ${mins} min left; answering on ${this.deps.fallbackModel} at ${this.deps.fallbackLabel} meanwhile`)
    }
    return this.deps.fallback
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
