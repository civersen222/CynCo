import { describe, expect, it, beforeAll } from 'bun:test'

// Skip these integration tests in CI — they create real ConversationLoop
// instances that hit the filesystem, create JSONL sessions, index DBs, etc.
// Run manually with: CYNCO_INTEGRATION=1 bun test
const SKIP = !process.env.CYNCO_INTEGRATION
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: undefined,
    tools: undefined,
  }
}

function defaultCapabilities(): ModelCapabilities {
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

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      if (gen) yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

describe('ConversationLoop with tools', () => {
  it.skipIf(SKIP)('streams text responses and emits events', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('Hello!')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('hi')
    expect(events.some(e => e.type === 'stream.token')).toBe(true)
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
  })

  it.skipIf(SKIP)('sets processing flag during message handling', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('test')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    expect(loop.isProcessing).toBe(false)
    const promise = loop.handleUserMessage('hello')
    // isProcessing is true while awaiting
    expect(loop.isProcessing).toBe(true)
    await promise
    expect(loop.isProcessing).toBe(false)
  })

  it('exposes handleApprovalResponse and setApproveAll methods', () => {
    const provider = mockProvider([])
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: () => {},
    })

    // These should not throw
    expect(() => loop.handleApprovalResponse('fake-id', true)).not.toThrow()
    expect(() => loop.setApproveAll(true)).not.toThrow()
    expect(() => loop.setApproveAll(false)).not.toThrow()
  })

  it.skipIf(SKIP)('ignores messages while already processing', async () => {
    const events: any[] = []
    // Create a provider that takes a bit to respond
    const provider = mockProvider([() => textResponse('first'), () => textResponse('second')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    const p1 = loop.handleUserMessage('first')
    // This should be ignored since we're already processing
    const p2 = loop.handleUserMessage('second')
    await p1
    await p2

    // Only one message.complete event (the second was ignored)
    const completes = events.filter(e => e.type === 'message.complete')
    expect(completes.length).toBe(1)
  })

  it.skipIf(SKIP)('emits message.complete with correct stopReason', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('done')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('finish')
    const complete = events.find(e => e.type === 'message.complete')
    expect(complete).toBeDefined()
    expect(complete.stopReason).toBe('end_turn')
  })
})
