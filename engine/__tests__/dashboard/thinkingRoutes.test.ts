/**
 * Dashboard thinking replay routes — GET /api/thinking/turns and GET /api/thinking
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DashboardServer } from '../../dashboard/server.js'

// Use port 0 so the OS assigns an ephemeral port — avoids TIME_WAIT collisions
// when the full dashboard suite runs all 4 test files in parallel.
const SESSIONS_DIR = join(tmpdir(), `cynco-thinking-test-${process.pid}`)

let server: DashboardServer
let BASE: string

beforeAll(async () => {
  // Create fixture dir + jsonl
  mkdirSync(SESSIONS_DIR, { recursive: true })

  // s1.thinking.jsonl: 2 valid records + 1 corrupt line
  const line1 = JSON.stringify({ turn: 1, ts: 1000, text: 'a', tokenCount: 10, durationMs: 100, entropy: null })
  const line2 = JSON.stringify({ turn: 2, ts: 2000, text: 'bb', tokenCount: 20, durationMs: 200, entropy: null })
  const corrupt = 'NOT_JSON{{{'
  writeFileSync(join(SESSIONS_DIR, 's1.thinking.jsonl'), [line1, corrupt, line2].join('\n') + '\n')

  server = new DashboardServer({ port: 0, deps: { sessionsDir: SESSIONS_DIR } })
  // Poll until the server is ready (max 2 s) instead of a fixed sleep.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const port = server.getPort()
    if (port > 0) {
      try { await fetch(`http://localhost:${port}/api/thinking/turns?session=__probe`); break } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 10))
  }
  BASE = `http://localhost:${server.getPort()}`
})

afterAll(() => {
  server.stop()
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }) } catch (err) { console.log('[test] cleanup failed:', err) }
})

// ── GET /api/thinking/turns ────────────────────────────────────────

describe('GET /api/thinking/turns', () => {
  it('returns 200 index array with no text field', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns?session=s1`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    // Index fields present
    expect(data[0]).toHaveProperty('turn', 1)
    expect(data[0]).toHaveProperty('ts')
    expect(data[0]).toHaveProperty('tokenCount')
    expect(data[0]).toHaveProperty('durationMs')
    expect(data[0]).toHaveProperty('entropy')
    // text MUST NOT be present
    expect(data[0]).not.toHaveProperty('text')
    expect(data[1]).toHaveProperty('turn', 2)
    expect(data[1]).not.toHaveProperty('text')
  })

  it('skips corrupt line — still returns 2 valid records', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns?session=s1`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data).toHaveLength(2)
  })

  it('returns 404 when session file does not exist', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns?session=no_such_session`)
    expect(res.status).toBe(404)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'Not found')
  })

  it('returns 400 for session id with path separators (slash)', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns?session=a/b`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid session id')
  })

  it('returns 400 for session id with URL-encoded path traversal', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns?session=..%2Fetc`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid session id')
  })

  it('returns 400 when session param is missing', async () => {
    const res = await fetch(`${BASE}/api/thinking/turns`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid session id')
  })
})

// ── GET /api/thinking ─────────────────────────────────────────────

describe('GET /api/thinking', () => {
  it('returns 200 full record including text for valid turn', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=s1&turn=2`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data).toHaveProperty('turn', 2)
    expect(data).toHaveProperty('text', 'bb')
    expect(data).toHaveProperty('tokenCount', 20)
    expect(data).toHaveProperty('durationMs', 200)
    expect(data).toHaveProperty('entropy', null)
  })

  it('returns 404 for valid session but missing turn number', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=s1&turn=99`)
    expect(res.status).toBe(404)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'Not found')
  })

  it('returns 404 for missing session', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=ghost&turn=1`)
    expect(res.status).toBe(404)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'Not found')
  })

  it('returns 400 for non-numeric turn', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=s1&turn=abc`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid turn')
  })

  it('returns 400 for session id with path separators', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=a/b&turn=1`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid session id')
  })

  it('returns 400 for URL-encoded path traversal in session', async () => {
    const res = await fetch(`${BASE}/api/thinking?session=..%2Fetc&turn=1`)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data).toHaveProperty('error', 'invalid session id')
  })
})

// ── POST /api/brain/layer ──────────────────────────────────────────

describe('POST /api/brain/layer', () => {
  it('returns 503 when no setBrainLayer dep is wired', async () => {
    // shared server above has no setBrainLayer dep
    const res = await fetch(`${BASE}/api/brain/layer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer: 40 }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toHaveProperty('error', 'no consumer')
  })

  it('calls the dep and returns ok for a valid layer; 400 on invalid bodies', async () => {
    const calls: number[] = []
    const srv = new DashboardServer({ port: 0, deps: { setBrainLayer: (n) => calls.push(n) } })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const port = srv.getPort()
      if (port > 0) {
        try { await fetch(`http://localhost:${port}/api/thinking/turns?session=__probe`); break } catch { /* not ready yet */ }
      }
      await new Promise(r => setTimeout(r, 10))
    }
    const base = `http://localhost:${srv.getPort()}`
    try {
      const ok = await fetch(`${base}/api/brain/layer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer: 32 }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toHaveProperty('ok', true)
      expect(calls).toEqual([32])

      for (const bad of [{ layer: 'x' }, { layer: 3.5 }, { layer: -1 }, { layer: 999 }, {}]) {
        const res = await fetch(`${base}/api/brain/layer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bad),
        })
        expect(res.status).toBe(400)
      }
      expect(calls).toEqual([32])
    } finally {
      srv.stop()
    }
  })
})
