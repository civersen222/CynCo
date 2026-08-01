import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StreamEvent as LocalStreamEvent } from '../../types.js'
import type { Provider, ModelCapabilities } from '../../provider.js'
import type { LocalCodeConfig } from '../../config.js'
import { localCallModel, isRetryableError } from '../../engine/callModel.js'
import { asSystemPrompt } from '../../types.js'

// callModel injects "## Previous Session Context" on the first turn when it
// finds session handoffs under os.homedir()/.cynco/continuity. On a developer
// machine real handoffs exist and leak into the system prompt, breaking the
// exact-match assertions below. Redirect homedir (USERPROFILE on Windows,
// HOME on POSIX) to an empty temp dir so no handoffs are ever found.
let fakeHome: string
let savedHome: string | undefined
let savedUserProfile: string | undefined

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'callmodel-home-'))
  savedHome = process.env.HOME
  savedUserProfile = process.env.USERPROFILE
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  rmSync(fakeHome, { recursive: true, force: true })
})

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
    // F22: this test used to end at the api_retry event, because ending there
    // was all the code did — it announced a retry and returned an empty stream.
    // The announcement is still the thing worth asserting, so it stays; what is
    // added is the other half, which the old behaviour had no way to express.
    // A provider that refuses forever must eventually surface its error rather
    // than resolve to nothing, or the caller cannot tell "the server is gone"
    // from "the model had nothing to say".
    it('announces a retryable provider error, and surfaces it once retries are spent', async () => {
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

      const items: unknown[] = []
      let threw: unknown = null
      try {
        // retryBaseDelayMs keeps the real backoff (2s, doubling) out of the suite.
        const gen = localCallModel({
          ...defaultParams({ options: { model: 'qwen3:32b', retryBaseDelayMs: 1 } }),
          deps: {
            getProvider: () => provider,
            loadConfig: () => defaultConfig(),
            resolveCapabilities: () => defaultCapabilities(),
          },
        } as any)
        for await (const item of gen) items.push(item)
      } catch (e) { threw = e }

      const errorMsgs = items.filter((i: any) => i.type === 'system' && i.subtype === 'api_retry')
      expect(errorMsgs.length).toBeGreaterThanOrEqual(1)
      expect(threw).not.toBeNull()
      expect(String((threw as Error).message)).toContain('Connection refused')
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

  // ─── Ollama Simulated Tool Override ─────────────────────────────

  describe('Ollama simulated tool override', () => {
    it('forces simulated tool use for Ollama provider even with native capabilities', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'ollama',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_ollama', model: 'qwen3.6:27b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const tools = [makeTool('Bash', 'Run a command', { command: { type: 'string' } })]
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'qwen3.6:27b' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'qwen3.6:27b' }),
          resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
        },
      } as any)

      await collect(gen)

      // Tools should NOT be sent to the provider (simulated mode)
      expect(capturedRequest.tools).toBeUndefined()
      // System prompt should contain tool definitions
      expect(capturedRequest.system).toContain('<tool_call>')
      expect(capturedRequest.system).toContain('Bash')
    })

    it('respects LOCALCODE_NATIVE_TOOLS=true to disable override', async () => {
      let capturedRequest: any = null
      const origEnv = process.env.LOCALCODE_NATIVE_TOOLS
      process.env.LOCALCODE_NATIVE_TOOLS = 'true'

      try {
        const provider: Provider = {
          name: 'ollama',
          async *stream(request) {
            capturedRequest = request
            yield { type: 'message_start', message: { id: 'msg_native', model: 'qwen3.6:27b', usage: { input_tokens: 0, output_tokens: 0 } } }
            yield { type: 'message_stop' }
          },
          async complete() { throw new Error('not implemented') },
          async healthCheck() { return true },
          async listModels() { return [] },
          async probeCapabilities() { return defaultCapabilities() },
        }

        const tools = [makeTool('Bash', 'Run a command', { command: { type: 'string' } })]
        const gen = localCallModel({
          ...defaultParams({ tools, options: { model: 'qwen3.6:27b' } }),
          deps: {
            getProvider: () => provider,
            loadConfig: () => defaultConfig({ model: 'qwen3.6:27b' }),
            resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
          },
        } as any)

        await collect(gen)

        expect(capturedRequest.tools).toBeDefined()
        expect(capturedRequest.tools).toHaveLength(1)
      } finally {
        if (origEnv === undefined) delete process.env.LOCALCODE_NATIVE_TOOLS
        else process.env.LOCALCODE_NATIVE_TOOLS = origEnv
      }
    })
  })

  // ─── Stuck Temperature Override ─────────────────────────────────

  describe('stuck temperature override', () => {
    it('overrides temperature to 0.1 when stuckTurns >= 3', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_stuck', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({
          options: { model: 'qwen3:32b', stuckTurns: 3 },
        }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ temperature: 0.7 }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)
      expect(capturedRequest.temperature).toBe(0.1)
    })

    it('uses LOCALCODE_TOOL_TEMPERATURE when set and stuck', async () => {
      let capturedRequest: any = null
      const origEnv = process.env.LOCALCODE_TOOL_TEMPERATURE
      process.env.LOCALCODE_TOOL_TEMPERATURE = '0.2'

      try {
        const provider: Provider = {
          name: 'mock',
          async *stream(request) {
            capturedRequest = request
            yield { type: 'message_start', message: { id: 'msg_tt', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
            yield { type: 'message_stop' }
          },
          async complete() { throw new Error('not implemented') },
          async healthCheck() { return true },
          async listModels() { return [] },
          async probeCapabilities() { return defaultCapabilities() },
        }

        const gen = localCallModel({
          ...defaultParams({
            options: { model: 'qwen3:32b', stuckTurns: 4 },
          }),
          deps: {
            getProvider: () => provider,
            loadConfig: () => defaultConfig({ temperature: 0.7 }),
            resolveCapabilities: () => defaultCapabilities(),
          },
        } as any)

        await collect(gen)
        expect(capturedRequest.temperature).toBe(0.2)
      } finally {
        if (origEnv === undefined) delete process.env.LOCALCODE_TOOL_TEMPERATURE
        else process.env.LOCALCODE_TOOL_TEMPERATURE = origEnv
      }
    })

    it('does not override temperature when stuckTurns < 3', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_ok', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({
          options: { model: 'qwen3:32b', stuckTurns: 2 },
        }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ temperature: 0.7 }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)
      expect(capturedRequest.temperature).toBe(0.7)
    })
  })

  // ─── P1.8: llama-cpp Native Tool Default ─────────────────────────

  describe('P1.8 llama-cpp native tool default', () => {
    // Snapshot/restore env so these tests neither depend on nor leak
    // LOCALCODE_NATIVE_TOOLS / LOCALCODE_SIMULATED_TOOLS state.
    let savedNativeTools: string | undefined
    let savedSimulatedTools: string | undefined

    beforeEach(() => {
      savedNativeTools = process.env.LOCALCODE_NATIVE_TOOLS
      savedSimulatedTools = process.env.LOCALCODE_SIMULATED_TOOLS
      delete process.env.LOCALCODE_NATIVE_TOOLS
      delete process.env.LOCALCODE_SIMULATED_TOOLS
    })

    afterEach(() => {
      if (savedNativeTools === undefined) delete process.env.LOCALCODE_NATIVE_TOOLS
      else process.env.LOCALCODE_NATIVE_TOOLS = savedNativeTools
      if (savedSimulatedTools === undefined) delete process.env.LOCALCODE_SIMULATED_TOOLS
      else process.env.LOCALCODE_SIMULATED_TOOLS = savedSimulatedTools
    })

    it('llama-cpp + native-capable model defaults to NATIVE tool use (P1.8)', async () => {
      let capturedRequest: any = null

      const fakeProvider: any = {
        name: 'llama-cpp',
        async *stream(req: any) {
          capturedRequest = req
          yield { type: 'message_start', message: { id: 'm1', model: 'qwen3.6', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities({ toolUse: 'native' }) },
      }

      const tools = [makeTool('Read', 'read', { file_path: { type: 'string' } })]
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'qwen3.6' } }),
        deps: {
          getProvider: () => fakeProvider,
          loadConfig: () => defaultConfig({ model: 'qwen3.6' }),
          resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
        },
      } as any)

      for await (const _ of gen) { /* drain */ }

      // native: tools param sent
      expect(capturedRequest.tools?.length).toBeGreaterThan(0)
      // no simulated prompt
      expect(capturedRequest.system).not.toContain('<tool_call>')
    })

    it('LOCALCODE_SIMULATED_TOOLS=true forces simulated on llama-cpp (kill switch) (P1.8)', async () => {
      process.env.LOCALCODE_SIMULATED_TOOLS = 'true' // restored by afterEach
      {
        let capturedRequest: any = null

        const fakeProvider: any = {
          name: 'llama-cpp',
          async *stream(req: any) {
            capturedRequest = req
            yield { type: 'message_start', message: { id: 'm2', model: 'qwen3.6', usage: { input_tokens: 0, output_tokens: 0 } } }
            yield { type: 'message_stop' }
          },
          async complete() { throw new Error('not implemented') },
          async healthCheck() { return true },
          async listModels() { return [] },
          async probeCapabilities() { return defaultCapabilities({ toolUse: 'native' }) },
        }

        const tools = [makeTool('Read', 'read', { file_path: { type: 'string' } })]
        const gen = localCallModel({
          ...defaultParams({ tools, options: { model: 'qwen3.6' } }),
          deps: {
            getProvider: () => fakeProvider,
            loadConfig: () => defaultConfig({ model: 'qwen3.6' }),
            resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
          },
        } as any)

        for await (const _ of gen) { /* drain */ }

        // simulated: tools param NOT sent
        expect(capturedRequest.tools).toBeUndefined()
        // simulated prompt injected
        expect(capturedRequest.system).toContain('<tool_call>')
      }
    })
  })

  // ─── P1.8: Repair Ladder at Stream Finalization ───────────────────

  describe('P1.8 repair ladder at stream finalization', () => {
    it('marks unrepairable streamed tool args as malformed instead of {} (P1.8)', async () => {
      // Fixture probe result: '<tool_call>blah</tool_call>' throws in jsonrepair
      // (Unexpected character "/" at position 16) — verified unrepairable
      const unrepairable = '<tool_call>blah</tool_call>'
      let capturedRequest: any = null

      const fakeProvider: any = {
        name: 'llama-cpp',
        async *stream(req: any) {
          capturedRequest = req
          yield { type: 'message_start', message: { id: 'm3', model: 'qwen3.6', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'Write', input: {} } }
          yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: unrepairable } }
          yield { type: 'content_block_stop', index: 1 }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities({ toolUse: 'native' }) },
      }

      const tools = [makeTool('Write', 'write', { file_path: { type: 'string' } })]
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'qwen3.6' } }),
        deps: {
          getProvider: () => fakeProvider,
          loadConfig: () => defaultConfig({ model: 'qwen3.6' }),
          resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
        },
      } as any)

      const assistantMsgs: any[] = []
      for await (const y of gen) {
        if ((y as any).type === 'assistant') assistantMsgs.push(y)
      }

      const last = assistantMsgs[assistantMsgs.length - 1]
      const tool = last.message.content.find((b: any) => b.type === 'tool_use')
      expect(tool).toBeDefined()
      expect(tool.input.__malformed).toBe(true)
      expect(tool.input.raw).toBe(unrepairable)
    })

    it('repairs trailing-comma tool args via jsonrepair (P1.8)', async () => {
      // Fixture: '{"file_path": "a.ts",}' — jsonrepair salvages to {"file_path":"a.ts"}
      const repairable = '{"file_path": "a.ts",}'

      const fakeProvider: any = {
        name: 'llama-cpp',
        async *stream() {
          yield { type: 'message_start', message: { id: 'm4', model: 'qwen3.6', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'Read', input: {} } }
          yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: repairable } }
          yield { type: 'content_block_stop', index: 1 }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities({ toolUse: 'native' }) },
      }

      const tools = [makeTool('Read', 'read', { file_path: { type: 'string' } })]
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'qwen3.6' } }),
        deps: {
          getProvider: () => fakeProvider,
          loadConfig: () => defaultConfig({ model: 'qwen3.6' }),
          resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
        },
      } as any)

      const assistantMsgs: any[] = []
      for await (const y of gen) {
        if ((y as any).type === 'assistant') assistantMsgs.push(y)
      }

      const last = assistantMsgs[assistantMsgs.length - 1]
      const tool = last.message.content.find((b: any) => b.type === 'tool_use')
      expect(tool).toBeDefined()
      expect(tool.input).toEqual({ file_path: 'a.ts' })
      expect(tool.input.__malformed).toBeUndefined()
    })
  })

  // ─── Stuck Thinking Budget Cap ──────────────────────────────────

  describe('stuck thinking budget cap', () => {
    it('caps thinking budget to 64 when stuck >= 3', async () => {
      let capturedRequest: any = null

      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_think', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities({ thinking: 'native' }) },
      }

      const gen = localCallModel({
        ...defaultParams({
          thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
          options: { model: 'qwen3:32b', stuckTurns: 3 },
        }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ temperature: 0.7 }),
          resolveCapabilities: () => defaultCapabilities({ thinking: 'native' }),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.thinking).toBeDefined()
      expect(capturedRequest.thinking.budget_tokens).toBe(64)
    })
  })
})

/**
 * F22 — the engine had a retry vocabulary, a retry classifier and a retry
 * event, and no retry.
 *
 * UI Wave 7h run 2: llama-server exited with code 9 at turn 59 of a 90-minute
 * mission. The engine's next request hit a dead port, `runModelLoop` threw
 * "Unable to connect. Is the computer able to access the url?", and the whole
 * session ended. Fifty-nine turns of work were left uncommitted.
 *
 * Two independent defects, both measured here rather than argued:
 *
 * 1. RETRYABLE_ERROR_CODES was written against Node's error vocabulary
 *    (ECONNREFUSED, ECONNRESET, ...) while this engine runs on Bun. Measured
 *    directly: `bun -e 'await fetch("http://127.0.0.1:59999/")'` rejects with
 *    `code === "ConnectionRefused"` and message "Unable to connect. Is the
 *    computer able to access the url?". That code is not in the set, and the
 *    message contains neither 'fetch failed' nor 'Connection refused' — note
 *    "ConnectionRefused" is one word and the substring test is for two. So the
 *    single commonest transient failure in this engine's actual runtime was
 *    classified as permanent and rethrown.
 *
 * 2. Even when the classifier said "retryable", nothing retried. The handler
 *    yielded `subtype: 'api_retry'` and returned. Nothing in the codebase
 *    consumes `api_retry` — grep finds the type declaration and the two emit
 *    sites, and no reader. A named event with no listener is not a retry, and
 *    the empty stream it leaves behind is indistinguishable from a model that
 *    chose to say nothing.
 *
 * The generalisation: an error taxonomy is a claim about a runtime, and it goes
 * stale silently when the runtime changes. Nothing failed loudly when the codes
 * stopped matching — the classifier just started answering "no" to everything
 * and the retry path became unreachable, which is exactly the shape that
 * survives review.
 */
describe('recovering from a dead inference server', () => {
  /** The error Bun actually throws for a refused connection. Measured, not authored. */
  function bunConnectionRefused(): Error {
    const e = new Error('Unable to connect. Is the computer able to access the url?')
    ;(e as any).code = 'ConnectionRefused'
    return e
  }

  /**
   * A provider that fails the first `failures` stream attempts and then works.
   * `attempts` counts calls to stream(), which is what "did it retry" means.
   */
  function createFlakyProvider(failures: number, err: () => Error) {
    const state = { attempts: 0 }
    const provider: Provider = {
      name: 'llama-cpp',
      async *stream() {
        state.attempts++
        if (state.attempts <= failures) throw err()
        yield { type: 'message_start', message: { id: 'm1', model: 'qwen3:32b' } } as any
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered' } } as any
        yield { type: 'content_block_stop', index: 0 } as any
        yield { type: 'message_stop' } as any
      },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
    }
    return { provider, state }
  }

  function paramsWith(provider: Provider) {
    return {
      ...defaultParams({
        // Retry backoff must not make the suite sleep for real seconds.
        options: { model: 'qwen3:32b', retryBaseDelayMs: 1 },
      }),
      deps: {
        getProvider: () => provider,
        loadConfig: () => defaultConfig(),
        resolveCapabilities: () => defaultCapabilities(),
      },
    } as any
  }

  it("recognises Bun's ConnectionRefused — the runtime this engine actually runs on", () => {
    // Defect 1, at the predicate. Node's spelling is ECONNREFUSED; Bun's is
    // ConnectionRefused, and the message shares no substring with either
    // literal the old predicate tested for.
    expect(isRetryableError(bunConnectionRefused())).toBe(true)
  })

  it("still recognises Node's spellings — the fix adds a vocabulary, it does not swap one", () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']) {
      const e = new Error('boom')
      ;(e as any).code = code
      expect(isRetryableError(e)).toBe(true)
    }
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
  })

  it('does not call a real fault transient — a bad grammar must still surface', () => {
    // The danger of widening a retry predicate is retrying something that will
    // never succeed, which converts a clear error into a hang.
    expect(isRetryableError(new Error('invalid grammar: unexpected token at line 3'))).toBe(false)
    expect(isRetryableError(new Error('context length exceeded'))).toBe(false)
    expect(isRetryableError('not even an error')).toBe(false)
  })

  it('actually re-issues the request — the whole point, and the part that was missing', async () => {
    // Defect 2. The old code yielded api_retry and returned, so stream() was
    // called exactly once no matter what. One failure then success must produce
    // two attempts and the real content.
    const { provider, state } = createFlakyProvider(1, bunConnectionRefused)
    const items = await collect(localCallModel(paramsWith(provider)))
    expect(state.attempts).toBe(2)
    expect(JSON.stringify(items)).toContain('recovered')
  })

  it('survives a server restart: several refusals in a row, then success', async () => {
    // llama-server takes tens of seconds to reload a 16 GB model, so one retry
    // is not enough — the point is to outlast the reload, not to blink twice.
    const { provider, state } = createFlakyProvider(3, bunConnectionRefused)
    const items = await collect(localCallModel(paramsWith(provider)))
    expect(state.attempts).toBe(4)
    expect(JSON.stringify(items)).toContain('recovered')
  })

  it('gives up eventually rather than retrying forever', async () => {
    // A permanently dead server must end the run with the real error, not spin.
    // Unbounded retry would replace a 56-minute wrong label with an infinite one.
    const { provider, state } = createFlakyProvider(999, bunConnectionRefused)
    let threw: unknown = null
    try {
      await collect(localCallModel(paramsWith(provider)))
    } catch (e) { threw = e }
    expect(threw).not.toBeNull()
    expect(String((threw as Error).message)).toContain('Unable to connect')
    // Bounded: the attempt count is finite and small enough to fail fast.
    expect(state.attempts).toBeGreaterThan(1)
    expect(state.attempts).toBeLessThanOrEqual(6)
  })

  it('a non-retryable error is thrown on the first attempt, not retried', async () => {
    const { provider, state } = createFlakyProvider(1, () => new Error('invalid grammar'))
    let threw: unknown = null
    try {
      await collect(localCallModel(paramsWith(provider)))
    } catch (e) { threw = e }
    expect(threw).not.toBeNull()
    expect(state.attempts).toBe(1)
  })

  it('announces each retry, so a run that recovered can be told from one that never failed', async () => {
    // api_retry stops being decorative: it is now emitted BEFORE a real
    // re-issue, which makes it evidence in the trajectory rather than a label
    // on a silent give-up.
    const { provider } = createFlakyProvider(2, bunConnectionRefused)
    const items = await collect(localCallModel(paramsWith(provider)))
    const retries = items.filter((i: any) => i?.type === 'system' && i?.subtype === 'api_retry')
    expect(retries.length).toBe(2)
    expect(String((retries[0] as any).message)).toContain('Unable to connect')
  })

  /**
   * F51 — the gap between the two recovery layers.
   *
   * Gilded Wave 10 died at turn 40 with 35 tests written and uncommitted, and
   * both recovery mechanisms worked. From engine_20260801_f49b.log, in order:
   * llama-server exited with code 9 mid `prompt_save`; the transport retry fired
   * correctly on the refused socket ("retry 1/4 in 2000ms"); the supervisor
   * relaunched ("restarting llama-server (1/3 in window)"); and the retry, two
   * seconds later, landed inside the load window and got
   *
   *   llama-server HTTP 503: {"error":{"message":"Loading model",
   *                           "type":"unavailable_error","code":503}}
   *
   * which the predicate did not recognise, so the session ended. The server was
   * listening again 7.04 seconds later, with 28 seconds of retry budget unspent.
   *
   * A supervisor whose restarts are always killed by the loop inside its own
   * restart window cannot recover anything, which is what makes this worth a
   * test rather than a one-line widening: the two layers were each correct and
   * the seam between them was the whole failure.
   */
  describe('F51: the server is up, answering, and not ready yet', () => {
    /** Verbatim from provider.ts's throw site, with llama.cpp's real body. */
    function loadingModel(): Error {
      return new Error(
        'llama-server HTTP 503: {"error":{"message":"Loading model",' +
        '"type":"unavailable_error","code":503}}',
      )
    }

    it('treats a 503 "Loading model" as transient', () => {
      expect(isRetryableError(loadingModel())).toBe(true)
    })

    it('outlasts the load window: the request is re-issued until the model is up', async () => {
      // The measured window is ~7s and the budget spends 2+4+8+16. Three
      // failures then success is the shape the incident had.
      const { provider, state } = createFlakyProvider(3, loadingModel)
      const items = await collect(localCallModel(paramsWith(provider)))
      expect(state.attempts).toBe(4)
      expect(JSON.stringify(items)).toContain('recovered')
    })

    it('does not retry a 503 that is not a load window', () => {
      // A proxy in front of a permanently dead upstream serves 503 forever.
      // Retrying that is the hang this predicate is deliberately narrow to
      // avoid, so the status alone must not be enough.
      expect(isRetryableError(new Error('llama-server HTTP 503: Service Unavailable'))).toBe(false)
      expect(isRetryableError(new Error('HTTP 503: upstream connect error'))).toBe(false)
    })

    it('does not retry other HTTP errors from the same throw site', () => {
      // Same sentence shape, permanent faults. If these ever start retrying,
      // the predicate has been widened to "any HTTP error", which is a hang.
      expect(isRetryableError(new Error('llama-server HTTP 400: invalid grammar'))).toBe(false)
      expect(isRetryableError(new Error('llama-server HTTP 500: internal error'))).toBe(false)
      expect(isRetryableError(new Error('llama-server HTTP 413: context length exceeded'))).toBe(false)
    })
  })
})
