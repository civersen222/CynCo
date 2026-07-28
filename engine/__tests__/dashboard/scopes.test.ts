/**
 * Dashboard capability scopes.
 *
 * Removing `Access-Control-Allow-Origin: *` stopped a cross-origin page READING
 * the replies. It did nothing about anything that can make a request without a
 * browser, and nothing at all about the POST /config/* routes: those were never
 * protected by CORS, because `Content-Type: text/plain` makes the request
 * "simple" (no preflight) and `req.json()` parses the body regardless of the
 * declared type. The response was unreadable; the mutation had already landed.
 *
 * So: a token, carrying scopes.
 *
 *   inference   read the governance surface, open the event stream, chat
 *   management  change engine or governance configuration
 *
 * One record shape with a scope vector rather than one key type per capability
 * (Millwright's ApiKey): adding a capability adds a scope, not a branch at every
 * call site. `admin` holds both, which is why a management token also reads.
 *
 * Delivery differs by scope, deliberately:
 *
 *   The inference token is injected into the page at request time. It is the
 *   less dangerous of the two and the page cannot function without it. GET / is
 *   ungated for exactly this reason — it is the delivery mechanism, and with no
 *   ACAO a cross-origin page cannot read what it delivers.
 *
 *   The management token is never handed to a page. It is printed once at engine
 *   startup and pasted by hand, because flipping `ablation` or
 *   `contractEnforcement` silently corrupts the measurements the research rests
 *   on, and that should cost one deliberate act.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, test, expect, afterAll } from 'vitest'
import WebSocket from 'ws'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const dir = mkdtempSync(join(tmpdir(), 'cynco-dash-scopes-'))
const tokens = loadOrCreateTokens(dir)
const INFERENCE = tokens.tokenFor('inference')!
const MANAGEMENT = tokens.tokenFor('management')!

const PORT = 19190
const server = new DashboardServer({ port: PORT, tokens })

afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const url = (path: string) => `http://127.0.0.1:${PORT}${path}`
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

const READ_ROUTES = [
  '/api/governance',
  '/api/predictions',
  '/api/contracts',
  '/api/params',
  '/api/history',
  '/api/sessions',
  '/api/session',
  '/api/subsystems',
  '/api/training',
  '/api/thinking/sessions',
  '/api/sessions/abc/measurements',
  '/api/sessions/abc/transcript',
]

const WRITE_ROUTES = [
  '/config/engine',
  '/config/governance',
  '/config/tools',
  '/config/system',
  '/api/brain/layer',
]

describe('reading the governance surface needs the inference scope', () => {
  test.each(READ_ROUTES)('%s refuses an anonymous caller', async (path) => {
    const res = await fetch(url(path))
    expect(res.status).toBe(401)
  })

  test.each(READ_ROUTES)('%s answers a caller holding inference', async (path) => {
    const res = await fetch(url(path), { headers: bearer(INFERENCE) })
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  test('a management token reads too — it holds inference as well', async () => {
    const res = await fetch(url('/api/governance'), { headers: bearer(MANAGEMENT) })
    expect(res.status).toBe(200)
  })

  test('a wrong token of the right shape is refused', async () => {
    const res = await fetch(url('/api/governance'), { headers: bearer('a'.repeat(64)) })
    expect(res.status).toBe(401)
  })

  test('an unknown route still refuses before answering 404', async () => {
    // Otherwise the 404 surface itself reports which routes exist.
    const res = await fetch(url('/api/nope'))
    expect(res.status).toBe(401)
  })

  test('a token in the query string is not accepted on an API route', async () => {
    // Query strings reach access logs, shell history and Referer headers. The
    // WebSocket route has no alternative and is the sole exception.
    const res = await fetch(url(`/api/governance?token=${INFERENCE}`))
    expect(res.status).toBe(401)
  })
})

describe('the page is served ungated, carrying the inference token', () => {
  test('GET / needs no token', async () => {
    const res = await fetch(url('/'))
    expect(res.status).toBe(200)
  })

  test('the served page contains the inference token and not the management one', async () => {
    const body = await fetch(url('/')).then(r => r.text())
    expect(body).toContain(INFERENCE)
    expect(body).not.toContain(MANAGEMENT)
  })

  test('the injected script parses', async () => {
    // It is assembled as a string in TypeScript, so nothing else type-checks or
    // even parses it, and a stray brace would take the whole dashboard down —
    // including the fetch wrapper every other request depends on. new Function
    // compiles without running, which is exactly the check wanted here.
    const body = await fetch(url('/')).then(r => r.text())
    const script = body.match(/<script>([\s\S]*?)<\/script>/)
    expect(script).not.toBeNull()
    // The injected block must be the FIRST script on the page: anything running
    // ahead of the wrapper would call the raw fetch and be refused.
    expect(script![1]).toContain('__CYNCO_TOKEN')
    expect(() => new Function(script![1])).not.toThrow()
  })

  test('the page is not readable cross-origin, which is what makes that safe', async () => {
    const res = await fetch(url('/'), { headers: { Origin: 'http://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('changing configuration needs the management scope', () => {
  test.each(WRITE_ROUTES)('%s refuses an anonymous caller', async (path) => {
    const res = await fetch(url(path), {
      method: 'POST',
      // text/plain is the shape that skips preflight — the exact request CORS
      // never stopped. It must now die on the token check.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ layer: 1, temperature: 0.5 }),
    })
    expect(res.status).toBe(401)
  })

  test.each(WRITE_ROUTES)('%s refuses a caller holding only inference', async (path) => {
    // 403, not 401: the caller proved who they are and still may not do this.
    // The inference token is handed to a browser page, so it is the secret most
    // likely to escape, and it must not carry configuration rights with it.
    const res = await fetch(url(path), {
      method: 'POST',
      headers: { ...bearer(INFERENCE), 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer: 1, temperature: 0.5 }),
    })
    expect(res.status).toBe(403)
  })

  test('the management token is accepted', async () => {
    const res = await fetch(url('/config/engine'), {
      method: 'POST',
      headers: { ...bearer(MANAGEMENT), 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 0.5 }),
    })
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

describe('the event stream needs the inference scope', () => {
  /** Resolve on open, or reject with the handshake status the server sent. */
  function handshake(query: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`)
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(ws))
      ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
      ws.on('error', reject)
    })
  }

  test('refuses an upgrade with no token', async () => {
    // The stream carries the same conversation content as the transcript route.
    await expect(handshake('')).rejects.toThrow('status 401')
  })

  test('refuses a wrong token', async () => {
    await expect(handshake(`?token=${'a'.repeat(64)}`)).rejects.toThrow('status 401')
  })

  test('accepts the inference token from the query string', async () => {
    // A browser cannot set headers on a WebSocket handshake. This route is the
    // reason the query-string form exists at all.
    const ws = await handshake(`?token=${INFERENCE}`)
    ws.close()
  })
})
