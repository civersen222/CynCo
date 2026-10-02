// The driver's marker-check round (Phase 7 ruling 3, review C1/I4): the retry
// counts only when the note is CONFIRMED sent on an open socket, a dead socket
// is reconnected first, and a stood check is reused only while HEAD holds.
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { markerCheckRound, sendConfirmed, canReuseMarkerVerdict, withKeepalive } from '../cynco-marker-check.mjs'
import { runAsync } from '../cynco-spawn.mjs'

const OPEN = 1
const CLOSED = 3
const fakeWs = ({ readyState = OPEN, throwOnSend = false, closeOnSend = false, buffered = 0 } = {}) => {
  const ws = { readyState, bufferedAmount: 0, sent: [], pings: 0 }
  ws.send = (f) => {
    if (throwOnSend) throw new Error('boom')
    ws.sent.push(f)
    ws.bufferedAmount = buffered
    if (closeOnSend) ws.readyState = CLOSED
  }
  ws.ping = () => { ws.pings++ }
  return ws
}
const failing = { r: { verified: false, output: 'E fail' } }
const round = (over) => markerCheckRound({
  getWs: () => over.ws,
  reconnect: async () => { throw new Error('no reconnect expected') },
  check: async () => failing,
  remainingS: () => 7200,
  noteFor: (a) => `note: ${a.r.output}`,
  frameFor: (t) => JSON.stringify({ type: 'user.message', text: t }),
  confirmMs: 100,
  log: () => {},
  ...over,
})

describe('markerCheckRound', () => {
  it('a FAIL with time left sends the note on the open socket and counts the retry', async () => {
    const ws = fakeWs()
    const r = await round({ ws })
    expect(r.retried).toBe(true)
    expect(r.noteFailed).toBeNull()
    expect(JSON.parse(ws.sent[0]).text).toBe('note: E fail')
  })
  it('a PASS, an UNMEASURED check, a spent retry or a short clock sends nothing', async () => {
    for (const over of [
      { check: async () => ({ r: { verified: true } }) },
      { check: async () => ({ r: { verified: null } }) },
      { retries: 1 },
      { remainingS: () => 100 },
    ]) {
      const ws = fakeWs()
      const r = await round({ ws, ...over })
      expect(r).toMatchObject({ retried: false, noteFailed: null })
      expect(ws.sent).toEqual([])
    }
  })
  it('a closed socket is reconnected and the note goes on the new one', async () => {
    const dead = fakeWs({ readyState: CLOSED })
    const fresh = fakeWs()
    let current = dead
    const r = await round({ ws: undefined, getWs: () => current, reconnect: async () => { current = fresh; return fresh } })
    expect(r.retried).toBe(true)
    expect(dead.sent).toEqual([])
    expect(fresh.sent).toHaveLength(1)
  })
  it('a failed reconnect, a throwing send, a close during the send or an undrained buffer leaves the retry uncounted and names why', async () => {
    const cases = [
      [{ ws: fakeWs({ readyState: CLOSED }), reconnect: async () => { throw new Error('refused') } }, /reconnect failed: refused/],
      [{ ws: fakeWs({ throwOnSend: true }) }, /send threw: boom/],
      [{ ws: fakeWs({ closeOnSend: true }) }, /closed during the send/],
      [{ ws: fakeWs({ buffered: 10 }) }, /still buffered/],
    ]
    for (const [over, why] of cases) {
      const r = await round(over)
      expect(r.retried).toBe(false)
      expect(r.noteFailed).toMatch(why)
    }
  })
  it('pings the socket while the check runs', async () => {
    const ws = fakeWs()
    await withKeepalive(() => ws, () => new Promise(r => setTimeout(r, 120)), 20)
    expect(ws.pings).toBeGreaterThan(2)
  })
})

describe('sendConfirmed', () => {
  it('refuses a socket that is not open before sending anything', async () => {
    const ws = fakeWs({ readyState: 0 })
    expect(await sendConfirmed(ws, 'x', 50)).toEqual({ ok: false, reason: 'the socket is not open (readyState 0)' })
    expect(ws.sent).toEqual([])
  })
})

// Review I4: "same commit" is checked, not assumed.
describe('canReuseMarkerVerdict', () => {
  const verdict = { headBefore: 'aaa', headAfter: 'aaa' }
  it('reuses only a check that read one commit, with HEAD still there and the run closed', () => {
    expect(canReuseMarkerVerdict({ verdict, headNow: 'aaa', runStillOpen: false })).toBe(true)
    expect(canReuseMarkerVerdict({ verdict, headNow: 'bbb', runStillOpen: false })).toBe(false)
    expect(canReuseMarkerVerdict({ verdict, headNow: 'aaa', runStillOpen: true })).toBe(false)
    expect(canReuseMarkerVerdict({ verdict: { headBefore: 'aaa', headAfter: 'bbb' }, headNow: 'bbb', runStillOpen: false })).toBe(false)
    expect(canReuseMarkerVerdict({ verdict: { headBefore: null, headAfter: null }, headNow: null, runStillOpen: false })).toBe(false)
    expect(canReuseMarkerVerdict({ verdict: null, headNow: 'aaa', runStillOpen: false })).toBe(false)
  })
})

// Review C1, end to end against a real socket server: a Bun.serve stub that
// drops an idle client (the bridge's shape), driven by the real round under
// bun (fixtures/marker-check/socket-stub.mjs). With pings the first socket
// survives a check longer than the idle window and carries the note; without
// them the server drops it and the round reconnects before sending.
describe('markerCheckRound against an idle-dropping websocket server (bun)', () => {
  const stub = fileURLToPath(new URL('./fixtures/marker-check/socket-stub.mjs', import.meta.url))
  const runStub = async (mode) => {
    const r = await runAsync('bun', [stub, mode, '12000'], { timeoutMs: 90_000 })
    expect(r.fault, r.stderr).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  it('pings keep the mission socket alive; with pings off the note still arrives, over a reconnect', async () => {
    const [ping, noping] = await Promise.all([runStub('ping'), runStub('noping')])

    expect(ping.retried).toBe(true)
    expect(ping.noteFailed).toBeNull()
    expect(ping.conns).toBe(1)
    expect(ping.closes).toEqual([])
    expect(ping.frames).toHaveLength(1)
    expect(ping.frames[0].conn).toBe(1)
    expect(JSON.parse(ping.frames[0].data)).toMatchObject({ type: 'user.message', unattended: true })
    expect(JSON.parse(ping.frames[0].data).text).toContain('[driver] marker check FAILED — fix and re-mark:')

    expect(noping.retried).toBe(true)
    expect(noping.noteFailed).toBeNull()
    expect(noping.closes).toContain(1)
    expect(noping.conns).toBe(2)
    expect(noping.events).toContain('reconnected')
    expect(noping.frames).toHaveLength(1)
    expect(noping.frames[0].conn).toBe(2)
    expect(JSON.parse(noping.frames[0].data).text).toContain('E fake failure')
  }, 120_000)
})
