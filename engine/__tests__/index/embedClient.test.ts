import { describe, expect, it } from 'bun:test'
import { EmbedClient } from '../../index/embedClient.js'

describe('EmbedClient', () => {
  it('uses LOCALCODE_EMBED_BASE_URL when set', () => {
    const origEnv = process.env.LOCALCODE_EMBED_BASE_URL
    process.env.LOCALCODE_EMBED_BASE_URL = 'http://192.168.1.100:11434'

    try {
      const client = new EmbedClient()
      expect(client.modelName).toBeDefined()
      expect(client.baseUrlUsed).toBe('http://192.168.1.100:11434')
    } finally {
      if (origEnv === undefined) delete process.env.LOCALCODE_EMBED_BASE_URL
      else process.env.LOCALCODE_EMBED_BASE_URL = origEnv
    }
  })

  it('falls back to constructor baseUrl when LOCALCODE_EMBED_BASE_URL is not set', () => {
    const origEnv = process.env.LOCALCODE_EMBED_BASE_URL
    delete process.env.LOCALCODE_EMBED_BASE_URL

    try {
      const client = new EmbedClient('http://localhost:11434')
      expect(client.modelName).toBeDefined()
      expect(client.baseUrlUsed).toBe('http://localhost:11434')
    } finally {
      if (origEnv !== undefined) process.env.LOCALCODE_EMBED_BASE_URL = origEnv
    }
  })
})
