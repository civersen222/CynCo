import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { DashboardServer } from '../../dashboard/server.js'
import { resetParams, getParam } from '../../vsm/governanceParams.js'
import { globalContract } from '../../tools/contract.js'

const PORT = 19161
const BASE = `http://localhost:${PORT}`

let server: DashboardServer

beforeAll(async () => {
  server = new DashboardServer({ port: PORT })
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
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('CynCo Governance Dashboard')
  })
})

// ── GET /api/params ───────────────────────────────────────────────

describe('GET /api/params', () => {
  it('returns array with name/min/max/system fields', async () => {
    const res = await fetch(`${BASE}/api/params`)
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
    const res = await fetch(`${BASE}/api/governance`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })
})

// ── GET /api/contracts ────────────────────────────────────────────

describe('GET /api/contracts', () => {
  it('returns null when no active contract', async () => {
    const res = await fetch(`${BASE}/api/contracts`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })

  it('returns contract status when active', async () => {
    globalContract.create('Test Contract', 'testing', ['assert1', 'assert2'])
    const res = await fetch(`${BASE}/api/contracts`)
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
    const res = await fetch(`${BASE}/config/governance`, {
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
    const res = await fetch(`${BASE}/config/governance`, {
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
    const res = await fetch(`${BASE}/config/engine`, {
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
    const res = await fetch(`${BASE}/config/engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    })
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error).toContain('Invalid JSON')
  })

  it('accepts valid temperature', async () => {
    const res = await fetch(`${BASE}/config/engine`, {
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
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
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
})

// ── CORS headers ──────────────────────────────────────────────────

describe('CORS', () => {
  it('includes Access-Control-Allow-Origin header', async () => {
    const res = await fetch(`${BASE}/api/params`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`${BASE}/config/engine`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

// ── GET /api/history ──────────────────────────────────────────────

describe('GET /api/history', () => {
  it('returns an array (possibly empty)', async () => {
    const res = await fetch(`${BASE}/api/history`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })
})

// ── POST /config/system ───────────────────────────────────────────

describe('POST /config/system', () => {
  it('sets contractEnforcement', async () => {
    const res = await fetch(`${BASE}/config/system`, {
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
    const res = await fetch(`${BASE}/config/system`, {
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
    const res = await fetch(`${BASE}/config/tools`, {
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
    const res = await fetch(`${BASE}/config/tools`, {
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
