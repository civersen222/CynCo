import { describe, expect, it } from 'bun:test'
import { OllamaProvider } from '../../ollama/client.js'
import type { CompletionRequest } from '../../provider.js'

// Mock fetch factory
function mockFetch(responses: Map<string, { status: number; body: unknown }>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const [pattern, resp] of responses) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return new Response('Not Found', { status: 404 })
  }
}

describe('OllamaProvider (unit)', () => {
  it('healthCheck returns true when Ollama responds', async () => {
    const fetch = mockFetch(new Map([['localhost:11434/', { status: 200, body: 'Ollama is running' }]]))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    expect(await provider.healthCheck()).toBe(true)
  })

  it('healthCheck returns false on network error', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED') }
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    expect(await provider.healthCheck()).toBe(false)
  })

  it('listModels parses /api/tags response', async () => {
    const fetch = mockFetch(new Map([['/api/tags', {
      status: 200,
      body: { models: [
        { name: 'qwen3:32b', size: 18000000000, modified_at: '2026-01-01' },
        { name: 'gemma:7b', size: 4000000000, modified_at: '2026-01-02' },
      ]},
    }]]))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    const models = await provider.listModels()
    expect(models).toHaveLength(2)
    expect(models[0].name).toBe('qwen3:32b')
    expect(models[0].capabilities.toolUse).toBe('native')
    expect(models[1].name).toBe('gemma:7b')
    expect(models[1].capabilities.toolUse).toBe('none')
  })

  it('complete sends to /v1/chat/completions and returns CompletionResponse', async () => {
    const fetch = mockFetch(new Map([['/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-1', model: 'qwen3:32b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }]]))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    const req: CompletionRequest = {
      model: 'qwen3:32b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 1024,
    }
    const resp = await provider.complete(req)
    expect(resp.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(resp.stop_reason).toBe('end_turn')
  })

  it('stream yields message_start, content deltas, and message_stop', async () => {
    const sseBody = [
      'data: {"id":"chatcmpl-1","model":"qwen3:32b","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","model":"qwen3:32b","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","model":"qwen3:32b","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","model":"qwen3:32b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v1/chat/completions')) {
        return new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    const req: CompletionRequest = {
      model: 'qwen3:32b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 1024,
    }
    const events: Array<{ type: string }> = []
    for await (const event of provider.stream(req)) {
      events.push(event)
    }
    expect(events[0].type).toBe('message_start')
    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(events[events.length - 1].type).toBe('message_stop')
  })

  it('pullModel parses NDJSON progress from /api/pull', async () => {
    const ndjson = [
      '{"status":"pulling manifest"}',
      '{"status":"downloading","completed":500,"total":1000}',
      '{"status":"success"}',
    ].join('\n')
    const fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/pull')) {
        return new Response(ndjson, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      return new Response('Not Found', { status: 404 })
    }
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', fetchFn: fetch })
    const progress: Array<{ status: string }> = []
    for await (const p of provider.pullModel('qwen3:32b')) {
      progress.push(p)
    }
    expect(progress).toHaveLength(3)
    expect(progress[0].status).toBe('pulling manifest')
    expect(progress[2].status).toBe('success')
  })
})

// Integration tests — require a running Ollama instance
const RUN_INTEGRATION = process.env.LOCALCODE_INTEGRATION_TESTS === '1'

describe.skipIf(!RUN_INTEGRATION)('OllamaProvider (integration)', () => {
  it('healthCheck with real Ollama', async () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    expect(await provider.healthCheck()).toBe(true)
  })

  it('listModels returns real models', async () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const models = await provider.listModels()
    expect(models.length).toBeGreaterThan(0)
  })
})
