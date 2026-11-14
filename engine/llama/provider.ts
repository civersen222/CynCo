// engine/llama/provider.ts
import type {
  Provider, CompletionRequest, ModelCapabilities, ModelInfo,
} from '../provider.js'
import type { CompletionResponse, StreamEvent } from '../types.js'
import {
  toOpenAIMessages, toOpenAITools, fromOpenAIResponse,
  fromOpenAIStreamChunk, parseSSELine,
} from '../ollama/format.js'
import { resolveCapabilities } from '../ollama/probe.js'
import type { ProcessManager } from './processManager.js'
import { activity, type ActivityRegistry } from '../power/activity.js'
import { resolveAdapter } from './modelResolver.js'
import * as fs from 'fs'
import * as path from 'path'

/** Pull a human-readable message out of an SSE error payload (string or {message}). */
function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') {
    try { err = JSON.parse(err) } catch { return err as string }
  }
  const msg = (err as any)?.message
  return typeof msg === 'string' ? msg : JSON.stringify(err)
}

export type LlamaCppProviderConfig = {
  primaryUrl: string
  adapterUrl?: string
  modelName: string
  modelsDir: string
  adaptersDir?: string
  processManager?: ProcessManager
  /** Lazy load (LOCALCODE_LLAMA_LAZY): awaited before every request; undefined = the server is up from boot. */
  ensureReady?: (signal?: AbortSignal) => Promise<void>
  /** Where in-flight requests register as activity (idle unload, hold-awake). Default: the process-wide registry. */
  activity?: ActivityRegistry
  /** Ask for per-token top-8 logprobs (Brain tier-1 trace). Default true; the
   *  bootstrap turns it off for one-shots and unattended missions, where it
   *  costs ~60% of decode speed and nothing reads it (missionEnv.ts). */
  uncertaintyTrace?: boolean
  /** F235: the stall limits (`STREAM_FIRST_BYTE_MS`, `STREAM_IDLE_MS`); tests set them in milliseconds. */
  streamFirstByteMs?: number
  streamIdleMs?: number
  /** F235: called once when a stream is cut for silence, before the error is thrown. The bootstrap
   *  stops (lazy) or restarts (eager) the server that stalled: a server that wedged a slot once is not
   *  trusted with the next request. Never awaited by the stream. */
  onStreamStall?: (err: StreamStalledError) => void
}

/** Maximum number of entries stored in the countTokens memoization cache. */
export const COUNT_TOKENS_CACHE_BOUND = 512

/**
 * F235: how long a streamed request may go without a byte from llama-server
 * before it is cut. Two phases, because the server is silent for two
 * different reasons:
 *
 * - Before the first byte it is processing the prompt: llama-server answers a
 *   streamed request only once its first token exists. A cold 131k-token
 *   prefill on this PC runs about 1,400 tokens/s, under two minutes, so twenty
 *   is far past anything legitimate. The lazy model load is NOT inside this
 *   clock: `ensureReady` runs first and has its own wait (`maxWaitMs`).
 * - After the first byte it is generating, a chunk every ~12 ms at ~80 tokens/s.
 *   Ten minutes without one is a server that has stopped. On 2026-11-14 the t5
 *   wave's generation finished its thinking, sent one token of its answer and
 *   then nothing for 73 minutes, holding its only slot, and nothing timed out.
 *
 * A cut aborts the request (llama-server cancels a task whose client has gone,
 * which frees the slot) and throws a non-retryable `StreamStalledError`, so the
 * turn ends through the loop's error path (`session.error`) instead of waiting
 * out a mission's wall clock.
 */
export const STREAM_FIRST_BYTE_MS = 20 * 60_000
export const STREAM_IDLE_MS = 10 * 60_000

/** A streamed request that llama-server stopped answering (F235). Deliberately no `code`: never retried. */
export class StreamStalledError extends Error {
  constructor(readonly phase: 'first-byte' | 'mid-stream', readonly silentMs: number) {
    super(phase === 'first-byte'
      ? `llama-server sent nothing for ${Math.round(silentMs / 1000)}s after the request (no first token); the request was cancelled (F235)`
      : `llama-server stopped sending mid-reply: nothing for ${Math.round(silentMs / 1000)}s; the request was cancelled (F235)`)
    this.name = 'StreamStalledError'
  }
}

/**
 * The stall clock for one streamed request: its own abort signal (also
 * aborted by the caller's, so a Stop still ends it), armed with the first-byte
 * limit and re-armed with the idle limit on every chunk. `stalled` says which
 * limit fired, so a rejection can be told apart from a Stop.
 */
class StreamWatchdog {
  private readonly ctrl = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly onParentAbort: () => void
  stalled: StreamStalledError | null = null

  constructor(private readonly parent: AbortSignal | undefined, private readonly firstByteMs: number, private readonly idleMs: number) {
    this.onParentAbort = () => this.ctrl.abort(parent?.reason)
    if (parent?.aborted) this.ctrl.abort(parent.reason)
    else parent?.addEventListener('abort', this.onParentAbort, { once: true })
  }

  get signal(): AbortSignal { return this.ctrl.signal }

  private arm(ms: number, phase: 'first-byte' | 'mid-stream'): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.stalled = new StreamStalledError(phase, ms)
      console.log(`[llama-cpp] ${this.stalled.message}`)
      this.ctrl.abort(this.stalled)
    }, ms)
  }

  /** Before each request is sent. */
  waitFirstByte(): void { this.arm(this.firstByteMs, 'first-byte') }
  /** On every chunk of the body. */
  sawData(): void { this.arm(this.idleMs, 'mid-stream') }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.parent?.removeEventListener('abort', this.onParentAbort)
  }
}

export class LlamaCppProvider implements Provider {
  readonly name = 'llama-cpp'
  private primaryUrl: string
  private adapterUrl: string | undefined
  private activeAdapterId: string | null = null
  private modelName: string
  private modelsDir: string
  private adaptersDir: string
  private processManager: ProcessManager | undefined
  /** Memoization cache: text → token count. FIFO eviction when over COUNT_TOKENS_CACHE_BOUND. */
  private tokenCache: Map<string, number> = new Map()
  private readonly tokenCacheBound: number
  /** Sticky: stock llama-server (≥b9529) rejects logprobs with tools+stream.
   *  Tier 1 must degrade, never break the turn — set on first rejection. */
  private logprobsUnsupported = false
  private readonly uncertaintyTrace: boolean
  /** Set when this server refuses tool_choice 'required'; later calls send 'auto'. */
  private toolChoiceUnsupported = false
  private readonly ensureReady: ((signal?: AbortSignal) => Promise<void>) | undefined
  private readonly activity: ActivityRegistry
  private readonly streamFirstByteMs: number
  private readonly streamIdleMs: number
  private readonly onStreamStall: ((err: StreamStalledError) => void) | undefined

  constructor(config: LlamaCppProviderConfig & { tokenCacheBound?: number }) {
    this.streamFirstByteMs = config.streamFirstByteMs ?? STREAM_FIRST_BYTE_MS
    this.streamIdleMs = config.streamIdleMs ?? STREAM_IDLE_MS
    this.onStreamStall = config.onStreamStall
    this.ensureReady = config.ensureReady
    this.activity = config.activity ?? activity
    this.primaryUrl = config.primaryUrl.replace(/\/$/, '')
    this.adapterUrl = config.adapterUrl?.replace(/\/$/, '')
    this.modelName = config.modelName
    this.modelsDir = config.modelsDir
    this.uncertaintyTrace = config.uncertaintyTrace ?? true
    this.adaptersDir = config.adaptersDir ?? path.join(path.dirname(config.modelsDir), 'adapters')
    this.processManager = config.processManager
    this.tokenCacheBound = config.tokenCacheBound ?? COUNT_TOKENS_CACHE_BOUND
  }

  // ─── URL routing ─────────────────────────────────────────────

  getBaseUrl(): string {
    if (this.activeAdapterId && this.adapterUrl) {
      return this.adapterUrl
    }
    return this.primaryUrl
  }

  getCompletionsUrl(): string {
    return `${this.getBaseUrl()}/v1/chat/completions`
  }

  // Test helpers for adapter state (not part of Provider interface)
  _setActiveAdapter(id: string): void { this.activeAdapterId = id }
  _clearActiveAdapter(): void { this.activeAdapterId = null }

  // ─── Provider interface ──────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.getBaseUrl()}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.listModelsSync()
  }

  listModelsSync(): ModelInfo[] {
    try {
      const entries = fs.readdirSync(this.modelsDir, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const modelDir = path.join(this.modelsDir, e.name)
          const files = fs.readdirSync(modelDir)
          return files.some(f => f.endsWith('.gguf'))
        })
        .map(e => ({
          name: e.name,
          capabilities: resolveCapabilities(e.name),
        }))
    } catch {
      return []
    }
  }

  async probeCapabilities(model: string): Promise<ModelCapabilities> {
    return resolveCapabilities(model)
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const end = this.activity.begin('request', 'complete')
    try {
      if (this.ensureReady) await this.ensureReady(request.signal)
      const body = this.buildRequestBody(request, false)
      const resp = await fetch(this.getCompletionsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      })
      const oai = await resp.json()
      return fromOpenAIResponse(oai as any)
    } finally {
      end()
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const end = this.activity.begin('request', 'stream')
    try {
      if (this.ensureReady) await this.ensureReady(request.signal)
      yield* this.streamBody(request)
    } finally {
      end()
    }
  }

  /**
   * F235: every streamed request runs under a stall clock (`StreamWatchdog`).
   * A cut is reported to `onStreamStall` and thrown as `StreamStalledError`; a
   * Stop (the caller's signal) and every other failure pass through unchanged.
   */
  private async *streamBody(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const watch = new StreamWatchdog(request.signal, this.streamFirstByteMs, this.streamIdleMs)
    try {
      yield* this.streamWatched(request, watch)
    } catch (err) {
      if (!watch.stalled) throw err
      try { this.onStreamStall?.(watch.stalled) } catch (e) {
        console.log(`[llama-cpp] stall recovery hook threw: ${e instanceof Error ? e.message : String(e)}`)
      }
      throw watch.stalled
    } finally {
      watch.dispose()
    }
  }

  private async *streamWatched(request: CompletionRequest, watch: StreamWatchdog): AsyncIterable<StreamEvent> {
    let body = this.buildRequestBody(request, true)

    watch.waitFirstByte()
    let resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: watch.signal,
    })

    // Errors must THROW, not silently end the stream. 2026-06-12 incident:
    // llama-server rejected an oversized request (context overflow) but this
    // path ignored resp.ok — every turn became a silent 0-token end_turn.
    if (!resp.ok) {
      let detail = ''
      try { detail = (await resp.text()).slice(0, 500) } catch (err) { console.log('[llama-cpp] could not read error body:', err) }
      // Stock llama-server (≥b9529) rejects logprobs with tools + stream.
      // The entropy trace (Brain Tier 1) must degrade, not fail the whole
      // turn: drop logprobs for the rest of the session and retry once.
      if (body.logprobs && resp.status === 400 && /logprobs/i.test(detail)) {
        this.logprobsUnsupported = true
        console.log(`[llama-cpp] server rejects logprobs — entropy trace disabled for this session (${detail})`)
        body = this.buildRequestBody(request, true)
        watch.waitFirstByte()
        resp = await fetch(this.getCompletionsUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: watch.signal,
        })
        detail = ''
        try { if (!resp.ok) detail = (await resp.text()).slice(0, 500) } catch (err) { console.log('[llama-cpp] could not read error body:', err) }
      }
      // A build that refuses tool_choice 'required' (generative-UI forcing,
      // engine/genui/intent.ts) must cost the forcing, not the turn: send
      // 'auto' for the rest of the session and retry once.
      if (!resp.ok && body.tool_choice === 'required' && resp.status === 400 && /tool_choice/i.test(detail)) {
        this.toolChoiceUnsupported = true
        console.log(`[llama-cpp] server rejects tool_choice 'required' — generative-UI forcing disabled for this session (${detail})`)
        body = this.buildRequestBody(request, true)
        watch.waitFirstByte()
        resp = await fetch(this.getCompletionsUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: watch.signal,
        })
        detail = ''
        try { if (!resp.ok) detail = (await resp.text()).slice(0, 500) } catch (err) { console.log('[llama-cpp] could not read error body:', err) }
      }
      if (!resp.ok) {
        throw new Error(`llama-server HTTP ${resp.status}: ${detail || resp.statusText}`)
      }
    }

    yield {
      type: 'message_start',
      message: { id: '', model: request.model, usage: { input_tokens: 0, output_tokens: 0 } },
    }

    const reader = resp.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    // Until the first chunk the first-byte clock (armed before the fetch) runs;
    // from then on each read waits under the idle clock, re-armed as it starts,
    // so the time the caller spends on the events yielded below never counts
    // as the server's silence.
    let gotData = false

    while (true) {
      if (gotData) watch.sawData()
      const { done, value } = await reader.read()
      if (done) break
      gotData = true
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // llama.cpp emits mid-stream errors as "error: {...}" SSE events,
        // which parseSSELine (data:-only) would silently drop.
        if (trimmed.startsWith('error:')) {
          throw new Error(`llama-server stream error: ${extractErrorMessage(trimmed.slice(6).trim())}`)
        }
        const parsed = parseSSELine(trimmed)
        if (parsed === null) break // [DONE]
        if (parsed === undefined) continue
        // Error payloads inside data: chunks have no choices[] —
        // fromOpenAIStreamChunk would return [] and the error would vanish.
        if ((parsed as any)?.error) {
          throw new Error(`llama-server stream error: ${extractErrorMessage((parsed as any).error)}`)
        }
        const events = fromOpenAIStreamChunk(parsed as any)
        for (const event of events) yield event
      }
    }

    yield { type: 'message_stop' }
    // Periodic slot KV snapshot (bounded-loss on a llama-server crash).
    this.processManager?.noteTurnComplete()
  }

  // ─── Adapter methods ─────────────────────────────────────────

  async loadAdapter(adapterId: string): Promise<void> {
    if (this.adapterUrl) {
      // Dual-machine mode: just switch URL, no restart
      this.activeAdapterId = adapterId
      console.log(`[llama-cpp] Routed adapter '${adapterId}' to ${this.adapterUrl}`)
      return
    }

    // Single-machine mode: restart server with --lora
    if (!this.processManager) {
      throw new Error('Cannot load adapter: no ProcessManager configured and no LOCALCODE_ADAPTER_URL set')
    }

    const adapterPath = resolveAdapter(adapterId, this.adaptersDir)
    console.log(`[llama-cpp] Restarting server with adapter '${adapterId}'...`)
    await this.processManager.restartWithAdapter(adapterPath)
    this.activeAdapterId = adapterId
    console.log(`[llama-cpp] Adapter '${adapterId}' loaded`)
  }

  async unloadAdapter(): Promise<void> {
    if (!this.activeAdapterId) return

    if (this.adapterUrl) {
      // Dual-machine: just switch back
      this.activeAdapterId = null
      console.log(`[llama-cpp] Routed back to primary server`)
      return
    }

    // Single-machine: restart without adapter
    if (this.processManager) {
      console.log(`[llama-cpp] Restarting server without adapter...`)
      await this.processManager.restartWithoutAdapter()
    }
    this.activeAdapterId = null
  }

  activeAdapter(): string | null {
    return this.activeAdapterId
  }

  /**
   * Count tokens using llama-server's /tokenize endpoint.
   *
   * Memoized per text string with FIFO eviction at tokenCacheBound entries.
   * Conversation messages are immutable once appended, so the cache hit rate
   * is high: only the newest message requires a network round-trip each turn.
   *
   * On any error (fetch failure, non-ok, malformed JSON): returns chars/4
   * heuristic and does NOT cache the fallback so a transient hiccup doesn't
   * poison future calls.
   */
  async countTokens(text: string, signal?: AbortSignal): Promise<number> {
    if (text.length === 0) return 0

    const cached = this.tokenCache.get(text)
    if (cached !== undefined) return cached
    if (this.ensureReady) {
      // Every model call counts its context first, so on a lazy engine this is where a turn meets the
      // wait for the model port. A Stop ends it with the heuristic, uncached; the caller's next step
      // sees the same signal (F204).
      try { await this.ensureReady(signal) } catch (e) {
        if (signal?.aborted) return Math.ceil(text.length / 4)
        throw e
      }
    }

    try {
      const resp = await fetch(`${this.getBaseUrl()}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return Math.ceil(text.length / 4)
      const data = await resp.json() as { tokens?: number[] }
      if (!Array.isArray(data.tokens)) return Math.ceil(text.length / 4)
      const count = data.tokens.length

      // FIFO eviction: Map preserves insertion order — delete the oldest key
      // when the cache would exceed the bound.
      if (this.tokenCache.size >= this.tokenCacheBound) {
        const firstKey = this.tokenCache.keys().next().value
        if (firstKey !== undefined) this.tokenCache.delete(firstKey)
      }
      this.tokenCache.set(text, count)
      return count
    } catch {
      // Never cache the fallback — transient errors must not poison the cache.
      return Math.ceil(text.length / 4)
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream,
    }

    if (request.max_tokens) body.max_tokens = request.max_tokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop_sequences) body.stop = request.stop_sequences
    if (request.tools?.length) {
      body.tools = toOpenAITools(request.tools)
      body.tool_choice = request.tool_choice === 'required' && !this.toolChoiceUnsupported ? 'required' : 'auto'
      // Per call, not just once: the loop's own lines still say the call was
      // forced, and only this one knows the server refused it.
      if (request.tool_choice === 'required' && this.toolChoiceUnsupported) console.log(`[llama-cpp] tool_choice=required NOT SENT (this server refused it earlier this session) — sent auto`)
    }
    if (request.grammar) {
      body.grammar = request.grammar
      // Lazy grammar: sample unconstrained (reasoning, prose) until the
      // trigger appears, then enforce the grammar. Without this, the text
      // rule blocks <think>/</think> and the model EOSes at 0 tokens.
      // Trigger type 2 = PATTERN (WORD requires a preserved tokenizer token).
      body.grammar_lazy = true
      body.grammar_triggers = [{ type: 2, value: '<tool_call>' }]
    }
    if (request.system) {
      body.messages = [
        { role: 'system', content: request.system },
        ...(body.messages as unknown[]),
      ]
    }

    // Tier-1 uncertainty trace (Brain): on for interactive engines, off for
    // one-shots and unattended missions (config.uncertaintyTrace, decided in
    // bootstrapProvider): top-8 logprobs per token cost 114 -> 44 tok/s on the
    // patched server. Also skipped once the server has rejected the
    // combination (stock >=b9529 with tools+stream).
    if (stream && this.uncertaintyTrace && !this.logprobsUnsupported) {
      body.logprobs = true
      body.top_logprobs = 8
    }

    if (stream) {
      // Without this llama-server sends NO usage chunk at all, every turn's
      // TurnCost stays null, and the supervision-economics ledger records the
      // whole mission as unmeasured (verified against b9529: the final chunk
      // then carries usage AND the timings block — prompt_n/predicted_n/
      // cache_n — which parseTurnCost maps to source 'server-timings').
      body.stream_options = { include_usage: true }
    }

    return body
  }
}
