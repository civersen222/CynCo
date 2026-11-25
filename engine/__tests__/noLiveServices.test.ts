import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EmbedClient } from '../index/embedClient.js'
import { guardIsOn } from './setup/noLiveServices.js'

describe('what turns the guard off', () => {
  it('only the switch that asks for the live-server test', () => {
    expect(guardIsOn({})).toBe(true)
    expect(guardIsOn({ LOCALCODE_INTEGRATION_TESTS: '1' })).toBe(false)
  })

  // Until 2026-11-17 CYNCO_INTEGRATION took the guard off for the whole run. The tests it enables
  // use a scripted model and need no server, so setting it on the owner's PC bought nothing and
  // put the owner's Ollama, model server and dashboard in reach of every test in the suite.
  // Since 2026-11-24 it gates no test at all (F244); the guard must still ignore it.
  it('not CYNCO_INTEGRATION, which no longer gates any test', () => {
    expect(guardIsOn({ CYNCO_INTEGRATION: '1' })).toBe(true)
    expect(guardIsOn({ CYNCO_INTEGRATION: '1', LOCALCODE_INTEGRATION_TESTS: '0' })).toBe(true)
  })
})

// Captured at file load: vitest.config.ts must have run setup/noLiveServices.ts
// already, so this is the wrapper every test in the suite starts with (F206).
const suiteFetch = globalThis.fetch

describe('the suite does not reach this machine\'s live services', () => {
  for (const url of [
    'http://localhost:11434/api/embed',
    'http://127.0.0.1:11434/v1/embeddings',
    'http://127.0.0.1:8081/health',
    'http://127.0.0.1:9161/api/session',
    'http://127.0.0.1:9165/v1/embeddings',
  ]) {
    it(`fetch to ${url} fails at once as a closed port does`, async () => {
      const started = Date.now()
      const err: any = await suiteFetch(url, { method: 'POST', body: '{}' }).then(() => null, e => e)
      expect(err, 'the request must not have been sent').toBeInstanceOf(TypeError)
      expect(err.message).toBe('fetch failed')
      expect(err.cause?.code).toBe('ECONNREFUSED')
      expect(String(err.cause?.message)).toMatch(/does not reach/)
      expect(Date.now() - started).toBeLessThan(200)
    })
  }

  it('the embedding client on its defaults finds no server: nothing is embedded, nothing is pulled', async () => {
    const client = new EmbedClient()
    expect(client.baseUrlUsed).toBe('http://localhost:11434')
    expect(await client.embedWithDeadline('hello', 1000)).toBeUndefined()
    expect(await client.healthCheck()).toBe(false)
  })

  it('a server the test started itself is reached as before', async () => {
    const server = createServer((_req, res) => { res.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const resp = await suiteFetch(`http://127.0.0.1:${port}/`)
      expect(await resp.text()).toBe('ok')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('names the service by port on a loopback host only', async () => {
    const { liveServiceOf } = await import('./setup/noLiveServices.js')
    expect(liveServiceOf('http://localhost:11434/api/tags')).toBe('Ollama')
    expect(liveServiceOf(new URL('http://127.0.0.1:8081/health'))).toBe('the model server (llama-server)')
    expect(liveServiceOf({ url: 'http://[::1]:9161/' })).toBe('the dashboard')
    expect(liveServiceOf('http://192.168.0.47:11434/api/tags')).toBeNull()
    expect(liveServiceOf('http://127.0.0.1:54321/')).toBeNull()
    expect(liveServiceOf('not a url')).toBeNull()
  })
})
