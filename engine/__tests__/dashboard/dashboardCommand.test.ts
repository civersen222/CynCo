import { describe, expect, it } from 'bun:test'
import { DashboardServer } from '../../dashboard/server.js'
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


const PORT = 19191
describe('dashboard chat command path', () => {
  it('forwards a parsed WS command to deps.onCommand', async () => {
    const received: any[] = []
    const server = new DashboardServer({ port: PORT, deps: { onCommand: (c) => received.push(c) }, tokens: _tokens })
    await new Promise(r => setTimeout(r, 100))
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${_ADMIN}`)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('x')) })
    ws.send(JSON.stringify({ type: 'vibe.start', mode: 'new', description: 'hi' }))
    await new Promise(r => setTimeout(r, 150))
    ws.close(); server.stop()
    expect(received.some(c => c.type === 'vibe.start')).toBe(true)
  })

  it('never forwards /approve-all, however well authenticated the socket', async () => {
    // The end-to-end property the finding is about. The socket here presents
    // the ADMIN secret — the strongest token the process mints — and is still
    // refused, because the restriction is a property of the dashboard boundary
    // and not of the token that reached it. `/approve-all` sets the flag that
    // `approvalGate` short-circuits on, and `Bash`'s tier:'approval' is the
    // only thing in front of an unsandboxed exec().
    const received: any[] = []
    const server = new DashboardServer({ port: PORT + 1, deps: { onCommand: (c) => received.push(c) }, tokens: _tokens })
    await new Promise(r => setTimeout(r, 100))
    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/ws?token=${_ADMIN}`)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('x')) })
    ws.send(JSON.stringify({ type: 'command', command: '/approve-all' }))
    ws.send(JSON.stringify({ type: 'command', command: '/quit' }))
    // An allowed frame after the refused ones: proves the socket still works,
    // so "nothing arrived" cannot pass this test for the wrong reason.
    ws.send(JSON.stringify({ type: 'command', command: '/tools' }))
    await new Promise(r => setTimeout(r, 150))
    ws.close(); server.stop()
    expect(received.map(c => c.command)).toEqual(['/tools'])
  })
})
