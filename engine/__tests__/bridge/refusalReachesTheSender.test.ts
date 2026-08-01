/**
 * A refused command frame must be answered, not just logged.
 *
 * F32. The bridge validator (F12) did its job perfectly: a mission driver sent a
 * `user.message` whose `contract.assertions` carried the newer `{text, command}`
 * objects, the running engine was an older process whose `isAssertion` accepted
 * only strings, and the frame was refused in microseconds. The refusal went to
 * `console.warn` — the engine's own stdout — and the socket stayed open and
 * silent. The driver, which had no reason to believe anything was wrong, sat
 * there for thirteen minutes and would have sat for three hours. The governance
 * poll ticked `stuck=0` the whole time, because zero turns were happening and
 * the absence of work reads exactly like healthy work.
 *
 * This is F19's shape again: the engine knew, and had no channel to say it. The
 * fix is the same one — put the refusal on the wire the sender is already
 * reading, as `session.error`, which every client (TUI and driver alike) already
 * handles.
 *
 * These tests drive a real server over a real socket. A unit test on
 * `parseCommandResult` would pin the reason string while proving nothing about
 * whether anyone sends it, which is the exact failure mode of audit finding 2 —
 * a validator nobody calls validates nothing.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { LocalCodeWSServer } from '../../bridge/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const dir = mkdtempSync(join(tmpdir(), 'cynco-bridge-refusal-'))
const tokens = loadOrCreateTokens(dir)
const BRIDGE = tokens.tokenFor('bridge')!

let server: LocalCodeWSServer | null = null
afterEach(async () => {
  if (server) { await server.close(); server = null }
})
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

async function connect(port: number): Promise<WebSocket> {
  server = new LocalCodeWSServer({ port, tokens, onCommand: () => { accepted.push(true) } })
  await new Promise(r => setTimeout(r, 50))
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: `Bearer ${BRIDGE}` },
  })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return ws
}

let accepted: boolean[] = []

/**
 * Send `frame` and resolve with the first message the server sends back, or
 * null if it says nothing for `ms`.
 *
 * The null case is the one under test and it must be reachable: a test that can
 * only ever observe a message would pass on a server that answers every frame
 * with an error, including the valid ones.
 */
function sendAndAwait(ws: WebSocket, frame: unknown, ms = 400): Promise<any | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    ws.on('message', (data: Buffer) => {
      clearTimeout(timer)
      try { resolve(JSON.parse(data.toString())) } catch { resolve(null) }
    })
    ws.send(JSON.stringify(frame))
  })
}

describe('a refused command frame reaches the sender', () => {
  it('accepts the exact frame that hung Wave 8 — assertions as {text, command}', async () => {
    accepted = []
    const ws = await connect(19240)
    // Verbatim the shape scripts/cynco-mission-driver.mjs builds when a mission
    // carries a held-out gate. The driver and the schema drifted apart once
    // (F32) and nothing in the suite noticed, because the driver is a script and
    // the schema is a module and no test held them against each other. This is
    // that test: if the shape the driver sends stops being a shape the engine
    // takes, this goes red here rather than as a three-hour silence.
    const reply = await sendAndAwait(ws, {
      type: 'user.message',
      text: 'a mission',
      contract: { title: 'Mission: UI8:', assertions: [{ text: 'the gate', command: 'pytest -q' }] },
      unattended: true,
    })
    ws.close()

    expect(accepted.length, "the driver's own contract shape was refused").toBe(1)
    expect(reply, 'a frame the engine accepted still drew an error').toBeNull()
  })

  it('sends session.error naming the reason when a frame is refused', async () => {
    accepted = []
    const ws = await connect(19241)
    const reply = await sendAndAwait(ws, { type: 'user.message', text: 42 })
    ws.close()

    expect(reply, 'the bridge refused the frame and told nobody').not.toBeNull()
    expect(reply.type).toBe('session.error')
    // The reason, not a generic "bad frame". The thirteen minutes were spent
    // not knowing WHICH field was wrong; a refusal that does not name the field
    // costs the same diagnosis all over again.
    expect(reply.error).toContain('text')
    expect(accepted.length, 'a refused frame was still handed to the engine').toBe(0)
  })

  it('answers a frame that is not JSON at all', async () => {
    accepted = []
    const ws = await connect(19242)
    const reply = await new Promise<any | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 400)
      ws.on('message', (d: Buffer) => { clearTimeout(timer); resolve(JSON.parse(d.toString())) })
      ws.send('not json at all')
    })
    ws.close()

    expect(reply, 'a garbage frame was swallowed').not.toBeNull()
    expect(reply.type).toBe('session.error')
    expect(reply.error).toContain('JSON')
  })

  it('stays silent on a frame it accepts', async () => {
    // Guard the guard. Without this, a server that replied `session.error` to
    // everything would pass every test above.
    accepted = []
    const ws = await connect(19243)
    const reply = await sendAndAwait(ws, { type: 'abort' })
    ws.close()

    expect(accepted.length, 'a valid abort never reached the engine').toBe(1)
    expect(reply, 'a valid frame drew an error reply').toBeNull()
  })
})
