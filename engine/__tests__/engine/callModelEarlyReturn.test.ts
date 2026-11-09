// Wakefulness review (2026-11-08): the provider's stream() holds a `request`
// activity in a finally; callModel pulls the provider iterator by hand, so a
// Stop that returned the OUTER generator never ran the provider's finally —
// the model never unloaded and the PC never slept after the first Stop.
import { describe, expect, it } from 'bun:test'
import type { Provider } from '../../provider.js'
import { localCallModel } from '../../engine/callModel.js'

const caps = { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true } as any
const config = { baseUrl: 'http://localhost:11434', model: 'x', tier: 'auto', temperature: 0.7, maxOutputTokens: 8192, timeout: 120000 } as any

function provider(onFinally: () => void): Provider {
  return {
    name: 'mock',
    async *stream() {
      try {
        yield { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } as any
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } as any
        await new Promise(r => setTimeout(r, 50))
        yield { type: 'content_block_stop', index: 0 } as any
      } finally {
        onFinally()
      }
    },
    async complete() { throw new Error('not implemented') },
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { return caps },
  } as any
}

describe('localCallModel releases the provider stream when its consumer stops early', () => {
  it('calls return() on the provider iterator so its finally runs', async () => {
    let ran = false
    const gen = localCallModel({
      messages: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }] as any,
      systemPrompt: ['You are a helpful assistant.'] as any,
      thinkingConfig: { type: 'disabled' } as any,
      tools: [] as any,
      signal: new AbortController().signal,
      options: { model: 'x' } as any,
      deps: { getProvider: () => provider(() => { ran = true }), loadConfig: () => config, resolveCapabilities: () => caps },
    })
    const first = await gen.next()
    expect(first.done).toBe(false)
    await gen.return(undefined as any)
    expect(ran).toBe(true)
  })
})
