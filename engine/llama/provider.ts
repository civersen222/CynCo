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

export type LlamaCppProviderConfig = {
  primaryUrl: string
  adapterUrl?: string
  modelName: string
  modelsDir: string
  adaptersDir?: string
  processManager?: ProcessManager
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

  constructor(config: LlamaCppProviderConfig) {
    this.primaryUrl = config.primaryUrl.replace(/\/$/, '')
    this.adapterUrl = config.adapterUrl?.replace(/\/$/, '')
    this.modelName = config.modelName
    this.modelsDir = config.modelsDir
    this.adaptersDir = config.adaptersDir ?? path.join(path.dirname(config.modelsDir), 'adapters')
    this.processManager = config.processManager
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
    const body = this.buildRequestBody(request, true)

    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
        if (parsed === null) break // [DONE]
        if (parsed === undefined) continue
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
    if (request.tools?.length) body.tools = toOpenAITools(request.tools)
    if (request.system) {
      body.messages = [
        { role: 'system', content: request.system },
        ...(body.messages as unknown[]),
      ]
    }

    return body
  }
}
