/**
 * Dashboard server security: localhost binding.
 *
 * Verifies that DashboardServer defaults to 127.0.0.1 and respects
 * the LOCALCODE_DASHBOARD_HOST override.
 *
 * The bunShim forwards `hostname` to Node's http.listen(), so these
 * tests exercise the real binding path under vitest.
 */

import * as os from 'os'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { DashboardServer } from '../../dashboard/server.js'

// Use ports well away from the main test suite (port 19161)
const DEFAULT_PORT = 19171
const OVERRIDE_PORT = 19172
const NEGATIVE_PORT = 19173
const TRAVERSAL_PORT = 19174
const CORS_PORT = 19175

describe('dashboard server hostname binding', () => {
  let server: DashboardServer
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.LOCALCODE_DASHBOARD_HOST
  })

  afterEach(() => {
    server?.stop()
    if (savedEnv !== undefined) {
      process.env.LOCALCODE_DASHBOARD_HOST = savedEnv
    } else {
      delete process.env.LOCALCODE_DASHBOARD_HOST
    }
  })

  test('defaults to 127.0.0.1 when LOCALCODE_DASHBOARD_HOST is unset', async () => {
    delete process.env.LOCALCODE_DASHBOARD_HOST

    server = new DashboardServer({ port: DEFAULT_PORT })

    // getHostname() returns the stored value used in Bun.serve()
    expect(server.getHostname()).toBe('127.0.0.1')

    // HTTP request to 127.0.0.1 must succeed
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('CynCo Governance Dashboard')
  })
})

describe('dashboard server LOCALCODE_DASHBOARD_HOST override', () => {
  let server: DashboardServer

  afterAll(() => {
    server?.stop()
  })

  test('honors LOCALCODE_DASHBOARD_HOST env var', async () => {
    const saved = process.env.LOCALCODE_DASHBOARD_HOST
    process.env.LOCALCODE_DASHBOARD_HOST = '0.0.0.0'

    try {
      server = new DashboardServer({ port: OVERRIDE_PORT })

      expect(server.getHostname()).toBe('0.0.0.0')

      // HTTP request must succeed (0.0.0.0 binds all interfaces, localhost still works)
      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${OVERRIDE_PORT}/`)
      expect(res.status).toBe(200)
    } finally {
      if (saved !== undefined) {
        process.env.LOCALCODE_DASHBOARD_HOST = saved
      } else {
        delete process.env.LOCALCODE_DASHBOARD_HOST
      }
    }
  })
})

describe('dashboard server negative binding (non-loopback refused)', () => {
  let server: DashboardServer | undefined

  afterAll(() => {
    server?.stop()
  })

  test('connection to non-loopback IP is refused when bound to 127.0.0.1', async () => {
    // Find the first non-internal IPv4 address on this machine
    const ifaces = os.networkInterfaces()
    let externalIP: string | undefined
    for (const iface of Object.values(ifaces)) {
      if (!iface) continue
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          externalIP = addr.address
          break
        }
      }
      if (externalIP) break
    }

    // Skip gracefully if no non-internal IPv4 exists (e.g. CI with only loopback)
    if (!externalIP) {
      // No non-internal IPv4 interface available — skip
      return
    }

    const saved = process.env.LOCALCODE_DASHBOARD_HOST
    delete process.env.LOCALCODE_DASHBOARD_HOST

    try {
      server = new DashboardServer({ port: NEGATIVE_PORT })
      expect(server.getHostname()).toBe('127.0.0.1')

      await new Promise(r => setTimeout(r, 100))

      // Fetching via the external IP must be refused (connection error, not a response)
      await expect(
        fetch(`http://${externalIP}:${NEGATIVE_PORT}/`, { signal: AbortSignal.timeout(2000) })
      ).rejects.toThrow()
    } finally {
      server?.stop()
      server = undefined
      if (saved !== undefined) {
        process.env.LOCALCODE_DASHBOARD_HOST = saved
      } else {
        delete process.env.LOCALCODE_DASHBOARD_HOST
      }
    }
  })
})

/**
 * getSessionTranscript joined `~/.cynco/sessions` to an unvalidated path segment
 * and read whatever came back. Both of its siblings — getThinkingTurns and
 * getThinkingTurn — already guard with SESSION_ID_RE; this one had drifted away
 * from them, so `..%2f..%2f` walked out of the sessions directory to any .jsonl
 * on disk. The route returns the raw session journal, so what it reads is every
 * file the Read tool pulled in, every diff, every Bash output.
 */
describe('the transcript route cannot walk out of the sessions directory', () => {
  let server: DashboardServer
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cynco-dash-sessions-'))
    server = new DashboardServer({ port: TRAVERSAL_PORT, deps: { sessionsDir: dir } })
  })

  afterEach(() => {
    server?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test.each([
    ['percent-encoded separators', '..%2f..%2fsecrets'],
    ['double-encoded separators', '..%252f..%252fsecrets'],
    ['a backslash separator', '..%5c..%5csecrets'],
    ['an absolute-looking id', 'C%3a%2fWindows%2fwin.ini'],
    ['a null byte', 'abc%00.jsonl'],
  ])('refuses %s instead of reading a file', async (_name, sid) => {
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${TRAVERSAL_PORT}/api/sessions/${sid}/transcript`)
    // 400, not an empty 200: "no such session" and "that is not a session id"
    // are different answers and the caller must be able to tell them apart.
    expect(res.status).toBe(400)
  })

  test('still reads a transcript for a well-formed session id', async () => {
    writeFileSync(join(dir, 'sess-1.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + '\n')
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${TRAVERSAL_PORT}/api/sessions/sess-1/transcript`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ role: 'user', content: 'hi' }])
  })
})

/**
 * `Access-Control-Allow-Origin: *` was set on every response, including
 * /api/sessions/<id>/transcript and /api/thinking. Any page open in any browser
 * on this machine could chain the session list to the transcript route and READ
 * the replies — the header is exactly the grant that makes a cross-origin
 * response readable. Loopback binding does not help: the browser is already
 * inside loopback.
 *
 * The dashboard page is served from this same origin and needs no CORS grant at
 * all, so the honest value is no header rather than a narrower one.
 */
describe('responses do not grant cross-origin reads', () => {
  let server: DashboardServer

  beforeEach(() => {
    server = new DashboardServer({ port: CORS_PORT })
  })

  afterEach(() => {
    server?.stop()
  })

  test.each([
    ['a JSON api route', '/api/governance', 'GET'],
    ['the index page', '/', 'GET'],
    ['a 404', '/api/nope', 'GET'],
    ['the preflight', '/config/engine', 'OPTIONS'],
  ])('sends no ACAO header on %s', async (_name, path, method) => {
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${CORS_PORT}${path}`, {
      method,
      headers: { Origin: 'http://evil.example' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
  })
})
