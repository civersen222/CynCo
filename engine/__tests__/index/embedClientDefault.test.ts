import { describe, expect, it } from 'bun:test'
import { EmbedClient, DEFAULT_EMBED_MODEL } from '../../index/embedClient.js'

describe('EmbedClient default model', () => {
  // Until 2026-11-17 the default was jina-code-embeddings-0.5b, which Ollama's library does not
  // have: every session fell back to nomic and fired one pull that could not succeed (F233 i).
  it('defaults to nomic-embed-text when LOCALCODE_EMBED_MODEL is unset', () => {
    const orig = process.env.LOCALCODE_EMBED_MODEL
    delete process.env.LOCALCODE_EMBED_MODEL
    try {
      expect(new EmbedClient().modelName).toBe('nomic-embed-text')
      expect(DEFAULT_EMBED_MODEL).toBe('nomic-embed-text')
    } finally {
      if (orig !== undefined) process.env.LOCALCODE_EMBED_MODEL = orig
    }
  })

  it('honors LOCALCODE_EMBED_MODEL override', () => {
    const orig = process.env.LOCALCODE_EMBED_MODEL
    process.env.LOCALCODE_EMBED_MODEL = 'some-other-model'
    try {
      expect(new EmbedClient().modelName).toBe('some-other-model')
    } finally {
      if (orig === undefined) delete process.env.LOCALCODE_EMBED_MODEL
      else process.env.LOCALCODE_EMBED_MODEL = orig
    }
  })

  it('the jina model is opt-in: asked for by name, it is what the client uses', () => {
    const orig = process.env.LOCALCODE_EMBED_MODEL
    process.env.LOCALCODE_EMBED_MODEL = 'jina-code-embeddings-0.5b'
    try {
      const client = new EmbedClient()
      expect(client.modelName).toBe('jina-code-embeddings-0.5b')
      expect(client.fallbackModelName).toBe('nomic-embed-text')
    } finally {
      if (orig === undefined) delete process.env.LOCALCODE_EMBED_MODEL
      else process.env.LOCALCODE_EMBED_MODEL = orig
    }
  })

  it('exposes a fallback model name (nomic) for degraded operation', () => {
    expect(new EmbedClient().fallbackModelName).toBe('nomic-embed-text')
  })
})
