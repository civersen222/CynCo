// engine/__tests__/vibe/sideQueryRouting.test.ts
// runSideQuery must route through the provider-appropriate endpoint —
// llama-cpp uses OpenAI-compatible /v1/chat/completions, Ollama uses /api/chat.
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false,
    jsonMode: true, contextLength: 32768, streaming: true,
  }
}

function stubProvider(): Provider {
  return {
    name: 'stub',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {},
  }
}

// Loop cwd — the constructor initSnapshot()s its cwd; a temp dir keeps tests
// from staging the repo root into the live .cynco-snapshots/ (P1.4 fix).
const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-sidequery-cwd-'))
afterAll(() => {
  fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
})

function makeLoop(configOverrides: Record<string, unknown>) {
  return new ConversationLoop({
    cwd: TEST_CWD,
    config: {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto',
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: 131072, tools: undefined, noScouts: true,
      ...configOverrides,
    } as any,
    provider: stubProvider(),
    emit: () => {},
  })
}

const realFetch = globalThis.fetch

describe('runSideQuery provider routing', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  it('llama-cpp: hits /v1/chat/completions with max_tokens and system message', async () => {
    let calledUrl = ''
    let body: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      calledUrl = String(url)
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'llama-cpp', port: 8099 })
    const out = await loop.runSideQuery('ping', { maxTokens: 321, system: 'be terse' })

    expect(calledUrl).toBe('http://127.0.0.1:8099/v1/chat/completions')
    expect(body.max_tokens).toBe(321)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(body.messages[1].content).toContain('ping')
    expect(out).toBe('pong')
  })

  it('ollama: hits /api/chat with num_predict, falls back to message.thinking', async () => {
    let calledUrl = ''
    let body: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      calledUrl = String(url)
      body = JSON.parse(init.body)
      // Gemma4 pattern: empty content, answer in thinking
      return new Response(JSON.stringify({ message: { content: '', thinking: 'from-thinking' } }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'ollama' })
    const out = await loop.runSideQuery('ping', { maxTokens: 555 })

    expect(calledUrl).toBe('http://localhost:11434/api/chat')
    expect(body.options.num_predict).toBe(555)
    expect(out).toBe('from-thinking')
  })

  it('defaults maxTokens to 300 for satellite callers', async () => {
    let body: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'ollama' })
    await loop.runSideQuery('ping')
    expect(body.options.num_predict).toBe(300)
  })

  it('throws on non-2xx HTTP status (llama-cpp path)', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'model not loaded' }), { status: 500 })
    }) as any

    const loop = makeLoop({ provider: 'llama-cpp', port: 8099 })
    await expect(loop.runSideQuery('ping')).rejects.toThrow(/500/)
  })
})
