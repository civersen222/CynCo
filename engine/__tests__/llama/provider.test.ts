// engine/__tests__/llama/provider.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'bun:test'
import { LlamaCppProvider } from '../../llama/provider.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function makeProvider(): LlamaCppProvider {
  return new LlamaCppProvider({
    primaryUrl: 'http://127.0.0.1:8081',
    modelName: 'qwen3.6',
    modelsDir: '/fake/models',
  })
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) { /* consume */ }
}

describe('LlamaCppProvider stream errors', () => {
  // 2026-06-12 weekly-digest incident #3: llama-server rejected an oversized
  // request ("request (32900 tokens) exceeds the available context size
  // (32768)") but stream() never checked resp.ok and fromOpenAIStreamChunk
  // drops chunks without choices — the loop saw a silent 0-token end_turn
  // every remaining turn instead of the error.
  afterEach(() => { vi.unstubAllGlobals() })

  it('throws on non-OK HTTP response instead of silently ending the stream', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: { message: 'request (32900 tokens) exceeds the available context size (32768)' } }),
      { status: 400, statusText: 'Bad Request' },
    ))
    const p = makeProvider()
    await expect(drain(p.stream({ model: 'qwen3.6', messages: [] } as any)))
      .rejects.toThrow(/32900|HTTP 400/)
  })

  it('throws when a data chunk carries an error payload', async () => {
    const sse = 'data: {"error":{"message":"context shift is disabled"}}\n\ndata: [DONE]\n\n'
    vi.stubGlobal('fetch', async () => new Response(sse, { status: 200 }))
    const p = makeProvider()
    await expect(drain(p.stream({ model: 'qwen3.6', messages: [] } as any)))
      .rejects.toThrow(/context shift is disabled/)
  })

  it('throws on SSE error:-prefixed lines (llama.cpp error events)', async () => {
    const sse = 'error: {"code":500,"message":"slot unavailable","type":"unavailable_error"}\n\n'
    vi.stubGlobal('fetch', async () => new Response(sse, { status: 200 }))
    const p = makeProvider()
    await expect(drain(p.stream({ model: 'qwen3.6', messages: [] } as any)))
      .rejects.toThrow(/slot unavailable/)
  })
})

describe('LlamaCppProvider', () => {
  it('has correct name', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.name).toBe('llama-cpp')
  })

  it('getBaseUrl returns primary when no adapter active', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
  })

  it('activeAdapter returns null by default', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.activeAdapter()).toBeNull()
  })

  it('getBaseUrl returns adapterUrl when adapter is active and URL configured', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    // Simulate adapter being active by calling the internal setter
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    expect(p.activeAdapter()).toBe('s3-lora')
  })

  it('getBaseUrl returns primary after unloadAdapter', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    p._clearActiveAdapter()
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
    expect(p.activeAdapter()).toBeNull()
  })

  it('listModels scans modelsDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-list-'))
    try {
      // Create two model dirs
      fs.mkdirSync(path.join(tmpDir, 'qwen3.6'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'qwen3.6', 'model.gguf'), 'x')
      fs.mkdirSync(path.join(tmpDir, 'llama3'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'llama3', 'model.gguf'), 'x')

      const p = new LlamaCppProvider({
        primaryUrl: 'http://127.0.0.1:8081',
        modelName: 'qwen3.6',
        modelsDir: tmpDir,
      })

      const models = p.listModelsSync()
      expect(models).toHaveLength(2)
      const names = models.map(m => m.name)
      expect(names).toContain('qwen3.6')
      expect(names).toContain('llama3')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getCompletionsUrl uses getBaseUrl', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getCompletionsUrl()).toBe('http://127.0.0.1:8081/v1/chat/completions')
  })
})
