// scripts/__tests__/fixtures/marker-check/socket-stub.mjs — run under BUN by
// cynco-marker-check.test.mjs (vitest runs on node, which has no Bun.serve and
// no client ws.ping()).
//
// A Bun.serve websocket stub shaped like the engine's bridge (Phase 7 review
// C1): `idleTimeout: 1` and no server pings, so a client that sends nothing is
// dropped. uWS enforces the idle timeout on a coarse timer — measured here at
// about 8 s after the last frame for `idleTimeout: 1` — so the fake check runs
// longer than that (argv[3] ms, default 12000). The stub records every frame
// with the connection it arrived on, and the round under test is the driver's
// own markerCheckRound.
//
//   bun socket-stub.mjs <ping|noping> [checkMs]
//
// Prints one JSON line: { retried, noteFailed, frames, closes, conns, events }.
import { markerCheckRound, openSocket } from '../../../cynco-marker-check.mjs'

const mode = process.argv[2]
const checkMs = Number(process.argv[3] ?? 12_000)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const frames = []
const closes = []
let conns = 0
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req, { data: { id: ++conns } }) ? undefined : new Response('websocket only', { status: 400 })
  },
  websocket: {
    idleTimeout: 1,
    sendPings: false,
    message(ws, m) { frames.push({ conn: ws.data.id, data: String(m) }) },
    close(ws) { closes.push(ws.data.id) },
  },
})
const url = `ws://127.0.0.1:${server.port}`
const events = []
let ws = await openSocket(url)
const round = await markerCheckRound({
  getWs: () => ws,
  reconnect: async () => { ws = await openSocket(url); events.push('reconnected'); return ws },
  check: async () => { await sleep(checkMs); return { r: { verified: false, output: 'E fake failure' } } },
  remainingS: () => 7200,
  minS: 3600,
  retries: 0,
  noteFor: (a) => `[driver] marker check FAILED — fix and re-mark:\n${a.r.output}`,
  frameFor: (text) => JSON.stringify({ type: 'user.message', text, unattended: true }),
  pingEveryMs: mode === 'ping' ? 1000 : 0,
  log: (line) => events.push(line),
})
await sleep(500)
console.log(JSON.stringify({ retried: round.retried, noteFailed: round.noteFailed, frames, closes: [...closes], conns, events }))
server.stop(true)
process.exit(0)
