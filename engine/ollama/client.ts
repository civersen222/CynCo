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
import { ConnectionError } from './errors.js'

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
    const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const oai = await resp.json()
    return fromOpenAIResponse(oai as any)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request, true)

    // Diagnostic: dump request to file for debugging
    try {
      const fs = require('fs')
      const path = require('path')
      const debugDir = path.join(process.cwd(), '.cynco-http-debug.json')
      fs.writeFileSync(debugDir, JSON.stringify({
        timestamp: new Date().toISOString(),
        url: `${this.baseUrl}/v1/chat/completions`,
        messageCount: (body.messages as any[])?.length ?? 0,
        hasTools: !!(body as any).tools,
        toolCount: ((body as any).tools as any[])?.length ?? 0,
        systemPromptLength: ((body.messages as any[])?.[0]?.content as string)?.length ?? 0,
        lastMessageRole: (body.messages as any[])?.[(body.messages as any[]).length - 1]?.role,
        lastMessageContent: JSON.stringify((body.messages as any[])?.[(body.messages as any[]).length - 1]?.content)?.slice(0, 300),
        // Dump first and last message for inspection
        firstMessage: (body.messages as any[])?.[0],
        model: body.model,
        temperature: body.temperature,
      }, null, 2))
    } catch {}

    const resp = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    // Diagnostic: log response status
    console.log(`[ollama] HTTP ${resp.status} for ${(body.messages as any[])?.length ?? 0} messages, ${((body as any).tools as any[])?.length ?? 0} tools`)

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
    let chunkCount = 0
    let rawChunks: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Diagnostic: capture raw SSE lines
        rawChunks.push(trimmed)
        chunkCount++

        const parsed = parseSSELine(trimmed)
        if (parsed === null) break // [DONE]
        if (parsed === undefined) continue // non-data line

        const events = fromOpenAIStreamChunk(parsed as any)
        for (const event of events) {
          yield event
        }
      }
    }

    // Diagnostic: dump response info
    console.log(`[ollama] Stream complete: ${chunkCount} chunks`)
    // Dump raw SSE to file for analysis
    try {
      const fs = require('fs')
      const path = require('path')
      fs.writeFileSync(
        path.join(process.cwd(), '.cynco-sse-debug.json'),
        JSON.stringify({ chunkCount, rawChunks: rawChunks.map(c => c.slice(0, 500)) }, null, 2)
      )
    } catch {}

    // Emit message_stop
    yield { type: 'message_stop' }
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

    return body
  }
}
