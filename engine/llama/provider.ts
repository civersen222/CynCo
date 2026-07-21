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
}

/** Maximum number of entries stored in the countTokens memoization cache. */
export const COUNT_TOKENS_CACHE_BOUND = 512

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

  constructor(config: LlamaCppProviderConfig & { tokenCacheBound?: number }) {
    this.primaryUrl = config.primaryUrl.replace(/\/$/, '')
    this.adapterUrl = config.adapterUrl?.replace(/\/$/, '')
    this.modelName = config.modelName
    this.modelsDir = config.modelsDir
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
    const body = this.buildRequestBody(request, false)
    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const oai = await resp.json()
    return fromOpenAIResponse(oai as any)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    let body = this.buildRequestBody(request, true)

    let resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    // Errors must THROW, not silently end the stream. 2026-06-12 incident:
    // llama-server rejected an oversized request (context overflow) but this
    // path ignored resp.ok — every turn became a silent 0-token end_turn.
    if (!resp.ok) {
      let detail = ''
      try { detail = (await resp.text()).slice(0, 500) } catch {}
      // Stock llama-server (≥b9529) rejects logprobs with tools + stream.
      // The entropy trace (Brain Tier 1) must degrade, not fail the whole
      // turn: drop logprobs for the rest of the session and retry once.
      if (body.logprobs && resp.status === 400 && /logprobs/i.test(detail)) {
        this.logprobsUnsupported = true
        console.log(`[llama-cpp] server rejects logprobs — entropy trace disabled for this session (${detail})`)
        body = this.buildRequestBody(request, true)
        resp = await fetch(this.getCompletionsUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        detail = ''
        try { if (!resp.ok) detail = (await resp.text()).slice(0, 500) } catch {}
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

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
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
  async countTokens(text: string): Promise<number> {
    if (text.length === 0) return 0

    const cached = this.tokenCache.get(text)
    if (cached !== undefined) return cached

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
      body.tool_choice = 'auto'
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

    // Tier-1 uncertainty trace (Brain): default-on. Ollama's OAI-compat layer
    // ignores unknown sampling fields; llama-server honors them. Skipped once
    // the server has rejected the combination (stock ≥b9529 with tools+stream).
    if (stream && !this.logprobsUnsupported) {
      body.logprobs = true
      body.top_logprobs = 8
    }

    return body
  }
}
