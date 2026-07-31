/**
 * The semantic code index must be reachable, and its absence must be audible.
 *
 * README:309 promised "automatic vector indexing". Two things stood in the way.
 *
 * The endpoint: `main.ts` built the indexer with `config.baseUrl` — the chat
 * URL. Under the Ollama provider that is 11434 and works by coincidence; under
 * the llama.cpp provider it is the llama-server port, which has no embedding
 * route, so the indexer wrote nothing while the other five construction sites
 * (recall, saveLearning, indexResearch, the health probe) used the built-in
 * default and queried somewhere else. One engine, two endpoints.
 *
 * The dialect: the client spoke only Ollama's `/api/embed`, so anyone not
 * running Ollama could not reach the feature at all — and the failure was
 * silent, published on `context.status` where a terminal user never looks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { EmbedClient, embedBaseUrlFor, resetEmbedWarning } from '../../index/embedClient.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf-8')

const realFetch = globalThis.fetch
const saved = {
  base: process.env.LOCALCODE_EMBED_BASE_URL,
  api: process.env.LOCALCODE_EMBED_API,
  model: process.env.LOCALCODE_EMBED_MODEL,
}

beforeEach(() => {
  delete process.env.LOCALCODE_EMBED_BASE_URL
  delete process.env.LOCALCODE_EMBED_API
  delete process.env.LOCALCODE_EMBED_MODEL
  resetEmbedWarning()
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of [
    ['LOCALCODE_EMBED_BASE_URL', saved.base],
    ['LOCALCODE_EMBED_API', saved.api],
    ['LOCALCODE_EMBED_MODEL', saved.model],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('the embedding endpoint is resolved in one place', () => {
  it('never hands a non-Ollama chat URL to the embedding client', () => {
    // The exact pre-fix call: llama.cpp on 8081, no LOCALCODE_EMBED_BASE_URL.
    expect(
      embedBaseUrlFor({ provider: 'llama-cpp', baseUrl: 'http://localhost:8081' }),
      'the indexer was pointed at the llama-server port, which serves no embeddings, ' +
        'while every other caller used 11434',
    ).toBe('http://localhost:11434')
  })

  it('reuses the chat URL only when the chat provider also serves embeddings', () => {
    expect(embedBaseUrlFor({ provider: 'ollama', baseUrl: 'http://box:11434' })).toBe('http://box:11434')
    expect(embedBaseUrlFor({ provider: 'openai-compat', baseUrl: 'http://box:9000' })).toBe('http://localhost:11434')
    expect(embedBaseUrlFor()).toBe('http://localhost:11434')
  })

  it('LOCALCODE_EMBED_BASE_URL outranks every inference', () => {
    process.env.LOCALCODE_EMBED_BASE_URL = 'http://embeds:7000'
    expect(embedBaseUrlFor({ provider: 'ollama', baseUrl: 'http://box:11434' })).toBe('http://embeds:7000')
  })

  it('main.ts resolves the indexer URL rather than passing the chat URL', () => {
    const main = read('engine/main.ts')
    expect(main).not.toContain('new ProjectIndexer(process.cwd(), config.baseUrl)')
    expect(
      main.match(/new ProjectIndexer\(process\.cwd\(\), embedBaseUrlFor\(config\)\)/g)?.length,
      'all three indexer construction sites in main.ts must resolve the embed URL',
    ).toBe(3)
  })
})

describe('the embedding client speaks both wire formats', () => {
  function server(handler: (url: string, body: any) => Response) {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen.push(String(url))
      return handler(String(url), JSON.parse(init.body))
    }) as any
    return seen
  }

  const openaiOnly = (url: string, body: any) =>
    url.endsWith('/v1/embeddings')
      ? new Response(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [i, 0.5] })) }), { status: 200 })
      : new Response('{"error":{"code":404,"message":"File Not Found"}}', { status: 404 })

  it('falls through to /v1/embeddings when /api/embed is not a route', async () => {
    const seen = server(openaiOnly)
    const out = await new EmbedClient().embedBatch(['a', 'b'])
    expect(out).toEqual([[0, 0.5], [1, 0.5]])
    expect(seen.some(u => u.endsWith('/api/embed'))).toBe(true)
    expect(seen.some(u => u.endsWith('/v1/embeddings'))).toBe(true)
  })

  it('remembers the format that answered instead of probing every call', async () => {
    const seen = server(openaiOnly)
    const client = new EmbedClient()
    await client.embedBatch(['a'])
    expect(client.dialectUsed).toBe('openai')
    const afterFirst = seen.length
    await client.embedBatch(['b'])
    expect(seen.slice(afterFirst)).toEqual(['http://localhost:11434/v1/embeddings'])
  })

  it('honours the OpenAI index field rather than the array order', async () => {
    server((url, body) =>
      url.endsWith('/v1/embeddings')
        ? new Response(JSON.stringify({ data: [{ index: 1, embedding: [9] }, { index: 0, embedding: [7] }] }), { status: 200 })
        : new Response('nope', { status: 404 }))
    expect(await new EmbedClient().embedBatch(['first', 'second'])).toEqual([[7], [9]])
  })

  it('LOCALCODE_EMBED_API pins the format and stops the probe', async () => {
    process.env.LOCALCODE_EMBED_API = 'openai'
    const seen = server(openaiOnly)
    const client = new EmbedClient()
    expect(client.dialectUsed, 'nothing has answered yet, so nothing is remembered').toBe(null)
    await client.embedBatch(['a'])
    expect(seen).toEqual(['http://localhost:11434/v1/embeddings'])
  })

  it('a pinned dialect that fails does not quietly try the other one', async () => {
    // This is what pinning is FOR: a server that must not be probed. Falling
    // through on failure would send the request the operator forbade.
    process.env.LOCALCODE_EMBED_API = 'ollama'
    const seen = server(openaiOnly)
    await expect(new EmbedClient().embedBatch(['a'])).rejects.toThrow()
    expect(seen).toEqual(['http://localhost:11434/api/embed'])
  })

  it('still speaks Ollama first, so an Ollama install pays no extra request', async () => {
    const seen = server((url) =>
      url.endsWith('/api/embed')
        ? new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 })
        : new Response('nope', { status: 404 }))
    const client = new EmbedClient()
    expect(await client.embedBatch(['a'])).toEqual([[0.1]])
    expect(seen).toEqual(['http://localhost:11434/api/embed'])
    expect(client.dialectUsed).toBe('ollama')
  })

  it('a missing MODEL is not mistaken for a missing ROUTE', async () => {
    // Ollama answering "model not found" is a real server with a real answer.
    // Reading that as "wrong dialect" would send the client off to
    // /v1/embeddings instead of falling back to nomic-embed-text.
    const seen = server((url, body) =>
      url.endsWith('/api/embed') && body.model === 'jina-code-embeddings-0.5b'
        ? new Response('model "jina-code-embeddings-0.5b" not found', { status: 404 })
        : url.endsWith('/api/embed')
          ? new Response(JSON.stringify({ embeddings: [[0.4]] }), { status: 200 })
          : new Response('should not be asked', { status: 500 }))
    const client = new EmbedClient()
    expect(await client.embedBatch(['a'])).toEqual([[0.4]])
    expect(client.modelName).toBe('nomic-embed-text')
    expect(seen.some(u => u.endsWith('/v1/embeddings'))).toBe(false)
  })
})

describe('an unreachable embedding server says so', () => {
  it('warns once, naming the endpoint and what was lost', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')) })
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as any
    try {
      const client = new EmbedClient()
      await client.embedBatch(['a']).catch(() => {})
      await client.embedBatch(['b']).catch(() => {})
    } finally {
      log.mockRestore()
    }
    const warnings = lines.filter(l => l.includes('No embedding endpoint answered'))
    expect(warnings, 'the silent degradation must become audible exactly once').toHaveLength(1)
    expect(warnings[0]).toContain('http://localhost:11434')
    expect(warnings[0]).toContain('keyword search')
  })

  it('the conversation loop warns when the health probe comes back empty', () => {
    const loop = read('engine/bridge/conversationLoop.ts')
    expect(loop).toContain('warnEmbedUnavailable')
  })
})

describe('the README describes what the index actually needs', () => {
  it('names the requirement next to the vector-index claim', () => {
    const readme = read('README.md')
    const start = readme.indexOf('### Semantic Code Index')
    expect(start).toBeGreaterThan(-1)
    const section = readme.slice(start, readme.indexOf('### ', start + 10))
    expect(section, 'the section promised automatic vector indexing without saying what it needs')
      .toContain('Requires an embedding server')
    expect(section).toContain('LOCALCODE_EMBED_BASE_URL')
    expect(section).toContain('/v1/embeddings')
  })
})
