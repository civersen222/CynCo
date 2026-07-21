import { describe, it, expect } from 'vitest'
import { fromOpenAIStreamChunk } from '../../ollama/format.js'
import { translateStream } from '../../engine/streamTranslator.js'

const baseChunk = (extra: object) => ({
  id: 'c1', model: 'm',
  choices: [{ index: 0, finish_reason: null, ...extra }],
}) as any

describe('fromOpenAIStreamChunk logprobs', () => {
  it('attaches parsed logprobs to text deltas', () => {
    const events = fromOpenAIStreamChunk(baseChunk({
      delta: { content: 'hi' },
      logprobs: { content: [{ token: 'hi', logprob: -0.1, top_logprobs: [{ token: 'hi', logprob: -0.1 }, { token: 'yo', logprob: -2.5 }] }] },
    }))
    const delta = events.find(e => e.type === 'content_block_delta') as any
    expect(delta.delta.type).toBe('text_delta')
    expect(delta.delta.logprobs).toHaveLength(1)
    expect(delta.delta.logprobs[0].top).toHaveLength(2)
    expect(delta.delta.logprobs[0].top[1].logprob).toBeCloseTo(-2.5)
  })

  it('attaches logprobs to thinking deltas (reasoning_content chunks)', () => {
    const events = fromOpenAIStreamChunk(baseChunk({
      delta: { reasoning_content: 'hmm' },
      logprobs: { content: [{ token: 'hmm', logprob: -0.3, top_logprobs: [] }] },
    }))
    const delta = events.find(e => (e as any).delta?.type === 'thinking_delta') as any
    expect(delta.delta.logprobs).toHaveLength(1)
  })

  it('no logprobs field -> deltas without logprobs (degradation path)', () => {
    const events = fromOpenAIStreamChunk(baseChunk({ delta: { content: 'hi' } }))
    const delta = events.find(e => e.type === 'content_block_delta') as any
    expect(delta.delta.logprobs).toBeUndefined()
  })

  it('malformed logprobs (non-array content) -> undefined, no throw', () => {
    const events = fromOpenAIStreamChunk(baseChunk({
      delta: { content: 'hi' }, logprobs: { content: 'garbage' },
    }))
    const delta = events.find(e => e.type === 'content_block_delta') as any
    expect(delta.delta.logprobs).toBeUndefined()
  })

  it('translateStream native mode preserves delta.logprobs', async () => {
    async function* src() {
      yield { type: 'message_start', message: { id: '', model: 'm', usage: { input_tokens: 0, output_tokens: 0 } } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a', logprobs: [{ token: 'a', logprob: -0.1, top: [] }] } } as any
      yield { type: 'message_stop' } as any
    }
    const out: any[] = []
    for await (const e of translateStream(src())) out.push(e)
    const d = out.find(e => e.type === 'content_block_delta')
    expect(d.delta.logprobs).toHaveLength(1)
  })
})
