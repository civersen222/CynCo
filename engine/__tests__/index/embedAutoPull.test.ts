import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EmbedClient } from '../../index/embedClient.js'

const realFetch = globalThis.fetch
const savedModel = process.env.LOCALCODE_EMBED_MODEL
const savedBase = process.env.LOCALCODE_EMBED_BASE_URL

beforeEach(() => {
  delete process.env.LOCALCODE_EMBED_MODEL
  delete process.env.LOCALCODE_EMBED_BASE_URL
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedModel !== undefined) process.env.LOCALCODE_EMBED_MODEL = savedModel
  if (savedBase !== undefined) process.env.LOCALCODE_EMBED_BASE_URL = savedBase
})

describe('EmbedClient auto-pull on missing model', () => {
  it('serves the call via fallback AND fires a background pull of the configured model', async () => {
    const calls: { url: string; body: any }[] = []
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body)
      calls.push({ url: String(url), body })
      if (String(url).endsWith('/api/embed')) {
        if (body.model === 'jina-code-embeddings-0.5b') {
          return new Response('model "jina-code-embeddings-0.5b" not found', { status: 404 })
        }
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })
      }
      if (String(url).endsWith('/api/pull')) {
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    }) as any

    const client = new EmbedClient('http://localhost:11434', 'jina-code-embeddings-0.5b')
    const result = await client.embedBatch(['hello'])
    expect(result).toEqual([[0.1, 0.2]])

    // Let the fire-and-forget pull task run
    await new Promise(r => setTimeout(r, 0))
    const pull = calls.find(c => c.url.endsWith('/api/pull'))
    expect(pull).toBeDefined()
    expect(pull!.body.model).toBe('jina-code-embeddings-0.5b')

    // Second failure must NOT pull again (pullAttempted guard)
    await client.embedBatch(['again'])
    await new Promise(r => setTimeout(r, 0))
    expect(calls.filter(c => c.url.endsWith('/api/pull')).length).toBe(1)
  })
})
