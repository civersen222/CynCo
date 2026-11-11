/**
 * No request body is read before it is known to be bounded
 * (engine/dashboard/server.ts, MAX_REQUEST_BODY_BYTES).
 *
 * An upload from the phone is at most UPLOAD_MAX_BYTES, and the handler said
 * so — after the body had been buffered. A declared length over the cap is now
 * refused by Bun itself (`maxRequestBodySize`; the suite's Bun.serve shim does
 * not take the option, so that half is pinned by the source and was checked
 * under real Bun); a body that declares no length (chunked) cannot be bounded
 * in advance and is refused outright, before the token check: /api/pair reads
 * a body from a client that holds no token.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as http from 'http'
import { DashboardServer, MAX_REQUEST_BODY_BYTES } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { UPLOAD_MAX_BYTES } from '../../projects/api.js'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function start(peer = '127.0.0.1') {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-bodycap-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => peer }, proxyPort: null })
  servers.push(server)
  await new Promise(r => setTimeout(r, 50))
  return { tokens, port: server.getPort() }
}

/** POST with raw control over the framing. `declare`: the Content-Length to send; omit it and the body goes chunked. */
function post(port: number, path: string, opts: { declare?: number; body?: string; token?: string | null }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (opts.declare !== undefined) headers['Content-Length'] = String(opts.declare)
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      let text = ''
      res.on('data', d => { text += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    // A refused request may have its socket closed while the client is still writing; the status has arrived by then.
    req.on('error', (e) => { if (!req.destroyed) reject(e) })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

describe('MAX_REQUEST_BODY_BYTES', () => {
  it('is one upload and room for its multipart framing', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(UPLOAD_MAX_BYTES)
    expect(MAX_REQUEST_BODY_BYTES - UPLOAD_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('a request body', () => {
  it('that declares a length within the cap is handled as before', async () => {
    const t = await start()
    const body = JSON.stringify({ temperature: 0.5 })
    const r = await post(t.port, '/config/engine', { declare: Buffer.byteLength(body), body, token: t.tokens.tokenFor('management') })
    expect(r.status).toBe(200)
  })

  it('that declares no length (chunked) is refused with 411 on every route, the pairing route included', async () => {
    const phone = await start('100.64.0.9')
    const pair = await post(phone.port, '/api/pair', { body: JSON.stringify({ code: '000000' }) })
    expect(pair.status).toBe(411)
    expect(pair.text).toContain('Content-Length')
    const desk = await start()
    const upload = await post(desk.port, '/api/projects/yard/knowledge', { body: '{"name":"a.md","text":"x"}', token: desk.tokens.tokenFor('inference') })
    expect(upload.status).toBe(411)
    const config = await post(desk.port, '/config/engine', { body: '{"temperature":0.5}', token: desk.tokens.tokenFor('management') })
    expect(config.status).toBe(411)
  })

  it('a GET, which has none, is untouched', async () => {
    const t = await start()
    expect((await fetch(`http://127.0.0.1:${t.port}/api/session`, { headers: { Authorization: `Bearer ${t.tokens.tokenFor('inference')}` } })).status).toBe(200)
  })

  it('the server is told the same cap, so Bun refuses a declared oversize body itself', () => {
    // Read from the source: the suite's Bun.serve shim does not take the option.
    const src = require('fs').readFileSync(join(__dirname, '../../dashboard/server.ts'), 'utf-8') as string
    expect(src).toMatch(/maxRequestBodySize: MAX_REQUEST_BODY_BYTES,/)
  })
})
