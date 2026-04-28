import type { Provider, CompletionRequest, CompletionResponse, ModelCapabilities, ModelInfo, StreamEvent } from '../provider.js'
import { toOpenAIMessages, toOpenAITools, fromOpenAIStreamChunk, parseSSELine, fromOpenAIResponse } from '../ollama/format.js'
import { resolveCapabilities } from '../ollama/probe.js'

export type OpenAICompatConfig = {
  name: string
  baseUrl: string
  apiKey: string
  modelsEndpoint?: string   // default: /v1/models
}

export class OpenAICompatProvider implements Provider {
  readonly name: string
  private baseUrl: string
  private apiKey: string
  private modelsEndpoint: string

  constructor(config: OpenAICompatConfig) {
    this.name = config.name
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.modelsEndpoint = config.modelsEndpoint ?? '/v1/models'
  }

  getCompletionsUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`
  }

  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`
    return headers
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}${this.modelsEndpoint}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch { return false }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(`${this.baseUrl}${this.modelsEndpoint}`, { headers: this.getHeaders() })
      const data = await resp.json() as { data: Array<{ id: string }> }
      return (data.data ?? []).map(m => ({
        name: m.id,
        size_bytes: 0,
        capabilities: resolveCapabilities(m.id),
      }))
    } catch { return [] }
  }

  async probeCapabilities(model: string): Promise<ModelCapabilities> {
    return resolveCapabilities(model)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request)
    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ ...body, stream: true }),
    })

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
        const parsed = parseSSELine(trimmed)
        if (parsed === null) break
        if (parsed === undefined) continue
        const events = fromOpenAIStreamChunk(parsed as any)
        for (const event of events) yield event
      }
    }

    yield { type: 'message_stop' }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request)
    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    })
    return fromOpenAIResponse(await resp.json() as any)
  }

  private buildRequestBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
    }
    if (request.max_tokens) body.max_tokens = request.max_tokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools?.length) body.tools = toOpenAITools(request.tools)
    if (request.system) {
      body.messages = [{ role: 'system', content: request.system }, ...(body.messages as any[])]
    }
    return body
  }
}
