// scripts/cynco-stall.mjs — one re-prompt after a stalled model stream.
//
// F235: the engine cuts a streamed request its model server has stopped
// answering, and the turn ends as `session.error`. Until 2026-11-17 the driver
// ended the mission there, so a wave that stalled at hour one of an eight-hour
// budget spent the rest of it doing nothing. The owner's decision
// (docs/reviews/2026-11-17-owner-decisions.md, row 11): re-prompt once and
// carry on; a second stall in the same mission ends it as before.
//
// Three rules, each of which this file exists to keep:
//
//  - A stall is the frame's own `stall` field (engine/bridge/protocol.ts,
//    `SessionErrorEvent`), never the error's text. A crash, a refused spawn, a
//    cut transport and an error that merely quotes "(F235)" carry no such
//    field and stay terminal.
//  - The re-prompt goes out only once the ENGINE says the turn is closed
//    (/api/run `processing: false`). The loop emits `session.error` before it
//    has unwound the turn, and a `user.message` that meets an open unattended
//    turn is queued as an operator note and dropped when that turn ends.
//  - A re-prompt counts only when it was confirmed sent and a turn then ran.
//    One that could not be sent, or that the engine closed without running,
//    leaves the stall standing: the mission ends as a stall always has.
//
// The driver is a top-level script; it only wires these.
import { deliverFrame, NOTE_CONFIRM_MS } from './cynco-marker-check.mjs'

/** How many stalls one mission is re-prompted after. The owner's decision is one. */
export const MAX_STALL_REPROMPTS = 1

const PHASES = new Set(['first-byte', 'mid-stream'])

/**
 * The stall a frame reports, or null. Only a `session.error` whose `stall`
 * field names one of the stall clock's two phases counts; the text is not read.
 */
export function stallOfFrame(m) {
  if (m?.type !== 'session.error') return null
  const s = m.stall
  if (s === null || typeof s !== 'object' || !PHASES.has(s.phase)) return null
  return { phase: s.phase, silentMs: Number.isFinite(s.silentMs) && s.silentMs >= 0 ? s.silentMs : null }
}

/**
 * What the model is told after a stall. It says what happened, that nothing of
 * the mission has changed, and to carry on from the work as it stands.
 *
 * The words are chosen against two readers in the engine, and
 * scripts/__tests__/cynco-stall.test.mjs runs the text through both: the
 * contract auto-creator (`synthesizeMessageAssertions`) turns an edit, analysis
 * or run verb into assertions the model must then satisfy, and the teachback
 * heuristic (`engine/vsm/conversationTheory.ts`) reads a bare "no" or "what" as
 * a confused user. The mid-reply sentence is true of the loop: an assistant
 * message enters history once, after its stream has ended, so a cut reply left
 * nothing behind and none of its tool calls ran.
 */
export function stallRepromptText({ phase, silentMs }) {
  const mins = Number.isFinite(silentMs) && silentMs >= 60_000 ? Math.round(silentMs / 60_000) : null
  const silent = mins === null ? '' : ` for ${mins} minute${mins === 1 ? '' : 's'}`
  const cut = phase === 'first-byte'
    ? `The model server sent nothing${silent} after your last step, so the engine cancelled that request before your next reply began.`
    : `The model server went silent${silent} in the middle of your last reply, so the engine cancelled that request. The unfinished reply was discarded, and none of it took effect.`
  return [
    `[driver] ${cut}`,
    'This is the same mission and the same brief: everything above this message is still your own history, and the repository holds all of the work you have done so far.',
    'Continue from where you stopped. Read the last tool results above and `git status` to see where the work stands, then take the next step of the mission and keep going until it is complete.',
  ].join('\n')
}

/**
 * The mission's stalls and what was done about each. One per driver run.
 *
 *   onSessionError(m)  a `session.error` frame that is not the busy refusal:
 *                      `{ resume, stall, why }`. `resume: true` holds the
 *                      mission open for a re-prompt; false is terminal, and
 *                      `stall` says whether it was a stall at all.
 *   onTurnActivity()   a frame only a running turn emits arrived
 *   active()           is there anything for the poll to do
 *   next({ engineProcessing })
 *                      'reprompt' | 'not_taken' | 'wait' | 'none'
 *   waiting()          the stall a re-prompt is owed for, or null
 *   sent() / failed(reason) / notTaken()
 *                      what became of the re-prompt; the last two return the
 *                      stall's error text, which then ends the mission
 *   standing()         the error text of a stall still unanswered, or null
 *   record()           `{ reprompts, events }` for the ledger row
 */
export function createStallRecovery({ max = MAX_STALL_REPROMPTS, now = () => Date.now() } = {}) {
  const events = []
  // The stall whose turn the engine has not closed yet: a re-prompt is owed.
  let waiting = null
  // The stall whose re-prompt was sent and has not been followed by a turn.
  let unacknowledged = null
  let reprompts = 0
  const iso = () => new Date(now()).toISOString()

  return {
    onSessionError(m) {
      const stall = stallOfFrame(m)
      if (!stall) return { resume: false, stall: null, why: 'not a stalled stream' }
      const event = { at: iso(), phase: stall.phase, silentMs: stall.silentMs, error: String(m.error ?? ''),
        reprompt: null, repromptedAt: null, resumed: null, why: null }
      events.push(event)
      if (reprompts + (waiting ? 1 : 0) >= max) {
        event.reprompt = 'spent'
        event.why = `the mission's ${max} re-prompt${max === 1 ? ' was' : 's were'} already used`
        return { resume: false, stall, why: event.why }
      }
      event.reprompt = 'waiting'
      event.why = 'the mission ended before the engine closed the stalled turn'
      waiting = event
      return { resume: true, stall, why: null }
    },

    onTurnActivity() {
      if (!unacknowledged) return
      unacknowledged.resumed = true
      unacknowledged = null
    },

    active: () => waiting !== null || unacknowledged !== null,

    next({ engineProcessing }) {
      if (waiting) return engineProcessing === false ? 'reprompt' : 'wait'
      if (unacknowledged) return engineProcessing === false ? 'not_taken' : 'wait'
      return 'none'
    },

    waiting: () => (waiting ? { phase: waiting.phase, silentMs: waiting.silentMs } : null),

    sent() {
      if (!waiting) return
      waiting.reprompt = 'sent'
      waiting.repromptedAt = iso()
      waiting.resumed = false
      waiting.why = null
      reprompts++
      unacknowledged = waiting
      waiting = null
    },

    failed(reason) {
      if (!waiting) return null
      const event = waiting
      waiting = null
      event.reprompt = 'failed'
      event.why = String(reason)
      return event.error
    },

    notTaken() {
      if (!unacknowledged) return null
      const event = unacknowledged
      unacknowledged = null
      event.why = 'the engine closed the turn without running one after the re-prompt'
      return event.error
    },

    standing: () => (waiting ?? unacknowledged)?.error ?? null,

    record: () => ({ reprompts, events: events.map(e => ({ ...e })) }),
  }
}

/**
 * One poll's worth of stall recovery, run by the driver after it has asked the
 * engine whether the turn is open.
 *
 *   recovery          the mission's createStallRecovery()
 *   engineProcessing  /api/run's answer: true | false | null (nobody answered)
 *   getWs, reconnect  the mission socket and how to replace a dead one, as for
 *                     the marker-check note (cynco-marker-check.mjs)
 *   frameFor(text)    the wire frame carrying the re-prompt
 *
 * Returns `{ reprompted, error }`. `reprompted: true` only when the frame was
 * confirmed sent: the caller then resets its clocks and waits on. `error` is
 * the stall's own text when the stall now ends the mission (the send failed,
 * or the engine closed the turn without taking the re-prompt up). Both false
 * and null: nothing to do yet. Never throws for a socket problem.
 */
export async function stallRepromptRound({ recovery, engineProcessing, getWs, reconnect, frameFor,
  confirmMs = NOTE_CONFIRM_MS, log = console.log }) {
  const step = recovery.next({ engineProcessing })
  if (step === 'none') return { reprompted: false, error: null }
  if (step === 'wait') {
    log(`[stall] ${recovery.waiting() ? 'a re-prompt is owed after the stalled stream' : 'the re-prompt was sent'}; the engine `
      + `${engineProcessing === true ? 'still has the turn open' : 'did not answer /api/run'} — waiting`)
    return { reprompted: false, error: null }
  }
  if (step === 'not_taken') {
    const error = recovery.notTaken()
    log('[stall] the re-prompt was sent and the engine closed the turn without running one — the stall stands and the mission ends on it')
    return { reprompted: false, error }
  }
  const stall = recovery.waiting()
  log(`[stall] the engine closed the stalled turn — re-prompting once (${stall.phase}; this mission's only re-prompt)`)
  const sent = await deliverFrame({ getWs, reconnect, frame: frameFor(stallRepromptText(stall)), confirmMs, log, tag: '[stall]' })
  if (!sent.ok) {
    const error = recovery.failed(sent.reason)
    log(`[stall] re-prompt NOT sent — ${sent.reason}; the stall stands and the mission ends on it`)
    return { reprompted: false, error }
  }
  recovery.sent()
  log('[stall] re-prompt delivered to the engine — the mission continues under its original clock')
  return { reprompted: true, error: null }
}
