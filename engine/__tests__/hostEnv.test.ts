import { describe, expect, it } from 'vitest'

const KEPT = ['LOCALCODE_INTEGRATION_TESTS']

// Read at file load, before any test sets a key and before this file imports
// the setup module itself (importing it would clear the keys and prove
// nothing): vitest.config.ts must have run setup/hostEnv.ts already (F206).
const inheritedAtLoad = Object.keys(process.env).filter(k => k.startsWith('LOCALCODE_') && !KEPT.includes(k))

describe('hostEnv', () => {
  it('the suite starts with no LOCALCODE_* variable from the shell that launched it', () => {
    expect(inheritedAtLoad).toEqual([])
  })

  it('keeps only the switches that ask for more tests', async () => {
    const { KEPT_HOST_ENV } = await import('./setup/hostEnv.js')
    expect([...KEPT_HOST_ENV]).toEqual(KEPT)
  })

  it('clears a variable exported after the suite started, when run again', async () => {
    process.env.LOCALCODE_EMBED_BASE_URL = 'http://127.0.0.1:1'
    process.env.LOCALCODE_INTEGRATION_TESTS = '1'
    try {
      const { clearHostEnv } = await import('./setup/hostEnv.js')
      clearHostEnv()
      expect(process.env.LOCALCODE_EMBED_BASE_URL).toBeUndefined()
      expect(process.env.LOCALCODE_INTEGRATION_TESTS).toBe('1')
    } finally {
      delete process.env.LOCALCODE_EMBED_BASE_URL
      delete process.env.LOCALCODE_INTEGRATION_TESTS
    }
  })
})
