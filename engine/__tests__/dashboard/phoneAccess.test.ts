/**
 * Phone access at the dashboard boundary (docs/decisions/2026-10-22-phone-access.md).
 *
 * Off this machine the page is served with no token in it; a device pairs once
 * with a single-use code and then holds an `inference`-scoped record of its
 * own. Only such a record authenticates a remote request — the shared
 * `dashboard` secret and the `admin` secret are refused there as unknown — so
 * management stays on the desk by construction. On the loopback listener the
 * Host header must name this machine (DNS rebinding), and the socket handshake
 * and POST /api/pair, which carry no bearer token of their own, must come from
 * this origin or from no browser at all.
 *
 * `deps.remoteAddress` plays the peer: every test client here is loopback.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as http from 'http'
import WebSocket from 'ws'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { MAX_DEVICES } from '../../dashboard/access.js'

const PHONE = '100.64.0.9'
const DESK = '127.0.0.1'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function tokensInTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-phone-'))
  dirs.push(dir)
  return { dir, tokens: loadOrCreateTokens(dir) }
}

async function start(opts: { port?: number; onCommand?: (c: unknown) => void } = {}) {
  const { dir, tokens } = tokensInTemp()
  let peer = DESK
  const server = new DashboardServer({
    port: opts.port ?? 0,
    tokens,
    deps: { remoteAddress: () => peer, onCommand: opts.onCommand ?? (() => {}) },
  })
  servers.push(server)
  await new Promise(r => setTimeout(r, 100))
  const port = server.getPort()
  const base = `http://127.0.0.1:${port}`
  return {
    dir, tokens, server, port, base,
    asPhone() { peer = PHONE },
    asDesk() { peer = DESK },
    get(path: string, token?: string | null, headers: Record<string, string> = {}) {
      const h = new Headers(headers)
      if (token) h.set('Authorization', `Bearer ${token}`)
      return fetch(base + path, { headers: h })
    },
    post(path: string, body: unknown, token?: string | null, headers: Record<string, string> = {}) {
      const h = new Headers({ 'Content-Type': 'application/json', ...headers })
      if (token) h.set('Authorization', `Bearer ${token}`)
      return fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) })
    },
    async pair(label = 'Pixel') {
      peer = PHONE
      const res = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.pairingCode(), label }) })
      const json = await res.json()
      return { status: res.status, ...json } as { status: number; ok?: boolean; name?: string; token?: string; error?: string }
    },
  }
}

/** The handshake's status: 101 on open, else what the server answered. */
function handshake(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const w = new WebSocket(url, { headers })
    w.on('open', () => { resolve(101); w.close() })
    w.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); w.terminate() })
    w.on('error', () => { /* unexpected-response resolves first */ })
  })
}

describe('what GET / serves', () => {
  it('on the desk: the page with the shared inference token, as before', async () => {
    const t = await start()
    const res = await t.get('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(t.tokens.tokenFor('inference')!)
    expect(html).toContain('window.__CYNCO_REMOTE = false')
    expect(html).not.toContain(t.tokens.tokenFor('management')!)
  })

  it('off this machine: the same page with NO token, told to use the stored device token or go and pair', async () => {
    const t = await start(); t.asPhone()
    const res = await t.get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('window.__CYNCO_TOKEN = null')
    expect(html).toContain('window.__CYNCO_REMOTE = true')
    expect(html).toContain("location.replace('/pair')")
    expect(html).not.toContain(t.tokens.tokenFor('inference')!)
    expect(html).not.toContain(t.tokens.tokenFor('management')!)
    expect(html).not.toMatch(/[0-9a-f]{64}/)
    // The injected prelude must parse: it is the first script and nothing runs if it does not.
    const first = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    expect(() => new Function(first)).not.toThrow()
  })

  it('/pair is served to a phone and is not a thing on the desk', async () => {
    const t = await start(); t.asPhone()
    const page = await t.get('/pair')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Pair this device with CynCo')
    t.asDesk()
    expect((await t.get('/pair')).status).toBe(404)
    expect((await t.post('/api/pair', { code: '000000' })).status).toBe(404)
  })

  it('both pages refuse to be framed', async () => {
    const t = await start()
    const desk = await t.get('/')
    expect(desk.headers.get('x-frame-options')).toBe('DENY')
    expect(desk.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    t.asPhone()
    for (const path of ['/', '/pair']) {
      const res = await t.get(path)
      expect(res.headers.get('x-frame-options'), path).toBe('DENY')
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
    }
  })

  it('off this machine a rebound DNS name is refused too; an IP literal or a MagicDNS name is not', async () => {
    const t = await start(); t.asPhone()
    const status = (host: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, path: '/pair', method: 'GET', headers: { Host: host } }, res => { resolve(res.statusCode ?? 0); res.resume() })
      req.on('error', reject); req.end()
    })
    expect(await status(`evil.example:${t.port}`)).toBe(421)
    expect(await status(`127.0.0.1:${t.port}`)).toBe(200)
    expect(await status(`100.101.192.101:${t.port}`)).toBe(200)
    expect(await status(`pc.tail05397a.ts.net:${t.port}`)).toBe(200)
  })

  it('on the desk a rebound Host is refused before anything is served', async () => {
    const t = await start()
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, path: '/', method: 'GET', headers: { Host: `evil.example:${t.port}` } }, res => { resolve(res.statusCode ?? 0); res.resume() })
      req.on('error', reject); req.end()
    })
    expect(status).toBe(421)
    const ok = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, path: '/', method: 'GET', headers: { Host: `localhost:${t.port}` } }, res => { resolve(res.statusCode ?? 0); res.resume() })
      req.on('error', reject); req.end()
    })
    expect(ok).toBe(200)
  })
})

describe('pairing', () => {
  it('a wrong code counts down, the fifth locks pairing, and even the right code is refused while locked', async () => {
    const t = await start(); t.asPhone()
    for (let i = 4; i >= 1; i--) {
      const res = await t.post('/api/pair', { code: '000000', label: 'x' })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ attemptsLeft: i })
    }
    const locked = await t.post('/api/pair', { code: '000000' })
    expect(locked.status).toBe(429)
    expect(await locked.json()).toMatchObject({ error: expect.stringMatching(/closed for about 10 minutes/) })
    const right = await t.post('/api/pair', { code: t.server.pairingCode() })
    expect(right.status).toBe(429)
    expect(t.tokens.devices()).toEqual([])
    // The pairing page says so too.
    expect(await (await t.get('/pair')).text()).toContain('Too many wrong codes')
  })

  it('the right code mints a device: an inference-only record, persisted, handed to the phone once; the code is then spent', async () => {
    const t = await start()
    const used = t.server.pairingCode()
    const paired = await t.pair('My Pixel')
    expect(paired.status).toBe(200)
    expect(paired.ok).toBe(true)
    expect(paired.name).toMatch(/^device-[0-9a-f]{8}$/)
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/)
    expect(t.tokens.devices()).toEqual([{ name: paired.name, label: 'My Pixel', createdAt: expect.any(String) }])
    expect(loadOrCreateTokens(t.dir).verify(paired.token!, 'inference')).toBe(true)
    expect(loadOrCreateTokens(t.dir).verify(paired.token!, 'management')).toBe(false)
    // The three original secrets are exactly what they were, and the desk's page still gets the dashboard one.
    const again = loadOrCreateTokens(t.dir)
    expect(again.tokenFor('inference')).toBe(t.tokens.tokenFor('inference'))
    expect(again.tokenFor('management')).toBe(t.tokens.tokenFor('management'))
    expect(again.tokenFor('bridge')).toBe(t.tokens.tokenFor('bridge'))
    expect(t.server.pairingCode()).not.toBe(used)
    const replay = await t.post('/api/pair', { code: used })
    expect(replay.status).toBe(401)
  })

  it('refuses a cross-origin or non-JSON POST, which is all a hostile page could send', async () => {
    const t = await start(); t.asPhone()
    const origin = await t.post('/api/pair', { code: t.server.pairingCode() }, null, { Origin: 'http://evil.example' })
    expect(origin.status).toBe(403)
    const plain = await fetch(t.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code: t.server.pairingCode() }) })
    expect(plain.status).toBe(415)
    const same = await t.post('/api/pair', { code: '999999' }, null, { Origin: `http://127.0.0.1:${t.port}` })
    expect(same.status).toBe(401) // past the Origin check, refused on the code alone
    expect(t.tokens.devices()).toEqual([])
  })

  it(`stops at ${MAX_DEVICES} devices`, async () => {
    const t = await start()
    for (let i = 0; i < MAX_DEVICES; i++) expect((await t.pair(`d${i}`)).status).toBe(200)
    const full = await t.pair('one too many')
    expect(full.status).toBe(429)
    expect(full.error).toMatch(/too many paired devices/)
  }, 30000)
})

describe('what a remote client may do', () => {
  it('a device token opens the read routes and the socket; the shared and admin secrets are unknown off this machine', async () => {
    const t = await start()
    const { token } = await t.pair()
    t.asPhone()
    const mine = await t.get('/api/session', token)
    expect(mine.status).toBe(200)
    expect(await mine.json()).toMatchObject({ pending: null })
    expect((await t.get('/api/session', t.tokens.tokenFor('inference'))).status).toBe(401)
    expect((await t.get('/api/session', t.tokens.tokenFor('management'))).status).toBe(401)
    expect((await t.get('/api/session', null)).status).toBe(401)
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${token}`)).toBe(101)
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${t.tokens.tokenFor('inference')}`)).toBe(401)
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${t.tokens.tokenFor('management')}`)).toBe(401)
  })

  it('management is desk-only by construction: a device token is refused the scope, the admin secret is not even acknowledged', async () => {
    const t = await start()
    const { token } = await t.pair()
    t.asPhone()
    expect((await t.post('/config/engine', { temperature: 0.5 }, token)).status).toBe(403)
    expect((await t.post('/config/engine', { temperature: 0.5 }, t.tokens.tokenFor('management'))).status).toBe(401)
    expect((await t.get('/api/phone', token)).status).toBe(403)
    expect((await t.get('/api/phone', t.tokens.tokenFor('management'))).status).toBe(401)
    t.asDesk()
    expect((await t.post('/config/engine', { temperature: 0.5 }, t.tokens.tokenFor('management'))).status).toBe(200)
  })

  it('the socket handshake refuses a foreign Origin before the token is even looked at', async () => {
    const t = await start()
    const { token } = await t.pair()
    t.asPhone()
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${token}`, { Origin: 'http://evil.example' })).toBe(403)
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${token}`, { Origin: `http://127.0.0.1:${t.port}` })).toBe(101)
    t.asDesk()
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${t.tokens.tokenFor('inference')}`, { Origin: 'http://evil.example' })).toBe(403)
  })

  it('a device token drives the agent through the same allowlist as the desk page', async () => {
    const received: any[] = []
    const t = await start({ onCommand: c => received.push(c) })
    const { token } = await t.pair()
    t.asPhone()
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?token=${token}`)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('no open')) })
    const seen: any[] = []
    ws.onmessage = (e: any) => { try { seen.push(JSON.parse(e.data)) } catch (err) { seen.push({ unparsed: String(err) }) } }
    ws.send(JSON.stringify({ type: 'user.message', text: 'hello from the phone' }))
    ws.send(JSON.stringify({ type: 'abort' }))
    ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
    await new Promise(r => setTimeout(r, 200))
    t.server.broadcast({ type: 'stream.token', text: 'hi' } as any)
    await new Promise(r => setTimeout(r, 100))
    ws.close()
    expect(received.map(c => c.type)).toEqual(['user.message', 'abort'])
    expect(seen.some(m => m.type === 'session.error' && /approve-all/.test(m.error))).toBe(true)
    expect(seen.some(m => m.type === 'stream.token' && m.text === 'hi')).toBe(true)
  })
})

describe('the phone panel and revocation (management, on the desk)', () => {
  it('/api/phone tells the desk the code, the listeners, the devices and when a phone last got through', async () => {
    const t = await start()
    expect((await t.get('/api/phone', t.tokens.tokenFor('inference'))).status).toBe(403)
    const before = await (await t.get('/api/phone', t.tokens.tokenFor('management'))).json()
    expect(before).toMatchObject({ code: t.server.pairingCode(), lockedForMs: 0, devices: [], lastRemoteRequestAt: null, maxDevices: MAX_DEVICES })
    expect(before.listeners).toEqual([{ host: '127.0.0.1', port: t.port, bound: true, primary: true }])
    const { name } = await t.pair('Pixel')
    t.asDesk()
    const after = await (await t.get('/api/phone', t.tokens.tokenFor('management'))).json()
    expect(after.devices).toEqual([{ name, label: 'Pixel', createdAt: expect.any(String) }])
    expect(typeof after.lastRemoteRequestAt).toBe('string')
    expect(after.code).not.toBe(before.code)
    const rotated = await (await t.post('/api/phone/rotate', {}, t.tokens.tokenFor('management'))).json()
    expect(rotated.code).toBe(t.server.pairingCode())
    expect(rotated.code).not.toBe(after.code)
  })

  it('a locked pairing is reopened by the desk asking for a new code', async () => {
    const t = await start(); t.asPhone()
    for (let i = 0; i < 5; i++) await t.post('/api/pair', { code: '000000' })
    expect((await t.post('/api/pair', { code: t.server.pairingCode() })).status).toBe(429)
    t.asDesk()
    const rotated = await (await t.post('/api/phone/rotate', {}, t.tokens.tokenFor('management'))).json()
    expect((await (await t.get('/api/phone', t.tokens.tokenFor('management'))).json()).lockedForMs).toBe(0)
    t.asPhone()
    const paired = await t.post('/api/pair', { code: rotated.code, label: 'after lockout' })
    expect(paired.status).toBe(200)
  })

  it('revoking a device closes its socket with 4001, forgets its token, and the next request is unknown', async () => {
    const t = await start()
    const { name, token } = await t.pair()
    t.asPhone()
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?token=${token}`)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('no open')) })
    const closed = new Promise<number>(res => { ws.on('close', (code: number) => res(code)) })
    t.asDesk()
    expect((await t.post('/api/phone/revoke', { name: 'admin' }, t.tokens.tokenFor('management'))).status).toBe(400)
    expect((await t.post('/api/phone/revoke', { name: 'device-00000000' }, t.tokens.tokenFor('management'))).status).toBe(404)
    const res = await t.post('/api/phone/revoke', { name }, t.tokens.tokenFor('management'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, closed: 1 })
    expect(await closed).toBe(4001)
    expect(loadOrCreateTokens(t.dir).devices()).toEqual([])
    t.asPhone()
    expect((await t.get('/api/session', token!)).status).toBe(401)
    expect(await handshake(`ws://127.0.0.1:${t.port}/ws?token=${token}`)).toBe(401)
    // The desk's own secrets were never touched.
    expect(t.tokens.tokenFor('management')).toBeTruthy()
    expect(t.tokens.tokenFor('bridge')).toBeTruthy()
  })
})

describe('listeners', () => {
  const saved = process.env.LOCALCODE_DASHBOARD_HOST
  afterEach(() => { if (saved === undefined) delete process.env.LOCALCODE_DASHBOARD_HOST; else process.env.LOCALCODE_DASHBOARD_HOST = saved })

  it('a comma list binds the extras on the same port; getHostname() is the primary; duplicates collapse', async () => {
    process.env.LOCALCODE_DASHBOARD_HOST = '127.0.0.1, 127.0.0.2,127.0.0.1'
    const { tokens } = tokensInTemp()
    const server = new DashboardServer({ port: 19262, tokens })
    servers.push(server)
    await new Promise(r => setTimeout(r, 150))
    expect(server.getHostname()).toBe('127.0.0.1')
    expect(server.listeners()).toEqual([
      { host: '127.0.0.1', port: 19262, bound: true, primary: true },
      { host: '127.0.0.2', port: 19262, bound: true, primary: false },
    ])
    // Both answer; a loopback peer on a loopback listener is the desk either way.
    expect((await fetch('http://127.0.0.1:19262/')).status).toBe(200)
    expect((await fetch('http://127.0.0.2:19262/')).status).toBe(200)
  })
})
