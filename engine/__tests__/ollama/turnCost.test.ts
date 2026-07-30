import { describe, expect, it } from 'bun:test'
import { parseTurnCost, fromOpenAIStreamChunk, fromOpenAIResponse } from '../../ollama/format.js'

// Field names below are copied from a live probe of llama-server build
// b9529-96fbe0039 on 2026-07-28, not from documentation. The decisive shape:
// prompt_tokens 11 alongside cache_n 7 / prompt_n 4 — eleven tokens of context,
// four tokens of work.
const LLAMA_FINAL_CHUNK = {
  id: 'chatcmpl-1', model: 'qwen',
  choices: [],
  usage: {
    prompt_tokens: 11, completion_tokens: 2, total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 7 },
  },
  timings: {
    cache_n: 7, prompt_n: 4, prompt_ms: 81.487,
    predicted_n: 2, predicted_ms: 30.617,
  },
}

describe('parseTurnCost', () => {
  it('reads llama.cpp timings as the work done, not the prompt size', () => {
    const c = parseTurnCost(LLAMA_FINAL_CHUNK)
    expect(c.source).toBe('server-timings')
    // The whole point: 4, not 11. Conflating them makes a cached 60k prefix
    // look identical to a cold one.
    expect(c.prefillTokens).toBe(4)
    expect(c.cachedTokens).toBe(7)
    expect(c.decodeTokens).toBe(2)
    expect(c.prefillMs).toBeCloseTo(81.487)
    expect(c.decodeMs).toBeCloseTo(30.617)
  })

  it('leaves wallMs null — the server cannot see queueing, so it never reports it', () => {
    expect(parseTurnCost(LLAMA_FINAL_CHUNK).wallMs).toBeNull()
  })

  it('leaves slot null — the OpenAI-compatible response carries no slot id', () => {
    expect(parseTurnCost(LLAMA_FINAL_CHUNK).slot).toBeNull()
  })

  it('reports usage-only when a server sends token counts but no timings', () => {
    const c = parseTurnCost({ usage: { prompt_tokens: 900, completion_tokens: 40 } })
    expect(c.source).toBe('usage-only')
    expect(c.decodeTokens).toBe(40)
    // 900 is the prompt SIZE. How much of it was fresh prefill is unknown, and
    // writing 900 here would assert the whole prompt was evaluated.
    expect(c.prefillTokens).toBeNull()
    expect(c.prefillMs).toBeNull()
  })

  it('still reads cached_tokens from usage when there is no timings block', () => {
    const c = parseTurnCost({ usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 850 } } })
    expect(c.cachedTokens).toBe(850)
    expect(c.source).toBe('usage-only')
  })

  it('reports source none and all nulls when the server said nothing', () => {
    const c = parseTurnCost({})
    expect(c.source).toBe('none')
    // Nulls, never zeros. Zero prefill milliseconds is a claim the prefill was free.
    expect(c.prefillTokens).toBeNull()
    expect(c.decodeTokens).toBeNull()
    expect(c.prefillMs).toBeNull()
    expect(c.decodeMs).toBeNull()
  })

  it('ignores a timings block that reports neither token count', () => {
    const c = parseTurnCost({ usage: { prompt_tokens: 5, completion_tokens: 1 }, timings: { prompt_ms: 3 } })
    expect(c.source).toBe('usage-only')
  })
})

describe('cost reaches the internal types', () => {
  it('rides the streaming usage chunk', () => {
    const events = fromOpenAIStreamChunk(LLAMA_FINAL_CHUNK as any)
    const delta = events.find(e => e.type === 'message_delta') as any
    expect(delta.usage.cost.prefillTokens).toBe(4)
    expect(delta.usage.cost.source).toBe('server-timings')
  })

  it('rides the non-streaming response', () => {
    const resp = fromOpenAIResponse({
      ...LLAMA_FINAL_CHUNK,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    } as any)
    expect(resp.usage.cost?.prefillTokens).toBe(4)
    expect(resp.usage.cost?.cachedTokens).toBe(7)
  })
})
