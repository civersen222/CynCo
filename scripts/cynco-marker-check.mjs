// scripts/cynco-marker-check.mjs — the driver's marker-check round (Phase 7
// ruling 3), out of the driver so it can be driven against a stub socket.
//
// The round: run the check while keeping the mission socket alive, decide
// whether a FAIL is fed back, and — only then — get the note onto an OPEN
// socket, reconnecting to the engine if the old one died. The retry is counted
// by the caller ONLY when this returns `retried: true`, i.e. the note left on a
// socket that was open before and after the send and drained its buffer.
//
// Phase 7 review C1: the first cut ran the suite gate with spawnSync. The
// bridge is `Bun.serve` (engine/bridge/server.ts) with the default 120 s
// websocket idle timeout; a client whose event loop is blocked cannot answer,
// so every check longer than that lost the socket (driver_c10-wave2.log
// 1413-1414: a 450 s check, then `[driver] ws closed`), and the note went into
// a closed socket while the row said the model had been told.
import { shouldRetryMarkerCheck, MARKER_RETRY_MIN_S } from './cynco-verify.mjs'

/** How often the driver pings the mission socket while a check runs. */
export const PING_EVERY_MS = 30_000
/** How long a sent note may take to drain before the send is called failed. */
export const NOTE_CONFIRM_MS = 5_000
const OPEN = 1

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Open a websocket and resolve once it is OPEN. Rejects on an error, a close
 * before open, or `timeoutMs` — a reconnect that hangs is a failed reconnect.
 */
export function openSocket(url, { headers, timeoutMs = 20_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolveOpen, rejectOpen) => {
    let done = false
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v) }
    const sock = new WebSocketImpl(url, headers ? { headers } : undefined)
    const t = setTimeout(() => {
      try { sock.close() } catch (e) { console.log(`[driver] closing a hung reconnect failed: ${e?.message ?? e}`) }
      finish(rejectOpen, new Error(`no open within ${timeoutMs} ms`))
    }, timeoutMs)
    sock.addEventListener('open', () => finish(resolveOpen, sock))
    sock.addEventListener('error', () => finish(rejectOpen, new Error('the socket errored before it opened')))
    sock.addEventListener('close', (e) => finish(rejectOpen, new Error(`the socket closed before it opened (code ${e?.code ?? '?'})`)))
  })
}

/**
 * Run `work()` while pinging `getWs()` every `everyMs` (0 disables). The
 * socket is re-read on every tick, so a reconnect mid-work is pinged too.
 */
export async function withKeepalive(getWs, work, everyMs = PING_EVERY_MS, log = console.log) {
  const timer = everyMs > 0 ? setInterval(() => {
    const ws = getWs()
    if (ws?.readyState !== OPEN || typeof ws.ping !== 'function') return
    try { ws.ping() } catch (e) { log(`[driver] keep-alive ping failed: ${e?.message ?? e}`) }
  }, everyMs) : null
  try { return await work() } finally { if (timer) clearInterval(timer) }
}

/**
 * Send `frame` and confirm it left: the socket is OPEN before the send, the
 * send does not throw, the buffer drains within `confirmMs`, and the socket is
 * still OPEN after. `{ ok: true }` or `{ ok: false, reason }`.
 */
export async function sendConfirmed(ws, frame, confirmMs = NOTE_CONFIRM_MS) {
  if (!ws || ws.readyState !== OPEN) return { ok: false, reason: `the socket is not open (readyState ${ws?.readyState ?? 'none'})` }
  try { ws.send(frame) } catch (e) { return { ok: false, reason: `send threw: ${e?.message ?? e}` } }
  const t0 = Date.now()
  while ((ws.bufferedAmount ?? 0) > 0 && Date.now() - t0 < confirmMs) await sleep(25)
  if (ws.readyState !== OPEN) return { ok: false, reason: `the socket closed during the send (readyState ${ws.readyState})` }
  if ((ws.bufferedAmount ?? 0) > 0) return { ok: false, reason: `${ws.bufferedAmount} byte(s) still buffered after ${confirmMs} ms` }
  return { ok: true }
}

/**
 * One marker-check round.
 *
 *   getWs()        the current mission socket
 *   reconnect()    resolves a NEW open socket already attached as the mission
 *                  socket (the driver's attachMissionSocket); rejects on failure
 *   check()        resolves the graded attempt ({ r: runCheck result, … })
 *   remainingS()   seconds of the mission clock left
 *   noteFor(a)     the note text for a FAILED attempt
 *   frameFor(t)    the wire frame carrying note text t
 *
 * Returns { attempt, left, retried, noteFailed }: `retried` only when the note
 * was confirmed sent; `noteFailed` names why a due note did not go out (the
 * FAIL then stands). Never throws for a socket problem.
 */
export async function markerCheckRound({ getWs, reconnect, check, remainingS, minS = MARKER_RETRY_MIN_S, retries = 0, noteFor, frameFor,
  pingEveryMs = PING_EVERY_MS, confirmMs = NOTE_CONFIRM_MS, log = console.log }) {
  const attempt = await withKeepalive(getWs, check, pingEveryMs, log)
  const left = Math.round(remainingS())
  if (!shouldRetryMarkerCheck({ ok: attempt.r.verified, remainingS: left, retries, minS })) return { attempt, left, retried: false, noteFailed: null }
  log(`[verify] marker check FAILED — retrying once (${left}s left)`)
  let ws = getWs()
  if (!ws || ws.readyState !== OPEN) {
    log(`[verify] the mission socket is not open (readyState ${ws?.readyState ?? 'none'}) — reconnecting to the engine before the note`)
    try {
      ws = await reconnect()
    } catch (e) {
      const noteFailed = `reconnect failed: ${e?.message ?? e}`
      log(`[verify] note NOT sent — ${noteFailed}; the FAIL stands`)
      return { attempt, left, retried: false, noteFailed }
    }
  }
  const sent = await sendConfirmed(ws, frameFor(noteFor(attempt)), confirmMs)
  if (!sent.ok) {
    log(`[verify] note NOT sent — ${sent.reason}; the FAIL stands`)
    return { attempt, left, retried: false, noteFailed: sent.reason }
  }
  log('[verify] note delivered to the engine — the mission continues')
  return { attempt, left, retried: true, noteFailed: null }
}

/**
 * Phase 7 final review M7: did the engine act on a note that was confirmed
 * sent? `retried` says the note left; this says a further turn closed after it
 * (a `message.complete` counted after the send) before the final verify ran.
 * Null when there was no retry; false is "told and nothing came back".
 */
export function noteAcknowledged({ retried, completesAtNote, completesAtVerify }) {
  if (!retried) return null
  return completesAtVerify > completesAtNote
}

/**
 * Phase 7 review I4: may the final verify reuse a marker check that stood?
 * Only when that check read one commit throughout, the run is not still open,
 * and HEAD is still that commit — otherwise it measured a state that is gone.
 */
export function canReuseMarkerVerdict({ verdict, headNow, runStillOpen }) {
  if (!verdict || runStillOpen) return false
  const { headBefore, headAfter } = verdict
  return Boolean(headBefore) && headBefore === headAfter && headNow === headAfter
}
