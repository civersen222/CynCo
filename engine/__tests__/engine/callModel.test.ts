import { describe, expect, it } from 'bun:test'
import type { StreamEvent as LocalStreamEvent } from '../../types.js'
import type { Provider, ModelCapabilities } from '../../provider.js'
import type { LocalCodeConfig } from '../../config.js'
import { localCallModel } from '../../engine/callModel.js'
import { asSystemPrompt } from '../../types.js'

// ─── Test Helpers ───────────────────────────────────────────────

/** Minimal tool-like object matching what callModel receives. */
function makeTool(name: string, desc: string, schema?: Record<string, unknown>) {
  return {
    name,
    description: desc,
    inputJSONSchema: schema
      ? { type: 'object' as const, properties: schema }
      : { type: 'object' as const },
  }
}

/** Default capabilities for tests — advanced tier with native tool use. */
function defaultCapabilities(overrides?: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
    ...overrides,
  }
}

/** Default config for tests. */
function defaultConfig(overrides?: Partial<LocalCodeConfig>): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:32b',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: undefined,
    tools: undefined,
    ...overrides,
  }
}

/** Create a mock provider that yields given stream events. */
function createMockProvider(events: LocalStreamEvent[]): Provider {
  return {
    name: 'mock',
    async *stream() {
      for (const e of events) yield e
    },
    async complete() { throw new Error('not implemented') },
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() {
      return defaultCapabilities()
    },
  }
}

/** Collect all yielded items from an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) {
    items.push(item)
  }
  return items
}

/** Default call parameters — shorthand for tests. */
function defaultParams(overrides?: Record<string, unknown>) {
  return {
    messages: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ] as any[],
    systemPrompt: asSystemPrompt(['You are a helpful assistant.']),
    thinkingConfig: { type: 'disabled' as const },
    tools: [] as any,
    signal: new AbortController().signal,
    options: { model: 'qwen3:32b' },
    ...overrides,
  }
}

// ─── Text-only Response ─────────────────────────────────────────

describe('localCallModel', () => {
  describe('text-only response', () => {
    it('yields stream_events and an AssistantMessage with text content', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_1', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)

      // Should have stream_events wrapping each raw event
      const streamEvents = items.filter((i: any) => i.type === 'stream_event')
      expect(streamEvents.length).toBeGreaterThan(0)

      // Should have at least one AssistantMessage
      const assistantMsgs = items.filter((i: any) => i.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

      // The AssistantMessage should have text content
      const msg = assistantMsgs[0] as any
      expect(msg.message.role).toBe('assistant')
      expect(msg.message.type).toBe('message')
      expect(msg.uuid).toBeDefined()
      expect(msg.timestamp).toBeDefined()
      expect(msg.message.content.length).toBeGreaterThanOrEqual(1)
      expect(msg.message.content[0].type).toBe('text')
    })

    it('wraps every translated event in a stream_event envelope', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_2', model: 'qwen3:32b', usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)

      // All yielded items should be either stream_event or assistant
      for (const item of items) {
        const t = (item as any).type
        expect(['stream_event', 'assistant']).toContain(t)
      }
    })
  })

  // ─── Tool Use Response ──────────────────────────────────────────

  describe('tool use response', () => {
    it('yields AssistantMessage with tool_use content', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_3', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]

      const tools = [makeTool('Bash', 'Run a bash command', { command: { type: 'string' } })]
      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams({ tools }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)
      const assistantMsgs = items.filter((i: any) => i.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

      // Should have at least one message with tool_use content
      const hasToolUse = assistantMsgs.some((m: any) =>
        m.message.content.some((c: any) => c.type === 'tool_use')
      )
      expect(hasToolUse).toBe(true)
    })
  })

  // ─── stop_reason Mutation ─────────────────────────────────────

  describe('stop_reason lifecycle', () => {
    it('yields AssistantMessage with null stop_reason, then mutates on message_delta', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_4', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)

      // We need to capture the AssistantMessage as it is yielded and BEFORE message_delta
      // We'll collect items step by step
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)

      // Find the assistant message(s)
      const assistantMsgs = items.filter((i: any) => i.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

      // After full iteration, stop_reason should have been mutated from null to 'end_turn'
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1] as any
      expect(lastAssistant.message.stop_reason).toBe('end_turn')
    })

    it('stop_reason is initially null when AssistantMessage is first assembled', async () => {
      // To verify the null-then-mutate contract, we capture messages as they are yielded
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_5', model: 'qwen3:32b', usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'X' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      // Collect items and track stop_reason at each step
      let stopReasonAtYield: string | null | undefined = undefined
      for await (const item of gen) {
        if ((item as any).type === 'assistant' && stopReasonAtYield === undefined) {
          // Capture stop_reason when we first see an assistant message
          stopReasonAtYield = (item as any).message.stop_reason
        }
      }

      // The first assistant message should have been yielded with null stop_reason
      expect(stopReasonAtYield).toBeNull()
    })
  })

  // ─── Simulated Tool Use (Standard Tier) ────────────────────────

  describe('simulated tool use', () => {
    it('activates simulated mode for models with simulated tool use capability', async () => {
      // When toolUse === 'simulated', the stream translator should be called with
      // simulatedToolUse: true, which buffers text and extracts <tool_call> XML
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_6', model: 'phi4', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will run a command.\n<tool_call>\n{"name": "Bash", "arguments": {"command": "ls"}}\n</tool_call>' } },
        { type: 'message_stop' },
      ]

      const tools = [makeTool('Bash', 'Run a bash command', { command: { type: 'string' } })]
      const simCapabilities = defaultCapabilities({
        tier: 'standard',
        toolUse: 'simulated',
      })

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'phi4' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'phi4' }),
          resolveCapabilities: () => simCapabilities,
        },
      } as any)

      const items = await collect(gen)

      // Should have extracted the tool call and produced an assistant message
      const assistantMsgs = items.filter((i: any) => i.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

      // Should have a tool_use content block from the simulated extraction
      const hasToolUse = assistantMsgs.some((m: any) =>
        m.message.content.some((c: any) => c.type === 'tool_use')
      )
      expect(hasToolUse).toBe(true)
    })
  })

  // ─── Basic Tier (No Tools) ────────────────────────────────────

  describe('basic tier (toolUse === none)', () => {
    it('strips tools from the request when toolUse is none', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_7', model: 'gemma', usage: { input_tokens: 5, output_tokens: 0 } } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() {
          return defaultCapabilities({ tier: 'basic', toolUse: 'none' })
        },
      }

      const tools = [makeTool('Bash', 'Run a bash command', { command: { type: 'string' } })]
      const basicCapabilities = defaultCapabilities({
        tier: 'basic',
        toolUse: 'none',
      })

      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'gemma' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'gemma' }),
          resolveCapabilities: () => basicCapabilities,
        },
      } as any)

      await collect(gen)

      // Tools should not be sent to the provider
      expect(capturedRequest).toBeDefined()
      expect(capturedRequest.tools).toBeUndefined()
    })
  })

  // ─── Model Resolution ─────────────────────────────────────────

  describe('model resolution', () => {
    it('uses options.model when provided', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_8', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({ options: { model: 'qwen3:32b' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'llama3.1:8b' }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)
      expect(capturedRequest.model).toBe('qwen3:32b')
    })

    it('falls back to config.model when options.model is not set', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_9', model: 'llama3.1:8b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({ options: { model: '' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'llama3.1:8b' }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)
      expect(capturedRequest.model).toBe('llama3.1:8b')
    })

    it('throws when no model is available', async () => {
      const provider = createMockProvider([])
      const gen = localCallModel({
        ...defaultParams({ options: { model: '' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: undefined }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await expect(collect(gen)).rejects.toThrow(/model/i)
    })
  })

  // ─── AssistantMessage Shape ───────────────────────────────────

  describe('AssistantMessage shape', () => {
    it('has the required fields for the conversation loop', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_10', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Yes' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)
      const assistantMsgs = items.filter((i: any) => i.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)

      const msg = assistantMsgs[0] as any
      // Required fields
      expect(msg.type).toBe('assistant')
      expect(typeof msg.uuid).toBe('string')
      expect(typeof msg.timestamp).toBe('string')
      expect(msg.message.id).toBe('msg_10')
      expect(msg.message.model).toBe('qwen3:32b')
      expect(msg.message.role).toBe('assistant')
      expect(msg.message.type).toBe('message')
      expect(msg.message.stop_sequence).toBe('')
      expect(msg.message.container).toBeNull()
      expect(msg.message.context_management).toBeNull()
      expect(msg.message.usage).toBeDefined()
      expect(msg.message.content).toBeInstanceOf(Array)
      expect(msg.requestId).toBeUndefined()
    })

    it('usage fields include standard token tracking keys', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_11', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Y' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)
      const msg = items.find((i: any) => i.type === 'assistant') as any
      expect(msg.message.usage).toHaveProperty('input_tokens')
      expect(msg.message.usage).toHaveProperty('output_tokens')
      expect(msg.message.usage).toHaveProperty('cache_creation_input_tokens')
      expect(msg.message.usage).toHaveProperty('cache_read_input_tokens')
    })
  })

  // ─── Request Building ─────────────────────────────────────────

  describe('request building', () => {
    it('sends converted tools to the provider for native tool use', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_12', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const tools = [
        makeTool('Read', 'Read a file', { file_path: { type: 'string' } }),
        makeTool('Bash', 'Run a command', { command: { type: 'string' } }),
      ]

      const gen = localCallModel({
        ...defaultParams({ tools }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.tools).toBeDefined()
      expect(capturedRequest.tools).toHaveLength(2)
      expect(capturedRequest.tools[0].name).toBe('Read')
      expect(capturedRequest.tools[1].name).toBe('Bash')
    })

    it('applies tool scoping from config to filter tools before sending to provider', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_scoped', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const tools = [
        makeTool('Read', 'Read a file', { file_path: { type: 'string' } }),
        makeTool('Bash', 'Run a command', { command: { type: 'string' } }),
        makeTool('Write', 'Write a file', { file_path: { type: 'string' } }),
      ]

      // Config allows only Read and Write, denies Write => only Read reaches provider
      const gen = localCallModel({
        ...defaultParams({ tools }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({
            tools: { allowed: ['Read', 'Write'], denied: ['Write'] },
          }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.tools).toBeDefined()
      expect(capturedRequest.tools).toHaveLength(1)
      expect(capturedRequest.tools[0].name).toBe('Read')
    })

    it('sends all tools when config has no tool scoping', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_noscope', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const tools = [
        makeTool('Read', 'Read a file'),
        makeTool('Bash', 'Run a command'),
        makeTool('Write', 'Write a file'),
      ]

      const gen = localCallModel({
        ...defaultParams({ tools }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ tools: undefined }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.tools).toBeDefined()
      expect(capturedRequest.tools).toHaveLength(3)
    })

    it('passes system prompt to the provider', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_13', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({
          systemPrompt: asSystemPrompt(['Part one.', 'Part two.']),
        }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.system).toBe('Part one.\n\nPart two.')
    })

    it('prepends simulated tool prompt to system prompt for simulated tool use', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_14', model: 'phi4', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() {
          return defaultCapabilities({ tier: 'standard', toolUse: 'simulated' })
        },
      }

      const tools = [makeTool('Bash', 'Run a bash command', { command: { type: 'string' } })]
      const simCaps = defaultCapabilities({ tier: 'standard', toolUse: 'simulated' })

      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'phi4' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'phi4' }),
          resolveCapabilities: () => simCaps,
        },
      } as any)

      await collect(gen)

      // System prompt should contain the simulated tool prompt
      expect(capturedRequest.system).toContain('<tool_call>')
      expect(capturedRequest.system).toContain('Bash')
    })

    it('does not send tools in the request for simulated tool use', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_15', model: 'phi4', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() {
          return defaultCapabilities({ tier: 'standard', toolUse: 'simulated' })
        },
      }

      const tools = [makeTool('Bash', 'Run a bash command', { command: { type: 'string' } })]
      const simCaps = defaultCapabilities({ tier: 'standard', toolUse: 'simulated' })

      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'phi4' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'phi4' }),
          resolveCapabilities: () => simCaps,
        },
      } as any)

      await collect(gen)

      // Tools should NOT be sent to the provider for simulated mode
      expect(capturedRequest.tools).toBeUndefined()
    })

    it('passes config temperature to the request', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_16', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ temperature: 0.3, maxOutputTokens: 4096 }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.temperature).toBe(0.3)
    })
  })

  // ─── Error Handling ───────────────────────────────────────────

  describe('error handling', () => {
    it('yields SystemAPIErrorMessage on retryable provider error', async () => {
      const provider: Provider = {
        name: 'mock',
        async *stream() {
          const err = new Error('Connection refused')
          ;(err as any).code = 'ECONNREFUSED'
          throw err
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)
      const errorMsgs = items.filter((i: any) => i.type === 'system' && i.subtype === 'api_retry')
      expect(errorMsgs.length).toBeGreaterThanOrEqual(1)
    })

    it('rethrows non-retryable errors', async () => {
      const provider: Provider = {
        name: 'mock',
        async *stream() {
          throw new TypeError('Invalid argument')
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await expect(collect(gen)).rejects.toThrow('Invalid argument')
    })
  })

  // ─── message_delta Mutation ───────────────────────────────────

  describe('message_delta mutation', () => {
    it('mutates usage on the last AssistantMessage when message_delta arrives', async () => {
      const mockEvents: LocalStreamEvent[] = [
        { type: 'message_start', message: { id: 'msg_17', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
        { type: 'message_stop' },
      ]

      const provider = createMockProvider(mockEvents)
      const gen = localCallModel({
        ...defaultParams(),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig(),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      const items = await collect(gen)
      const msg = items.find((i: any) => i.type === 'assistant') as any

      // After iteration completes, usage should reflect the message_delta values
      expect(msg.message.usage.output_tokens).toBe(42)
    })
  })
})
