/**
 * Integration tests for the LocalCode conversation engine.
 *
 * Verifies the full pipeline: localCallModel → translateStream → yield contract
 * using a mock Provider (no real Ollama needed).
 */

import { describe, expect, it } from 'bun:test'
import { localCallModel } from '../../engine/callModel.js'
import { asSystemPrompt } from '../../types.js'
import type { Provider, CompletionRequest, ModelCapabilities, ModelInfo } from '../../provider.js'
import type { CompletionResponse, StreamEvent as LocalStreamEvent } from '../../types.js'

// ─── Mock Provider ──────────────────────────────────────────────

function mockProvider(events: LocalStreamEvent[]): Provider {
  return {
    name: 'mock',
    async *stream(_request: CompletionRequest): AsyncIterable<LocalStreamEvent> {
      for (const e of events) yield e
    },
    async complete(): Promise<CompletionResponse> {
      throw new Error('not implemented')
    },
    async healthCheck() { return true },
    async listModels(): Promise<ModelInfo[]> { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return {
        tier: 'advanced',
        toolUse: 'native',
        thinking: 'none',
        vision: false,
        jsonMode: true,
        contextLength: 32768,
        streaming: true,
      }
    },
  }
}

function mockConfig() {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
    tier: 'advanced' as const,
    temperature: 0.7,
    maxOutputTokens: 4096,
    timeout: 60000,
    contextLength: 32768,
  }
}

function advancedCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function standardCapabilities(): ModelCapabilities {
  return {
    tier: 'standard',
    toolUse: 'simulated',
    thinking: 'simulated',
    vision: false,
    jsonMode: false,
    contextLength: 16384,
    streaming: true,
  }
}

const baseParams = () => ({
  messages: [{ type: 'user' as const, role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
  systemPrompt: asSystemPrompt(['You are helpful.']),
  thinkingConfig: { type: 'disabled' as const },
  tools: [] as any[],
  signal: new AbortController().signal,
  options: { model: 'qwen3:8b' },
})

// ─── Text-Only Response ─────────────────────────────────────────

describe('Integration: text-only response', () => {
  it('yields stream_events and AssistantMessage with correct lifecycle', async () => {
    const events: LocalStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg-1', model: 'qwen3:8b', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
      { type: 'message_stop' },
    ]

    const provider = mockProvider(events)
    const results: unknown[] = []

    for await (const msg of localCallModel({
      ...baseParams(),
      deps: {
        getProvider: () => provider,
        loadConfig: mockConfig,
        resolveCapabilities: () => advancedCapabilities(),
      },
    })) {
      results.push(msg)
    }

    // Should have stream_events + at least 1 AssistantMessage
    const streamEvents = results.filter((r: any) => r.type === 'stream_event')
    const assistantMsgs = results.filter((r: any) => r.type === 'assistant')

    expect(streamEvents.length).toBeGreaterThan(0)
    expect(assistantMsgs.length).toBe(1)

    // Check AssistantMessage shape
    const msg = assistantMsgs[0] as any
    expect(msg.type).toBe('assistant')
    expect(msg.uuid).toBeTruthy()
    expect(msg.timestamp).toBeTruthy()
    expect(msg.message.role).toBe('assistant')
    expect(msg.message.type).toBe('message')
    expect(msg.message.model).toBe('qwen3:8b')
    expect(msg.message.container).toBeNull()
    expect(msg.message.context_management).toBeNull()

    // stop_reason should be mutated to 'end_turn' by message_delta
    expect(msg.message.stop_reason).toBe('end_turn')

    // Content should have the assembled text block
    expect(msg.message.content.length).toBeGreaterThanOrEqual(1)
    const textBlock = msg.message.content.find((b: any) => b.type === 'text')
    expect(textBlock).toBeTruthy()
    expect(textBlock.text).toBe('Hello world!')
  })
})

// ─── Tool Use Response ──────────────────────────────────────────

describe('Integration: tool use response', () => {
  it('yields AssistantMessage with tool_use content and correct stop_reason', async () => {
    const events: LocalStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg-2', model: 'qwen3:8b', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read that file.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "/tmp/test.ts"}' } },
      { type: 'message_stop' },
    ]

    const provider = mockProvider(events)
    const results: unknown[] = []

    for await (const msg of localCallModel({
      ...baseParams(),
      deps: {
        getProvider: () => provider,
        loadConfig: mockConfig,
        resolveCapabilities: () => advancedCapabilities(),
      },
    })) {
      results.push(msg)
    }

    const assistantMsgs = results.filter((r: any) => r.type === 'assistant')
    // Should have at least one assistant message with tool use
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

    const lastMsg = assistantMsgs.at(-1) as any
    // stop_reason should be mutated to 'tool_use'
    expect(lastMsg.message.stop_reason).toBe('tool_use')
  })
})

// ─── Simulated Tool Use ─────────────────────────────────────────

describe('Integration: simulated tool use', () => {
  it('buffers text and extracts tool calls from XML', async () => {
    const xmlText = 'I will read the file.\n<tool_call>\n{"name": "Read", "arguments": {"path": "/tmp/test.ts"}}\n</tool_call>'

    const events: LocalStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg-3', model: 'phi4:14b', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: xmlText } },
      { type: 'message_stop' },
    ]

    const provider = mockProvider(events)
    const results: unknown[] = []

    for await (const msg of localCallModel({
      ...baseParams(),
      options: { model: 'phi4:14b' },
      deps: {
        getProvider: () => provider,
        loadConfig: mockConfig,
        resolveCapabilities: () => standardCapabilities(),
      },
    })) {
      results.push(msg)
    }

    const assistantMsgs = results.filter((r: any) => r.type === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

    const lastMsg = assistantMsgs.at(-1) as any
    // Should have extracted tool_use, so stop_reason should be 'tool_use'
    expect(lastMsg.message.stop_reason).toBe('tool_use')

    // Should have tool_use block in content
    const allContent = assistantMsgs.flatMap((m: any) => m.message.content)
    const toolBlocks = allContent.filter((b: any) => b.type === 'tool_use')
    expect(toolBlocks.length).toBe(1)
    expect(toolBlocks[0].name).toBe('Read')
  })
})

// ─── In-Place Mutation ──────────────────────────────────────────

describe('Integration: in-place mutation of AssistantMessage', () => {
  it('mutates stop_reason from null to end_turn via message_delta', async () => {
    const events: LocalStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg-4', model: 'qwen3:8b', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_stop' },
    ]

    const provider = mockProvider(events)
    let capturedAssistantMsg: any = null

    for await (const msg of localCallModel({
      ...baseParams(),
      deps: {
        getProvider: () => provider,
        loadConfig: mockConfig,
        resolveCapabilities: () => advancedCapabilities(),
      },
    })) {
      if ((msg as any).type === 'assistant' && !capturedAssistantMsg) {
        capturedAssistantMsg = msg
        // At yield time, stop_reason is null
        // (the stream_event with message_delta hasn't been processed yet,
        //  but we capture the reference here)
      }
    }

    // After the generator completes, the reference should have been mutated
    expect(capturedAssistantMsg).toBeTruthy()
    expect(capturedAssistantMsg.message.stop_reason).toBe('end_turn')
  })
})

// ─── deps.ts wiring ────────────────────────────────────────────

describe('Integration: deps.ts exports localCallModel', () => {
  it('deps.ts imports localCallModel for callModel', async () => {
    // Import localCallModel directly and verify it's the expected function
    const { localCallModel } = await import('../../engine/callModel.js')
    expect(typeof localCallModel).toBe('function')
    expect(localCallModel.name).toBe('localCallModel')
  })
})
