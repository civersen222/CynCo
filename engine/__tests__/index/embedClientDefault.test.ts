import { describe, expect, it } from 'bun:test'
import { EmbedClient } from '../../index/embedClient.js'

describe('EmbedClient default model', () => {
  it('defaults to jina-code-embeddings-0.5b when LOCALCODE_EMBED_MODEL is unset', () => {
    const orig = process.env.LOCALCODE_EMBED_MODEL
    delete process.env.LOCALCODE_EMBED_MODEL
    try {
      expect(new EmbedClient().modelName).toBe('jina-code-embeddings-0.5b')
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

  it('exposes a fallback model name (nomic) for degraded operation', () => {
    expect(new EmbedClient().fallbackModelName).toBe('nomic-embed-text')
  })
})
