import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { DashboardServer } from '../../dashboard/server.js'
import { resetParams, getParam } from '../../vsm/governanceParams.js'
import { globalContract } from '../../tools/contract.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadOrCreateTokens } from '../../security/localToken.js'

// Every route but GET / now requires a capability token (see
// dashboard/scopes.test.ts). These suites are testing behaviour behind the gate,
// so they present the admin secret, which holds both inference and management.
const _tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-test-'))
const _tokens = loadOrCreateTokens(_tokenDir)
const _ADMIN = _tokens.tokenFor('management')!
process.on('exit', () => rmSync(_tokenDir, { recursive: true, force: true }))

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${_ADMIN}`)
  return fetch(url, { ...init, headers })
}


// Distinct from bridge/server.test.ts (19161) and dashboard/security.test.ts
// (19171-19173) so parallel vitest workers never collide on a bound port.
const PORT = 19181
const BASE = `http://localhost:${PORT}`

let server: DashboardServer

beforeAll(async () => {
  server = new DashboardServer({ port: PORT, tokens: _tokens })
  // Wait for the server to be listening
  await new Promise(r => setTimeout(r, 100))
})

afterAll(() => {
  server.stop()
})

beforeEach(() => {
  resetParams()
  globalContract.clear()
})

// ── GET / ─────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns HTML with dashboard title', async () => {
    const res = await authFetch(`${BASE}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('CynCo Governance Dashboard')
  })
})

// ── GET /api/params ───────────────────────────────────────────────

describe('GET /api/params', () => {
  it('returns array with name/min/max/system fields', async () => {
    const res = await authFetch(`${BASE}/api/params`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    // Each entry should have the expected fields
    const first = data[0]
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('min')
    expect(first).toHaveProperty('max')
    expect(first).toHaveProperty('system')
    expect(first).toHaveProperty('value')
    expect(first).toHaveProperty('default')
    expect(first).toHaveProperty('description')
  })
})

// ── GET /api/governance ───────────────────────────────────────────

describe('GET /api/governance', () => {
  it('returns null when no deps provided', async () => {
    const res = await authFetch(`${BASE}/api/governance`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })
})

// ── GET /api/contracts ────────────────────────────────────────────

describe('GET /api/contracts', () => {
  it('returns null when no active contract', async () => {
    const res = await authFetch(`${BASE}/api/contracts`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })

  it('returns contract status when active', async () => {
    globalContract.create('Test Contract', 'testing', ['assert1', 'assert2'])
    const res = await authFetch(`${BASE}/api/contracts`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.active).toBe(true)
    expect(data.complete).toBe(false)
    expect(data.pending).toBe(2)
  })
})

// ── POST /config/governance ───────────────────────────────────────

describe('POST /config/governance', () => {
  it('sets valid params and verifies with getParam', async () => {
    const res = await authFetch(`${BASE}/config/governance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'homeostat.damping': 1.5 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.applied['homeostat.damping']).toBe(1.5)
    expect(data.errors).toHaveLength(0)
    // Verify the param was actually set
    expect(getParam('homeostat.damping')).toBe(1.5)
  })

  it('rejects unknown params', async () => {
    const res = await authFetch(`${BASE}/config/governance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'totally.fake.param': 42 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Object.keys(data.applied)).toHaveLength(0)
    expect(data.errors.length).toBeGreaterThan(0)
    expect(data.errors[0].field).toBe('totally.fake.param')
  })
})

// ── POST /config/engine ───────────────────────────────────────────

describe('POST /config/engine', () => {
  it('rejects temperature out of range', async () => {
    const res = await authFetch(`${BASE}/config/engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 5.0 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Object.keys(data.applied)).toHaveLength(0)
    expect(data.errors.length).toBeGreaterThan(0)
    expect(data.errors[0].field).toBe('temperature')
  })

  it('rejects invalid JSON body', async () => {
    const res = await authFetch(`${BASE}/config/engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    })
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error).toContain('Invalid JSON')
  })

  it('accepts valid temperature', async () => {
    const res = await authFetch(`${BASE}/config/engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 0.5 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.applied.temperature).toBe(0.5)
    expect(data.errors).toHaveLength(0)
  })
})

// ── WebSocket broadcast ───────────────────────────────────────────

describe('WebSocket broadcast', () => {
  it('sends events to connected clients', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${_ADMIN}`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })

    // Give server a moment to register the connection
    await new Promise(r => setTimeout(r, 50))

    const received: string[] = []
    ws.onmessage = (event) => { received.push(typeof event.data === 'string' ? event.data : event.data.toString()) }

    server.broadcast({ type: 'stream.token', text: 'hello from dashboard' })

    await new Promise(r => setTimeout(r, 100))
    expect(received).toHaveLength(1)
    const parsed = JSON.parse(received[0])
    expect(parsed.type).toBe('stream.token')
    expect(parsed.text).toBe('hello from dashboard')

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('is no-op when no clients connected', () => {
    // Should not throw
    expect(() => {
      server.broadcast({ type: 'stream.token', text: 'nobody listening' })
    }).not.toThrow()
  })

  it('replays last brain.tier to late-joining clients', async () => {
    // brain.tier fires once at engine startup, before any browser connects
    server.broadcast({ type: 'brain.tier', tier: 'live', layers: [24, 32], layer: 40 } as never)

    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${_ADMIN}`)
    const received: string[] = []
    ws.onmessage = (event) => { received.push(typeof event.data === 'string' ? event.data : event.data.toString()) }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 100))

    const tiers = received.map(m => JSON.parse(m)).filter(m => m.type === 'brain.tier')
    expect(tiers).toHaveLength(1)
    expect(tiers[0].tier).toBe('live')
    expect(tiers[0].layers).toEqual([24, 32])
    expect(tiers[0].layer).toBe(40)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('does not replay non-whitelisted event types', async () => {
    server.broadcast({ type: 'stream.token', text: 'ephemeral' })

    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${_ADMIN}`)
    const received: string[] = []
    ws.onmessage = (event) => { received.push(typeof event.data === 'string' ? event.data : event.data.toString()) }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 100))

    const tokens = received.map(m => JSON.parse(m)).filter(m => m.type === 'stream.token')
    expect(tokens).toHaveLength(0)

    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })
})

// ── CORS headers ──────────────────────────────────────────────────
//
// These two cases used to assert `Access-Control-Allow-Origin: *`, i.e. they
// pinned the hole open: the grant that let any page in any browser on this
// machine read /api/sessions/<id>/transcript. The dashboard is same-origin and
// never needed a grant. Kept here (rather than deleted) so the diff shows the
// assertion being inverted, not quietly dropped. See dashboard/security.test.ts
// for the full statement of what the header was giving away.

describe('CORS', () => {
  it('does not hand out a cross-origin read grant', async () => {
    const res = await authFetch(`${BASE}/api/params`)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers OPTIONS without granting the preflight', async () => {
    const res = await authFetch(`${BASE}/config/engine`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

// ── GET /api/history ──────────────────────────────────────────────

describe('GET /api/history', () => {
  it('returns an array (possibly empty)', async () => {
    const res = await authFetch(`${BASE}/api/history`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })
})

// ── POST /config/system ───────────────────────────────────────────

describe('POST /config/system', () => {
  it('sets contractEnforcement', async () => {
    const res = await authFetch(`${BASE}/config/system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractEnforcement: false }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.applied.contractEnforcement).toBe(false)
    expect(globalContract.isEnforcementEnabled()).toBe(false)
  })

  it('rejects unknown system fields', async () => {
    const res = await authFetch(`${BASE}/config/system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bogusField: true }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.errors.length).toBeGreaterThan(0)
  })
})

// ── POST /config/tools ────────────────────────────────────────────

describe('POST /config/tools', () => {
  it('rejects trustDecayThreshold out of range', async () => {
    const res = await authFetch(`${BASE}/config/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trustDecayThreshold: 5.0 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.errors.length).toBeGreaterThan(0)
    expect(data.errors[0].field).toBe('trustDecayThreshold')
  })

  it('accepts valid toolRouting boolean', async () => {
    const res = await authFetch(`${BASE}/config/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolRouting: true }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.applied.toolRouting).toBe(true)
    expect(data.errors).toHaveLength(0)
  })
})

// ── getPort() ─────────────────────────────────────────────────────

describe('getPort()', () => {
  it('returns the configured port', () => {
    expect(server.getPort()).toBe(PORT)
  })
})

// ── integration: event flow ───────────────────────────────────────

describe('integration: event flow', () => {
  it('governance.status event reaches WS client', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${_ADMIN}`)
    const received: any[] = []

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 50))
    ws.onmessage = (e) => received.push(JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()))

    server.broadcast({
      type: 'governance.status',
      health: 'healthy',
      s3s4Balance: 'balanced',
      toolSuccessRate: 0.94,
      stuckTurns: 0,
      varietyRatio: 0.72,
      axiomHealth: { holding: 3, total: 3, violations: [] },
    } as any)

    await new Promise(r => setTimeout(r, 100))
    expect(received[0].type).toBe('governance.status')
    expect(received[0].toolSuccessRate).toBe(0.94)
    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })

  it('tool.start + tool.complete flow', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${_ADMIN}`)
    const received: any[] = []

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await new Promise(r => setTimeout(r, 50))
    ws.onmessage = (e) => received.push(JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()))

    server.broadcast({ type: 'tool.start', toolId: 'int-1', toolName: 'Edit', input: { file: 'test.ts' } } as any)
    server.broadcast({ type: 'tool.complete', toolId: 'int-1', toolName: 'Edit', result: 'ok', isError: false } as any)

    await new Promise(r => setTimeout(r, 100))
    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('tool.start')
    expect(received[1].isError).toBe(false)
    ws.close()
    await new Promise(r => setTimeout(r, 50))
  })
})

/**
 * F57 — /api/run is the only way anything outside the engine process can learn
 * whether the conversation loop still has a turn open.
 *
 * The mission driver used to decide a run was finished by watching its
 * WebSocket go silent. Gilded Wave 10 went silent, was graded, was written to
 * the ledger as landed — and kept executing model calls for another forty
 * minutes in the repo it had just been graded on, long enough to reconstruct
 * the held-out gate from stale bytecode and certify itself against it. Silence
 * is a symptom of stopping and equally a symptom of thinking. This route is the
 * difference between inferring and asking.
 */
describe('/api/run — is the turn still open', () => {
  const RUN_PORT = 19182
  const RUN_BASE = `http://localhost:${RUN_PORT}`
  let processing = false
  let runServer: DashboardServer
  let bareServer: DashboardServer

  beforeAll(async () => {
    runServer = new DashboardServer({
      port: RUN_PORT,
      tokens: _tokens,
      deps: { getRunState: () => ({ processing }) },
    })
    bareServer = new DashboardServer({ port: RUN_PORT + 6, tokens: _tokens })
    await new Promise(r => setTimeout(r, 100))
  })

  afterAll(() => {
    runServer.stop()
    bareServer.stop()
  })

  it('reports the loop state as the engine sees it, both ways', async () => {
    // Both directions, because a route hard-coded to either value passes a
    // one-sided test forever.
    processing = true
    expect(await authFetch(`${RUN_BASE}/api/run`).then(r => r.json())).toEqual({ processing: true })
    processing = false
    expect(await authFetch(`${RUN_BASE}/api/run`).then(r => r.json())).toEqual({ processing: false })
  })

  it('an engine that wired no run state answers null, not "not running"', async () => {
    // The caller has to be able to tell "the loop is idle" from "this engine
    // cannot say". Collapsing them is the F57 mistake one layer down: the
    // driver would read a missing answer as permission to grade.
    const res = await authFetch(`http://localhost:${RUN_PORT + 6}/api/run`)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('the route is behind the token gate like every other read', async () => {
    const res = await fetch(`${RUN_BASE}/api/run`)
    expect(res.status).toBe(401)
  })
})

// ── GET /api/sessions ─────────────────────────────────────────────

/**
 * This list is how the user sees their own work, and it showed them none of it:
 * a `sessions` row is written once, at session end, so every mission on a
 * server-mode engine that never exits was missing, and a mission still running
 * could not appear at all. The fix unions in the sessions that `measurements`
 * knows about and `sessions` does not.
 *
 * That union is mostly HISTORY — on the real governance.db, 63 finished
 * sessions to 1 live one — so the label matters as much as the row.
 */
describe('GET /api/sessions', () => {
  const SESS_PORT = 19191
  const SESS_BASE = `http://localhost:${SESS_PORT}`
  let sessServer: DashboardServer
  let currentSessionId = 'sess-live'

  const fakeDb = {
    getLiveSessions: () => ([
      { sessionId: 'sess-live', outcome: 'unrecorded', configIndex: 0, strategy: '',
        toolSuccessRate: 1, stuckTurns: 0, totalTurns: 12, filesChanged: 0 },
      { sessionId: 'sess-abandoned', outcome: 'unrecorded', configIndex: 0, strategy: '',
        toolSuccessRate: 1, stuckTurns: 0, totalTurns: 400, filesChanged: 0 },
    ]),
    getRecentSessions: () => ([
      { sessionId: 'sess-done', outcome: 'viable', configIndex: 0, strategy: 'default',
        toolSuccessRate: 1, stuckTurns: 0, totalTurns: 30, filesChanged: 2 },
    ]),
  }

  beforeAll(async () => {
    sessServer = new DashboardServer({
      port: SESS_PORT,
      tokens: _tokens,
      deps: {
        getGovernance: () => ({
          getGovernanceDb: () => fakeDb,
          getSessionId: () => currentSessionId,
        }),
      } as any,
    })
    await new Promise(r => setTimeout(r, 100))
  })

  afterAll(() => { sessServer.stop() })

  it('lists sessions that have no outcome row alongside the ones that do', async () => {
    const rows = await authFetch(`${SESS_BASE}/api/sessions`).then(r => r.json()) as any[]
    const ids = rows.map(r => r.sessionId)
    expect(ids).toContain('sess-live')
    expect(ids).toContain('sess-abandoned')
    expect(ids).toContain('sess-done')
  })

  it('calls only the engine\'s actual session running, and the rest unrecorded', async () => {
    const rows = await authFetch(`${SESS_BASE}/api/sessions`).then(r => r.json()) as any[]
    const by = (id: string) => rows.find(r => r.sessionId === id)
    expect(by('sess-live').outcome).toBe('running')
    // The one that matters. This session ended long ago and will never get an
    // outcome; calling it 'running' would be a claim nobody checked, repeated
    // dozens of times down the list.
    expect(by('sess-abandoned').outcome).toBe('unrecorded')
    expect(by('sess-done').outcome).toBe('viable')
  })

  it('follows the engine when the live session id changes', async () => {
    // A server-mode engine rotates session ids mission after mission. A label
    // computed once at boot would mark the wrong row forever.
    currentSessionId = 'sess-abandoned'
    const rows = await authFetch(`${SESS_BASE}/api/sessions`).then(r => r.json()) as any[]
    const by = (id: string) => rows.find(r => r.sessionId === id)
    expect(by('sess-abandoned').outcome).toBe('running')
    expect(by('sess-live').outcome).toBe('unrecorded')
    currentSessionId = 'sess-live'
  })
})

// Distinct from every other port range in this file so parallel workers cannot
// collide on the block this suite deliberately occupies.
const WALK_PORT = 19241

describe('port walking', () => {
  // The caller passes `wsServer.port + 1`, which is a wish rather than a free
  // port: the WS bridge falls back when its own first choice is taken, so +1
  // lands wherever that fallback put it. It has collided with the bridge in the
  // same process, and with the jlens sidecar on 9163. Both times the
  // constructor threw and the operator got no dashboard and no reason why.
  it('binds the next free port when the requested one is taken, and reports it', () => {
    const squatter = new DashboardServer({ port: WALK_PORT, tokens: _tokens })
    expect(squatter.getPort()).toBe(WALK_PORT)

    const walker = new DashboardServer({ port: WALK_PORT, tokens: _tokens })
    expect(walker.getPort()).toBe(WALK_PORT + 1)

    walker.stop()
    squatter.stop()
  })

  it('serves on the port it reports, not the one it was asked for', async () => {
    const squatter = new DashboardServer({ port: WALK_PORT + 4, tokens: _tokens })
    const walker = new DashboardServer({ port: WALK_PORT + 4, tokens: _tokens })

    const bound = walker.getPort()
    expect(bound).not.toBe(WALK_PORT + 4)
    const res = await fetch(`http://localhost:${bound}/`)
    expect(res.status).toBe(200)

    walker.stop()
    squatter.stop()
  })
})
