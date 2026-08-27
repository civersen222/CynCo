import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { EmbedClient } from '../../index/embedClient.js'

const realFetch = globalThis.fetch
const savedModel = process.env.LOCALCODE_EMBED_MODEL
beforeEach(() => { delete process.env.LOCALCODE_EMBED_MODEL })
afterEach(() => {
  globalThis.fetch = realFetch
  if (savedModel !== undefined) process.env.LOCALCODE_EMBED_MODEL = savedModel
})

function capture(): { texts: string[][] } {
  const captured = { texts: [] as string[][] }
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    captured.texts.push(body.input)
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })
  }) as any
  return captured
}

describe('embedQuery task prefix', () => {
  it('nomic-* gets search_query: prefix on queries only', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'nomic-embed-text')
    await c.embedQuery('ladder maths')
    expect(cap.texts[0][0]).toBe('search_query: ladder maths')
  })

  it('jina-code gets the retrieval instruction', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'jina-code-embeddings-0.5b')
    await c.embedQuery('ladder maths')
    expect(cap.texts[0][0]).toBe('Find the most relevant code snippet given the following query:\nladder maths')
  })

  it('unknown models get no prefix; embed() (document side) never prefixes', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'mystery-model')
    await c.embedQuery('q')
    await c.embed('doc text')
    expect(cap.texts[0][0]).toBe('q')
    expect(cap.texts[1][0]).toBe('doc text')
  })

  it('document side never prefixes even for prefix-aware models', async () => {
    const cap = capture()
    const c = new EmbedClient('http://x', 'nomic-embed-text')
    await c.embed('def foo(): pass')
    expect(cap.texts[0][0]).toBe('def foo(): pass')
  })
})
