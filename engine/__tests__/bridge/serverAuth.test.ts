/**
 * The bridge used to accept any connection at all.
 *
 * `server.upgrade(req)` ran with no origin check and no auth, and WebSocket
 * handshakes are not subject to CORS — no preflight, no origin enforcement
 * unless we do it ourselves. So any page open in any browser on this machine
 * could `new WebSocket('ws://127.0.0.1:9160')`, and `open` then set
 * `this.client = ws` unconditionally, displacing the real TUI as the single
 * registered client. parseCommand accepts any object with a `type` field, and
 * TUICommand includes UserMessageCommand — which drives the agent, and the agent
 * has Bash. Arbitrary code execution from a page load, with the attacker also
 * receiving the whole event stream (every tool call, file read, model response)
 * back on the same socket.
 *
 * "Binds loopback only" was true and irrelevant: the browser is already inside
 * loopback.
 *
 * Two independent gates, because either alone leaves a story:
 *   - Origin present at all → refuse. Browsers always send it on a WS handshake
 *     and cannot suppress it; Python `websockets` never sends it. The bridge has
 *     no browser client, so the header is a reliable "this is a page" signal.
 *   - Bearer token → refuse without it. Covers any non-browser attacker, which
 *     the Origin rule says nothing about.
 *
 * Refused before `server.upgrade`, not accepted-then-closed: an accepted socket
 * has already run `open`, which is where the TUI got displaced.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { LocalCodeWSServer } from '../../bridge/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const dir = mkdtempSync(join(tmpdir(), 'cynco-bridge-auth-'))
const tokens = loadOrCreateTokens(dir)
const BRIDGE = tokens.tokenFor('bridge')!

let server: LocalCodeWSServer | null = null
afterEach(async () => {
  if (server) { await server.close(); server = null }
})
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

/** Resolve on open, or reject with the handshake status the server sent. */
function handshake(port: number, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
    ws.on('error', (e) => reject(e))
  })
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

describe('the bridge refuses a browser', () => {
  it('rejects an upgrade carrying an Origin, even with a valid token', async () => {
    server = new LocalCodeWSServer({ port: 19200, tokens })
    await new Promise(r => setTimeout(r, 50))

    await expect(
      handshake(19200, { ...auth(BRIDGE), Origin: 'http://evil.example' }),
    ).rejects.toThrow('status 403')

    // Refused before upgrade: `open` never ran, so nothing was registered.
    expect(server.connected).toBe(false)
  })

  it('rejects an Origin that names the loopback host', async () => {
    server = new LocalCodeWSServer({ port: 19201, tokens })
    await new Promise(r => setTimeout(r, 50))

    await expect(
      handshake(19201, { ...auth(BRIDGE), Origin: 'http://localhost:9161' }),
    ).rejects.toThrow('status 403')
    expect(server.connected).toBe(false)
  })
})

describe('the bridge requires a bridge-scoped token', () => {
  it('rejects an upgrade with no Authorization header', async () => {
    server = new LocalCodeWSServer({ port: 19202, tokens })
    await new Promise(r => setTimeout(r, 50))

    await expect(handshake(19202, {})).rejects.toThrow('status 401')
    expect(server.connected).toBe(false)
  })

  it('rejects a wrong token of the right shape', async () => {
    server = new LocalCodeWSServer({ port: 19203, tokens })
    await new Promise(r => setTimeout(r, 50))

    await expect(handshake(19203, auth('a'.repeat(64)))).rejects.toThrow('status 401')
    expect(server.connected).toBe(false)
  })

  /**
   * The dashboard's inference token is handed to a browser page in its own HTML,
   * so it is the secret most likely to escape. It must not open the bridge.
   */
  it('rejects a real token that lacks the bridge scope', async () => {
    server = new LocalCodeWSServer({ port: 19204, tokens })
    await new Promise(r => setTimeout(r, 50))

    await expect(handshake(19204, auth(tokens.tokenFor('inference')!))).rejects.toThrow('status 401')
    expect(server.connected).toBe(false)
  })

  it('accepts the bridge token', async () => {
    server = new LocalCodeWSServer({ port: 19205, tokens })
    await new Promise(r => setTimeout(r, 50))

    const ws = await handshake(19205, auth(BRIDGE))
    await new Promise(r => setTimeout(r, 50))
    expect(server.connected).toBe(true)
    ws.close()
  })
})

/**
 * `open` assigned `this.client = ws` with no check, so a second connection
 * silently became THE client: the TUI kept its socket but stopped receiving
 * anything. That is wrong even with auth — a stolen token should not be able to
 * quietly blind the operator's terminal, and a second TUI launched by mistake
 * should say so rather than half-work.
 */
describe('the bridge holds one client at a time', () => {
  it('refuses a second client and leaves the first receiving events', async () => {
    server = new LocalCodeWSServer({ port: 19206, tokens })
    await new Promise(r => setTimeout(r, 50))

    const first = await handshake(19206, auth(BRIDGE))
    const received: string[] = []
    first.on('message', d => received.push(String(d)))
    await new Promise(r => setTimeout(r, 50))

    await expect(handshake(19206, auth(BRIDGE))).rejects.toThrow('status 409')

    server.emit({ type: 'stream.token', text: 'still mine' })
    await new Promise(r => setTimeout(r, 100))
    expect(received.map(r => JSON.parse(r).text)).toEqual(['still mine'])

    first.close()
  })

  it('accepts a new client once the first has gone', async () => {
    server = new LocalCodeWSServer({ port: 19207, tokens })
    await new Promise(r => setTimeout(r, 50))

    const first = await handshake(19207, auth(BRIDGE))
    await new Promise(r => setTimeout(r, 50))
    first.close()
    await new Promise(r => setTimeout(r, 150))
    expect(server.connected).toBe(false)

    const second = await handshake(19207, auth(BRIDGE))
    await new Promise(r => setTimeout(r, 50))
    expect(server.connected).toBe(true)
    second.close()
  })
})
