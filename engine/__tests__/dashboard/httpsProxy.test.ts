/**
 * HTTPS for the phone (docs/decisions/2026-10-22-phone-access.md, amendment
 * "HTTPS and an installable page").
 *
 * `tailscale serve` terminates TLS on the tailnet name and proxies to
 * http://127.0.0.1:<port> — only 127.0.0.1 is supported as a target. A proxied
 * request therefore arrives from a loopback peer on a loopback listener, which
 * on the desk's listener is exactly what gets the shared token in its HTML. So
 * the proxy gets a listener of its own (LOCALCODE_DASHBOARD_PROXY_PORT) on
 * which EVERY client is remote, whatever its address: no token in the page,
 * pairing, a device token, management refused.
 *
 * No `deps.remoteAddress` here on purpose: the peers are real loopback peers.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as http from 'http'

import WebSocket from 'ws'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { parseProxyPort } from '../../dashboard/access.js'

const TSNET = 'longdongsilver.tail05397a.ts.net'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function start(proxyPort: number | null = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-proxy-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { onCommand: () => {} }, proxyPort })
  servers.push(server)
  await new Promise(r => setTimeout(r, 80))
  const desk = `http://127.0.0.1:${server.getPort()}`
  const proxy = server.proxyListener()
  const viaProxy = proxy ? `http://127.0.0.1:${proxy.port}` : ''
  /** A request as `tailscale serve` forwards it: the browser's Host, a loopback peer. */
  const proxied = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy!.port, path, method: opts.method ?? 'GET', headers: { Host: TSNET, ...(opts.headers ?? {}) } }, res => {
        let text = ''
        res.on('data', d => { text += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
      })
      req.on('error', reject)
      if (opts.body) req.write(opts.body)
      req.end()
    })
  const pair = async (label = 'Pixel') => {
    const res = await proxied('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://${TSNET}` }, body: JSON.stringify({ code: server.pairingCode(), label }) })
    return { status: res.status, ...(JSON.parse(res.text) as { name?: string; token?: string; error?: string }) }
  }
  return { dir, tokens, server, desk, proxy, viaProxy, proxied, pair }
}

function handshake(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const w = new WebSocket(url, { headers })
    w.on('open', () => { resolve(101); w.close() })
    w.on('unexpected-response', (_req: unknown, res: http.IncomingMessage) => { resolve(res.statusCode ?? 0); w.terminate() })
    w.on('error', () => { /* unexpected-response resolves first */ })
  })
}

describe('parseProxyPort', () => {
  it('a port number, or nothing', () => {
    expect(parseProxyPort('9443')).toBe(9443)
    expect(parseProxyPort(' 9443 ')).toBe(9443)
    expect(parseProxyPort(undefined)).toBeNull()
    expect(parseProxyPort('')).toBeNull()
    for (const bad of ['0', '-1', '65536', '94.43', 'https', '9443;rm']) expect(parseProxyPort(bad), bad).toBeNull()
  })
})

describe('with no proxy port configured', () => {
  it('there is no proxy listener and the dashboard is as it was', async () => {
    const t = await start(null)
    expect(t.server.proxyListener()).toBeNull()
    expect(t.server.listeners()).toEqual([{ host: '127.0.0.1', port: t.server.getPort(), bound: true, primary: true }])
    const html = await (await fetch(t.desk + '/')).text()
    expect(html).toContain(t.tokens.tokenFor('inference')!)
  })
})

describe('the proxy listener: loopback, and every client on it is remote', () => {
  it('binds 127.0.0.1 only, on its own port, beside the desk listener', async () => {
    const t = await start()
    expect(t.proxy).toMatchObject({ host: '127.0.0.1', bound: true })
    expect(t.proxy!.port).toBeGreaterThan(0)
    expect(t.proxy!.port).not.toBe(t.server.getPort())
  })

  it('GET / from a real loopback peer carries NO token, while the desk listener beside it still serves the desk', async () => {
    const t = await start()
    const viaProxy = await (await fetch(t.viaProxy + '/')).text()
    expect(viaProxy).toContain('window.__CYNCO_TOKEN = null')
    expect(viaProxy).toContain('window.__CYNCO_REMOTE = true')
    expect(viaProxy).not.toContain(t.tokens.tokenFor('inference')!)
    expect(viaProxy).not.toMatch(/[0-9a-f]{64}/)
    const desk = await (await fetch(t.desk + '/')).text()
    expect(desk).toContain(t.tokens.tokenFor('inference')!)
    expect(desk).toContain('window.__CYNCO_REMOTE = false')
  })

  it('the shared and admin secrets are unknown on it; a paired device is not; management is refused whatever is presented', async () => {
    const t = await start()
    const auth = (token: string | null) => fetch(t.viaProxy + '/api/session', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    expect((await auth(t.tokens.tokenFor('inference'))).status).toBe(401)
    expect((await auth(t.tokens.tokenFor('management'))).status).toBe(401)
    expect((await auth(null)).status).toBe(401)
    const { status, token } = await t.pair()
    expect(status).toBe(200)
    expect((await auth(token!)).status).toBe(200)
    const post = (tok: string) => fetch(t.viaProxy + '/config/engine', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: '{"temperature":0.5}' })
    expect((await post(token!)).status).toBe(403)
    expect((await post(t.tokens.tokenFor('management')!)).status).toBe(401)
    expect((await fetch(t.viaProxy + '/api/phone', { headers: { Authorization: `Bearer ${t.tokens.tokenFor('management')}` } })).status).toBe(401)
    // The same admin secret on the desk listener is the desk.
    expect((await fetch(t.desk + '/api/phone', { headers: { Authorization: `Bearer ${t.tokens.tokenFor('management')}` } })).status).toBe(200)
  })

  it('/pair is served there (it is not a thing on the desk listener)', async () => {
    const t = await start()
    expect((await fetch(t.viaProxy + '/pair')).status).toBe(200)
    expect((await fetch(t.desk + '/pair')).status).toBe(404)
  })

  it('counts as a phone getting through: the panel\'s "last phone request" moves', async () => {
    const t = await start()
    const panel = async () => (await (await fetch(t.desk + '/api/phone', { headers: { Authorization: `Bearer ${t.tokens.tokenFor('management')}` } })).json())
    expect((await panel()).lastRemoteRequestAt).toBeNull()
    await fetch(t.viaProxy + '/pair')
    const after = await panel()
    expect(typeof after.lastRemoteRequestAt).toBe('string')
    expect(after.proxy).toEqual({ host: '127.0.0.1', port: t.proxy!.port, bound: true })
  })
})

describe('the Host and Origin rules behind tailscale serve (it forwards the browser\'s Host unchanged)', () => {
  it('Host: the tailnet name, with no port, is this machine; a rebound name is not', async () => {
    const t = await start()
    expect((await t.proxied('/pair')).status).toBe(200)
    expect((await t.proxied('/pair', { headers: { Host: 'evil.example' } })).status).toBe(421)
    expect((await t.proxied('/pair', { headers: { Host: `127.0.0.1:${t.proxy!.port}` } })).status).toBe(200)
  })

  it('pairing from the https page: Origin https://<name> against Host <name> is this origin; another name is refused', async () => {
    const t = await start()
    const post = (origin: string) => t.proxied('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code: '000000' }) })
    expect((await post(`https://${TSNET}`)).status).toBe(401) // past the Origin check, refused on the code
    expect((await post('https://evil.example')).status).toBe(403)
    expect((await post(`https://other.tail05397a.ts.net`)).status).toBe(403)
    expect((await t.pair()).status).toBe(200)
  })

  it('the socket from the https page opens with a device token; a foreign Origin, or the shared token, does not', async () => {
    const t = await start()
    const { token } = await t.pair()
    const url = (tok: string) => `ws://127.0.0.1:${t.proxy!.port}/ws?token=${tok}`
    expect(await handshake(url(token!), { Host: TSNET, Origin: `https://${TSNET}` })).toBe(101)
    expect(await handshake(url(token!), { Host: TSNET, Origin: 'https://evil.example' })).toBe(403)
    expect(await handshake(url(t.tokens.tokenFor('inference')!), { Host: TSNET, Origin: `https://${TSNET}` })).toBe(401)
  })

  it('the address the wait push links to is the https page the device opened', async () => {
    const t = await start()
    const { token } = await t.pair()
    expect(await handshake(`ws://127.0.0.1:${t.proxy!.port}/ws?token=${token}`, { Host: TSNET, Origin: `https://${TSNET}` })).toBe(101)
    expect(t.server.phoneOrigin).toBe(`https://${TSNET}`)
  })
})

describe('a proxy port that is the dashboard’s own', () => {
  it('is refused: no second listener on the desk’s port, and the desk is still the desk', async () => {
    // Learn a free port, then ask for it twice over.
    const probe = await start(null)
    const port = probe.server.getPort()
    probe.server.stop()
    const dir = mkdtempSync(join(tmpdir(), 'cynco-proxy-'))
    dirs.push(dir)
    const tokens = loadOrCreateTokens(dir)
    const errors: string[] = []
    const orig = console.error
    console.error = (m: unknown) => { errors.push(String(m)) }
    let server: DashboardServer
    try { server = new DashboardServer({ port, tokens, deps: {}, proxyPort: port }) } finally { console.error = orig }
    servers.push(server)
    await new Promise(r => setTimeout(r, 80))
    expect(server.getPort()).toBe(port)
    expect(server.proxyListener()).toEqual({ host: '127.0.0.1', port, bound: false })
    expect(errors.some(e => e.includes("the dashboard's own port"))).toBe(true)
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(html).toContain(tokens.tokenFor('inference')!)
  })
})

// A proxy port that cannot be bound costs the dashboard nothing and is retried
// (the same try/catch and timer as the extra listeners, `bindExtras`). Not
// pinned here: the suite's Bun.serve shim binds asynchronously and cannot
// throw, which is why the extra listeners' failure path has no test either.
// Checked under real Bun when this was built (the PR says how).
