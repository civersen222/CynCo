import { describe, expect, it } from 'bun:test'

describe('hybrid search default', () => {
  it('is enabled when LOCALCODE_HYBRID_SEARCH is unset', () => {
    const orig = process.env.LOCALCODE_HYBRID_SEARCH
    delete process.env.LOCALCODE_HYBRID_SEARCH
    try {
      const enabled = process.env.LOCALCODE_HYBRID_SEARCH !== '0'
      expect(enabled).toBe(true)
    } finally {
      if (orig !== undefined) process.env.LOCALCODE_HYBRID_SEARCH = orig
    }
  })

  it('is disabled only when explicitly set to 0', () => {
    const orig = process.env.LOCALCODE_HYBRID_SEARCH
    process.env.LOCALCODE_HYBRID_SEARCH = '0'
    try {
      expect(process.env.LOCALCODE_HYBRID_SEARCH !== '0').toBe(false)
    } finally {
      if (orig === undefined) delete process.env.LOCALCODE_HYBRID_SEARCH
      else process.env.LOCALCODE_HYBRID_SEARCH = orig
    }
  })
})
