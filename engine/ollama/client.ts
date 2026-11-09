/**
 * OllamaProvider — implements the Provider interface for Ollama.
 *
 * Uses Ollama's OpenAI-compatible /v1/chat/completions endpoint for
 * generation and the native /api/tags, /api/pull endpoints for model
 * management.
 */

import type { CompletionResponse, StreamEvent } from '../types.js'
import type { Provider, CompletionRequest, ModelCapabilities, ModelInfo, PullProgress } from '../provider.js'
import { toOpenAIMessages, toOpenAITools, fromOpenAIResponse, fromOpenAIStreamChunk, parseSSELine, mapFinishReason } from './format.js'
import { resolveCapabilities } from './probe.js'
import { GenerationError, ModelNotFoundError } from './errors.js'

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class OllamaProvider implements Provider {
  readonly name = 'ollama'
  private baseUrl: string
  private fetchFn: FetchFn
  private contextLength: number

  constructor({ baseUrl, fetchFn, contextLength }: { baseUrl: string; fetchFn?: FetchFn; contextLength?: number }) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // strip trailing slash
    this.fetchFn = fetchFn ?? globalThis.fetch
    this.contextLength = contextLength ?? 0
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.fetchFn(`${this.baseUrl}/`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const resp = await this.fetchFn(`${this.baseUrl}/api/tags`)
    const data = await resp.json() as { models: Array<{ name: string; size: number; modified_at: string }> }

    return data.models.map(m => ({
      name: m.name,
      size_bytes: m.size,
      capabilities: resolveCapabilities(m.name),
    }))
  }

  async probeCapabilities(model: string): Promise<ModelCapabilities> {
    return resolveCapabilities(model)
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false)
    const resp = await this.postChat(body)
    if (!resp.ok) throw await this.httpError(resp, request.model)
    const oai = await resp.json()
    return fromOpenAIResponse(oai as any)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request, true)
    const resp = await this.postChat(body)

    // Errors must THROW, not silently end the stream — the llama path's
    // 2026-06-12 lesson, repeated here (GLM review O1). Ollama answers a model
    // it does not have with 404 and an OpenAI-shaped error body; read as SSE
    // that body has no `data:` lines, so this path yielded message_start, no
    // deltas, message_stop — an empty reply on the first turn after a fresh
    // install, when the fix is one `ollama pull`.
    if (!resp.ok) throw await this.httpError(resp, request.model)

    // Emit message_start
    yield {
      type: 'message_start',
      message: {
        id: '',
        model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
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
      buffer = lines.pop() ?? '' // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const parsed = parseSSELine(trimmed)
        if (parsed === null) break // [DONE]
        if (parsed === undefined) continue // non-data line

        const events = fromOpenAIStreamChunk(parsed as any)
        for (const event of events) {
          yield event
        }
      }
    }

    // Emit message_stop
    yield { type: 'message_stop' }
  }

  private postChat(body: Record<string, unknown>): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * The typed error for a non-2xx chat response. A 404 whose body talks about
   * a model is Ollama's "model not found": `ModelNotFoundError` names the
   * model, what is installed (best effort — the hint must not depend on a
   * second request succeeding) and the `ollama pull` command. Everything else
   * is a `GenerationError` spelled `Ollama HTTP <status>: <detail>`, the same
   * shape as the llama path, because `callModel.isRetryableError` reads
   * `HTTP 503` + `Loading model` off the message to wait out a load window.
   */
  private async httpError(resp: Response, model: string): Promise<Error> {
    let detail = ''
    try {
      detail = (await resp.text()).slice(0, 500)
    } catch (err) {
      console.log(`[ollama] could not read the HTTP ${resp.status} error body: ${err instanceof Error ? err.message : String(err)}`)
    }
    const message = parseErrorMessage(detail) ?? detail
    if (resp.status === 404 && /model/i.test(message)) {
      let available: string[] = []
      try {
        available = (await this.listModels()).map(m => m.name)
      } catch (err) {
        console.log(`[ollama] could not list models for the not-found hint: ${err instanceof Error ? err.message : String(err)}`)
      }
      return new ModelNotFoundError(model, available)
    }
    return new GenerationError(`Ollama HTTP ${resp.status}: ${message || resp.statusText}`)
  }

  async *pullModel(name: string): AsyncIterable<PullProgress> {
    const resp = await this.fetchFn(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })

    const text = await resp.text()
    const lines = text.split('\n').filter(l => l.trim())

    for (const line of lines) {
      try {
        const progress = JSON.parse(line) as PullProgress
        yield progress
      } catch {
        // skip unparseable lines
      }
    }
  }

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream,
    }

    if (request.max_tokens) body.max_tokens = request.max_tokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop_sequences) body.stop = request.stop_sequences
    if (request.tools?.length) body.tools = toOpenAITools(request.tools)
    if (request.system) {
      // Prepend system message
      body.messages = [
        { role: 'system', content: request.system },
        ...(body.messages as unknown[]),
      ]
    }

    // Set context window size for Ollama — use the model's full capability
    // Without this, Ollama defaults to 32K regardless of model support
    const numCtx = this.contextLength || 0
    if (numCtx > 32768) {
      body.options = { num_ctx: numCtx }
    }

    // Tier-1 uncertainty trace (Brain): default-on. Ollama's OAI-compat layer
    // ignores unknown sampling fields; llama-server honors them.
    if (stream) {
      body.logprobs = true
      body.top_logprobs = 8
    }

    return body
  }
}

/** `{"error":{"message":"..."}}` or `{"error":"..."}` -> the message; anything else -> null. */
function parseErrorMessage(detail: string): string | null {
  let parsed: { error?: { message?: unknown } | string }
  try {
    parsed = JSON.parse(detail)
  } catch {
    return null // not JSON: the raw text is the detail
  }
  if (typeof parsed?.error === 'string') return parsed.error
  if (typeof parsed?.error?.message === 'string') return parsed.error.message
  return null
}
