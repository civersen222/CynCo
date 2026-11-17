// F235, the re-prompt (owner's decision 2026-11-17, row 11): a mission survives
// ONE stalled model stream. The engine marks the `session.error` of a cut
// stream with a `stall` field; the driver re-prompts once when the engine has
// closed the turn and the wave carries on; a second stall, and every other
// engine error, ends the mission as before; the ledger row says what happened.
//
// The stand-in below is the driver's own wiring of scripts/cynco-stall.mjs (the
// two arms of its frame handler and one pass of its wait loop) around a stub
// socket, with the real exit rule (waitExitReason) deciding when the wait ends.
// The last block pins that the driver script is wired the same way.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_STALL_REPROMPTS, stallOfFrame, stallRepromptText, createStallRecovery, stallRepromptRound } from '../cynco-stall.mjs'
import { waitExitReason, missionOutcome, gateDisposition, buildMissionRecord, createMissionCollector, MODEL_SILENCE_MS } from '../cynco-ledger.mjs'
import { StreamStalledError, stallOf, STREAM_IDLE_MS, STREAM_FIRST_BYTE_MS } from '../../engine/providers/streamWatchdog.js'
import { synthesizeMessageAssertions } from '../../engine/bridge/contractAutoCreate.js'
import { ConversationTheoryIntegration } from '../../engine/vsm/conversationTheory.js'

const OPEN = 1
const CLOSED = 3
const fakeWs = ({ readyState = OPEN, throwOnSend = false } = {}) => {
  const ws = { readyState, bufferedAmount: 0, sent: [] }
  ws.send = (f) => { if (throwOnSend) throw new Error('boom'); ws.sent.push(f) }
  return ws
}

/** A `session.error` frame exactly as the loop builds one from the error it caught. */
const errorFrame = (err) => {
  const stall = stallOf(err)
  return stall ? { type: 'session.error', error: err.message, stall } : { type: 'session.error', error: err.message }
}
const midReplyStall = () => errorFrame(new StreamStalledError('mid-stream', STREAM_IDLE_MS))
const firstByteStall = () => errorFrame(new StreamStalledError('first-byte', STREAM_FIRST_BYTE_MS))
const STALL_TEXT = 'llama-server stopped sending mid-reply: nothing for 600s; the request was cancelled (F235)'

const WORK_BEGUN = new Set(['stream.token', 'stream.thinking', 'tool.start', 'message.complete'])

/**
 * A mission as the driver sees one: frames in, polls of /api/run, a socket out.
 * `frame` and `poll` are the driver's own lines around cynco-stall.mjs; the
 * last block of this file pins that the script still reads that way.
 */
function standInMission({ ws = fakeWs(), reconnect = async () => { throw new Error('no reconnect expected') } } = {}) {
  let t = Date.parse('2026-11-17T10:00:00.000Z')
  const recovery = createStallRecovery({ now: () => t })
  const state = { ws, engineError: null, log: [] }
  return {
    recovery, state,
    advance: (ms) => { t += ms },
    frame(m) {
      if (WORK_BEGUN.has(m.type)) recovery.onTurnActivity()
      if (m.type === 'session.error' && !state.engineError) {
        const held = recovery.onSessionError(m)
        if (!held.resume) state.engineError = String(m.error ?? 'session.error with no message')
      }
    },
    /** One pass of the wait loop: the exit reason, or null while the wait goes on. */
    async poll(engineProcessing, exit = {}) {
      if (!state.engineError && recovery.active()) {
        const round = await stallRepromptRound({
          recovery, engineProcessing,
          getWs: () => state.ws,
          reconnect: async () => { state.ws = await reconnect(); return state.ws },
          frameFor: (text) => JSON.stringify({ type: 'user.message', text, cwd: 'C:/repo', readOnlyPaths: ['C:/brief.txt'], unattended: true }),
          confirmMs: 50,
          log: (line) => state.log.push(line),
        })
        if (round.reprompted) return null
        if (round.error) state.engineError = round.error
      }
      return waitExitReason({ landed: false, sawMessageComplete: false, msSinceActivity: 0, engineError: state.engineError,
        engineProcessing, workBegun: true, ...exit })
    },
    /** What the driver does when the wait is over. */
    finish() { if (!state.engineError && recovery.standing()) state.engineError = recovery.standing() },
  }
}

describe('what counts as a stall: the frame\'s own field, never its text', () => {
  it('a session.error with a stall field naming one of the clock\'s two phases', () => {
    expect(stallOfFrame(midReplyStall())).toEqual({ phase: 'mid-stream', silentMs: STREAM_IDLE_MS })
    expect(stallOfFrame(firstByteStall())).toEqual({ phase: 'first-byte', silentMs: STREAM_FIRST_BYTE_MS })
    expect(stallOfFrame({ type: 'session.error', error: 'x', stall: { phase: 'mid-stream' } })).toEqual({ phase: 'mid-stream', silentMs: null })
  })
  it('the stall\'s sentence without the field is not a stall, and neither is any other error', () => {
    expect(stallOfFrame({ type: 'session.error', error: STALL_TEXT })).toBeNull()
    expect(stallOfFrame({ type: 'session.error', error: 'llama-server exited with code 9' })).toBeNull()
    expect(stallOfFrame({ type: 'session.error', error: 'Failed to start llama-server on port 8081: refused (F140)' })).toBeNull()
    expect(stallOfFrame({ type: 'session.error', error: 'busy: a turn is still running' })).toBeNull()
  })
  it('a field that is not the engine\'s shape, or on another frame, is not one either', () => {
    for (const stall of [true, 'mid-stream', null, {}, { phase: 'crashed', silentMs: 5 }, []]) {
      expect(stallOfFrame({ type: 'session.error', error: STALL_TEXT, stall })).toBeNull()
    }
    expect(stallOfFrame({ type: 'governance.alert', stall: { phase: 'mid-stream', silentMs: 1 } })).toBeNull()
    expect(stallOfFrame(null)).toBeNull()
  })
})

describe('what the model is told', () => {
  const mid = stallRepromptText({ phase: 'mid-stream', silentMs: STREAM_IDLE_MS })
  const first = stallRepromptText({ phase: 'first-byte', silentMs: STREAM_FIRST_BYTE_MS })

  it('what happened, that it is the same mission, and to continue from the work as it stands', () => {
    expect(mid.split('\n')[0]).toBe('[driver] The model server went silent for 10 minutes in the middle of your last reply, so the engine cancelled that request. The unfinished reply was discarded, and none of it took effect.')
    expect(first.split('\n')[0]).toBe('[driver] The model server sent nothing for 20 minutes after your last step, so the engine cancelled that request before your next reply began.')
    for (const text of [mid, first]) {
      expect(text).toContain('This is the same mission and the same brief')
      expect(text).toContain('Continue from where you stopped.')
      expect(text).toContain('`git status`')
      expect(text).toContain('keep going until it is complete')
    }
    // A silence the frame did not measure is not given a number.
    expect(stallRepromptText({ phase: 'mid-stream', silentMs: null }).split('\n')[0]).toContain('went silent in the middle of your last reply')
  })

  it('makes no new contract of its own: the engine\'s auto-creator reads no edit, analysis or run task in it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-stall-text-'))
    try {
      for (const text of [mid, first]) {
        expect(synthesizeMessageAssertions(text, cwd)).toEqual(['Task was completed — user request fully addressed'])
      }
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it('does not read as a confused or a satisfied user to the teachback heuristic', () => {
    for (const text of [mid, first]) {
      const ct = new ConversationTheoryIntegration()
      ct.recordExchange('mission', 'the last reply', text)
      expect(ct.teachback.divergentCount()).toBe(0)
      expect(ct.teachback.verifiedCount()).toBe(0)
    }
  })
})

describe('one stalled stream: exactly one re-prompt, and the mission runs on', () => {
  it('nothing is sent while the engine still has the stalled turn open; one user message goes out when it has closed it', async () => {
    const m = standInMission()
    for (let i = 0; i < 3; i++) m.frame({ type: 'tool.start', toolName: 'Bash' })
    m.frame(midReplyStall())
    // Held, not terminal: the driver has recorded no engine error.
    expect(m.state.engineError).toBeNull()
    expect(m.recovery.active()).toBe(true)

    // The loop emits session.error before it has unwound the turn.
    expect(await m.poll(true)).toBeNull()
    expect(await m.poll(null)).toBeNull()
    expect(m.state.ws.sent).toEqual([])

    m.advance(30_000)
    expect(await m.poll(false)).toBeNull()   // re-prompted: the wait goes on
    expect(m.state.ws.sent).toHaveLength(1)
    const sent = JSON.parse(m.state.ws.sent[0])
    expect(sent).toEqual({
      type: 'user.message', cwd: 'C:/repo', readOnlyPaths: ['C:/brief.txt'], unattended: true,
      text: stallRepromptText({ phase: 'mid-stream', silentMs: STREAM_IDLE_MS }),
    })
    // No contract and no invariants on the frame: the engine keeps the mission's own (an
    // unattended message that carries neither keeps the active contract and the armed caps).
    expect('contract' in sent).toBe(false)
    expect('invariants' in sent).toBe(false)

    // The model takes it up and the wave carries on for as long as it likes.
    m.frame({ type: 'stream.thinking', text: '…' })
    m.frame({ type: 'tool.start', toolName: 'Bash' })
    expect(m.recovery.active()).toBe(false)
    for (let i = 0; i < 5; i++) expect(await m.poll(true)).toBeNull()
    m.frame({ type: 'message.complete', stopReason: 'end_turn' })
    // It ends the way any mission ends, with no engine error on it.
    expect(await m.poll(false)).toBe('engine_closed_the_turn')
    m.finish()
    expect(m.state.engineError).toBeNull()
    // Exactly one re-prompt in the whole mission.
    expect(m.state.ws.sent).toHaveLength(1)
    expect(m.recovery.record().reprompts).toBe(1)
  })

  it('a stall before the first byte is re-prompted the same way, with its own sentence', async () => {
    const m = standInMission()
    m.frame(firstByteStall())
    expect(await m.poll(false)).toBeNull()
    expect(JSON.parse(m.state.ws.sent[0]).text).toBe(stallRepromptText({ phase: 'first-byte', silentMs: STREAM_FIRST_BYTE_MS }))
  })

  it('a mission socket that died is reconnected first, and the re-prompt goes on the new one', async () => {
    const dead = fakeWs({ readyState: CLOSED })
    const fresh = fakeWs()
    const m = standInMission({ ws: dead, reconnect: async () => fresh })
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    expect(dead.sent).toEqual([])
    expect(fresh.sent).toHaveLength(1)
    expect(m.recovery.record().reprompts).toBe(1)
  })

  it('the one re-prompt is the owner\'s number', () => {
    expect(MAX_STALL_REPROMPTS).toBe(1)
  })
})

describe('a second stall ends the mission as a stall did before; nothing else is ever re-prompted', () => {
  it('a second stalled stream after a re-prompt: terminal, with the engine\'s own words, and no second user message', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    m.frame({ type: 'tool.start', toolName: 'Edit' })
    expect(await m.poll(true)).toBeNull()

    m.frame(midReplyStall())
    expect(m.state.engineError).toBe(STALL_TEXT)
    // Not held: the driver leaves the wait at once, turn open or closed, as it does on any engine error.
    expect(await m.poll(true)).toBe('engine_error')
    expect(await m.poll(false)).toBe('engine_error')
    expect(m.state.ws.sent).toHaveLength(1)
    // And it is labelled as a stall always was.
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true, engineError: m.state.engineError, neverDispatched: false })).toBe('engine_error')
    expect(gateDisposition({ neverDispatched: false, engineError: m.state.engineError, landed: true, quiet: true, runStillOpen: false })).toMatchObject({ run: true, label: false })
    expect(gateDisposition({ neverDispatched: false, engineError: m.state.engineError, landed: false, quiet: true, runStillOpen: false })).toMatchObject({ run: false, label: false })
  })

  const neverReprompted = [
    ['a crashed model server', { type: 'session.error', error: 'llama-server exited with code 9' }],
    ['a refused spawn', { type: 'session.error', error: 'Failed to start llama-server on port 8081: refused: 2.1 GiB of commit charge free (F140)' }],
    ['a reply cut by a transport error', { type: 'session.error', error: 'the model\'s reply was cut off by a transport error (ECONNRESET)' }],
    ['an error that only quotes the stall\'s sentence', { type: 'session.error', error: STALL_TEXT }],
    ['an error with no message at all', { type: 'session.error' }],
  ]
  for (const [name, frame] of neverReprompted) {
    it(`${name}: terminal at once, nothing sent, however many polls find the turn closed`, async () => {
      const m = standInMission()
      m.frame({ type: 'tool.start', toolName: 'Bash' })
      m.frame(frame)
      expect(m.state.engineError).toBe(String(frame.error ?? 'session.error with no message'))
      expect(m.recovery.active()).toBe(false)
      for (const processing of [true, false, false, null]) expect(await m.poll(processing)).toBe('engine_error')
      expect(m.state.ws.sent).toEqual([])
      expect(m.recovery.record()).toEqual({ reprompts: 0, events: [] })
    })
  }

  it('a crash after a recovered stall is a crash: the used re-prompt changes nothing about it', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    m.frame({ type: 'stream.token', text: 'ok' })
    m.frame({ type: 'session.error', error: 'llama-server exited with code 9' })
    expect(m.state.engineError).toBe('llama-server exited with code 9')
    expect(await m.poll(false)).toBe('engine_error')
    expect(m.state.ws.sent).toHaveLength(1)
  })

  it('a crash while the stall still waits for its turn to close: the crash ends the mission and no re-prompt follows it', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(true)).toBeNull()
    m.frame({ type: 'session.error', error: 'llama-server exited with code 9' })
    expect(await m.poll(false)).toBe('engine_error')
    expect(m.state.engineError).toBe('llama-server exited with code 9')
    expect(m.state.ws.sent).toEqual([])
  })
})

describe('a re-prompt that does not land leaves the stall standing', () => {
  it('a reconnect that fails or a send that throws: the mission ends on the stall, and the row says why no re-prompt went out', async () => {
    const cases = [
      [{ ws: fakeWs({ readyState: CLOSED }), reconnect: async () => { throw new Error('refused') } }, /^reconnect failed: refused$/],
      [{ ws: fakeWs({ throwOnSend: true }) }, /^send threw: boom$/],
    ]
    for (const [over, why] of cases) {
      const m = standInMission(over)
      m.frame(midReplyStall())
      expect(await m.poll(false)).toBe('engine_error')
      expect(m.state.engineError).toBe(STALL_TEXT)
      const { reprompts, events } = m.recovery.record()
      expect(reprompts).toBe(0)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ reprompt: 'failed', repromptedAt: null, resumed: null })
      expect(events[0].why).toMatch(why)
      // Spent on the attempt: a later poll does not try again.
      expect(m.recovery.active()).toBe(false)
    }
  })

  it('sent, and the engine closed the turn without running one: not a finished mission, the stall ends it', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    // No turn activity follows. Without this rule the next poll would read "the engine closed the turn".
    expect(await m.poll(false)).toBe('engine_error')
    expect(m.state.engineError).toBe(STALL_TEXT)
    expect(m.recovery.record().events[0]).toMatchObject({ reprompt: 'sent', resumed: false, why: 'the engine closed the turn without running one after the re-prompt' })
    expect(m.state.ws.sent).toHaveLength(1)
  })

  it('sent, and the engine has the new turn open with nothing streamed yet (a model reload): still waiting, not given up on', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    expect(await m.poll(true)).toBeNull()
    expect(await m.poll(null)).toBeNull()
    expect(m.state.engineError).toBeNull()
    m.frame({ type: 'stream.thinking', text: '…' })
    expect(m.recovery.record().events[0].resumed).toBe(true)
  })

  it('an engine that never closes the stalled turn: the wait keeps its own bound, and the mission then ends on the stall', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(true, { msSinceProgress: 12 * 60_000, silenceLimitMs: MODEL_SILENCE_MS })).toBeNull()
    expect(await m.poll(true, { msSinceProgress: MODEL_SILENCE_MS, silenceLimitMs: MODEL_SILENCE_MS })).toBe('turn_silent')
    expect(m.state.ws.sent).toEqual([])
    expect(m.state.engineError).toBeNull()
    m.finish()
    expect(m.state.engineError).toBe(STALL_TEXT)
    expect(m.recovery.record().events[0]).toMatchObject({ reprompt: 'waiting', why: 'the mission ended before the engine closed the stalled turn' })
  })
})

describe('the ledger row says the mission was re-prompted, how many times and when; its labels are otherwise what they were', () => {
  const meta = { missionId: 'm-1', briefFile: 'brief.txt', marker: 'mk', cwd: 'C:/repo', dispatchedAt: '2026-11-17T09:00:00.000Z', durationS: 7200 }

  it('a mission resumed after one stall and finished: one event with both times, and the outcome labels of a mission that never stalled', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    m.advance(30_000)
    expect(await m.poll(false)).toBeNull()
    m.frame({ type: 'tool.start', toolName: 'Bash' })
    m.finish()
    const outcome = missionOutcome({ landed: true, zeroToolCompletion: false, wentQuiet: true, engineError: m.state.engineError, neverDispatched: false })
    const record = buildMissionRecord(createMissionCollector(), { ...meta, outcome, engineError: m.state.engineError, exitReason: 'engine_closed_the_turn', verified: true, stalls: m.recovery.record() })
    expect(record.stalls).toEqual({
      reprompts: 1,
      events: [{
        at: '2026-11-17T10:00:00.000Z', phase: 'mid-stream', silentMs: STREAM_IDLE_MS, error: STALL_TEXT,
        reprompt: 'sent', repromptedAt: '2026-11-17T10:00:30.000Z', resumed: true, why: null,
      }],
    })
    expect(record.outcome).toBe('landed')
    expect(record.engineError).toBeNull()
    expect(record.exitReason).toBe('engine_closed_the_turn')
    expect(record.verified).toBe(true)
    // The gate labels it: nothing about a recovered stall demotes the verdict.
    expect(gateDisposition({ neverDispatched: false, engineError: m.state.engineError, landed: true, quiet: true, runStillOpen: false })).toEqual({ run: true, label: true, why: null })
  })

  it('a mission its second stall ended: both stalls, the second one spent, and engineError carries its text', async () => {
    const m = standInMission()
    m.frame(midReplyStall())
    expect(await m.poll(false)).toBeNull()
    m.frame({ type: 'tool.start', toolName: 'Bash' })
    m.advance(3_600_000)
    m.frame(firstByteStall())
    const record = buildMissionRecord(createMissionCollector(), { ...meta, outcome: 'engine_error', engineError: m.state.engineError, exitReason: 'engine_error', stalls: m.recovery.record() })
    expect(record.stalls.reprompts).toBe(1)
    expect(record.stalls.events.map(e => [e.phase, e.reprompt, e.resumed])).toEqual([['mid-stream', 'sent', true], ['first-byte', 'spent', null]])
    expect(record.stalls.events[1]).toMatchObject({ at: '2026-11-17T11:00:00.000Z', repromptedAt: null, why: 'the mission\'s 1 re-prompt was already used' })
    expect(record.engineError).toBe(record.stalls.events[1].error)
    expect(record.engineError).toMatch(/^llama-server sent nothing for 1200s/)
  })

  it('a mission that never stalled says so, and a record built without the field is null, not "never stalled"', () => {
    const never = buildMissionRecord(createMissionCollector(), { ...meta, outcome: 'landed', stalls: createStallRecovery().record() })
    expect(never.stalls).toEqual({ reprompts: 0, events: [] })
    expect(buildMissionRecord(createMissionCollector(), { ...meta, outcome: 'landed' }).stalls).toBeNull()
  })

  it('what the cut reply had streamed is not judged as the opening of the answer that follows the re-prompt', () => {
    const answerAfter = (errorFrameSent) => {
      const collector = createMissionCollector()
      collector.ingest({ type: 'tool.start', toolName: 'Bash' })
      collector.ingest({ type: 'stream.token', text: 'I cannot ' })   // the reply the stall cut
      collector.ingest(errorFrameSent)
      collector.ingest({ type: 'stream.token', text: 'The mission is complete.' })
      collector.ingest({ type: 'message.complete', stopReason: 'end_turn' })
      return collector.refusals
    }
    expect(answerAfter(midReplyStall())).toMatchObject({ judged: 1, declined: 0, samples: [] })
    // Only a stall drops it: the busy refusal ends no turn, and the text before it is still the answer's.
    expect(answerAfter({ type: 'session.error', error: 'busy: a turn is still running' })).toMatchObject({ judged: 1, declined: 1 })
  })

  it('the record is a copy: a later event does not rewrite a row already built', () => {
    const recovery = createStallRecovery()
    recovery.onSessionError(midReplyStall())
    const before = recovery.record()
    recovery.failed('x')
    expect(before.events[0].reprompt).toBe('waiting')
  })
})

describe('the driver is wired to it', () => {
  const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8').replace(/\r\n/g, '\n')
  const at = (needle) => { const i = driver.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i }

  it('a session.error is terminal only when the recovery does not hold it, and turn activity acknowledges a re-prompt', () => {
    // The arm, from the question to the next frame type: held first, and the assignment only in its else.
    const arm = driver.slice(at('const held = stallRecovery.onSessionError(m)'), at("if (m.type === 'tool.complete' && m.isError)"))
    const order = ['if (held.resume) {', '} else {', "engineError = String(m.error ?? 'session.error with no message')"].map(s => arm.indexOf(s))
    expect(order.every(i => i > -1)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(arm.match(/\bengineError = /g)).toHaveLength(1)
    expect(driver).toMatch(/\} else if \(m\.type === 'session\.error' && !engineError\) \{\n(\s+\/\/.*\n)+\s+const held = stallRecovery\.onSessionError\(m\)\n/)
    expect(driver).toContain('if (WORK_BEGUN.has(m.type)) { workBegun = true; stallRecovery.onTurnActivity() }')
    // The only assignments to engineError: its declaration, the terminal arm, a re-prompt that did not land, a stall left standing.
    expect(driver.match(/\bengineError = /g)).toHaveLength(4)
  })

  it('never reads the error\'s text for the stall: the one text match on a session.error is the busy refusal', () => {
    expect(driver.match(/\.test\(String\(m\.error/g)).toEqual(['.test(String(m.error'])
    expect(driver).toContain("m.type === 'session.error' && /^busy:/.test(String(m.error ?? ''))")
    expect(driver).not.toMatch(/includes\(['"`][^'"`\n]*F235/)
    expect(driver).not.toMatch(/\/[^/\n]*F235[^/\n]*\/[a-z]*\.test\(/)
  })

  it('re-prompts where the engine\'s own answer is in hand, before the exit rule, with the mission\'s frame shape', () => {
    const asked = at('const engineProcessing = await engineRunState()')
    const round = at('const round = await stallRepromptRound({')
    const exitRule = at('exitReason = waitExitReason({')
    expect(asked).toBeLessThan(round)
    expect(round).toBeLessThan(exitRule)
    const block = driver.slice(round, exitRule)
    expect(driver.slice(at('if (!engineError && stallRecovery.active()) {'), round).trim()).toBe('if (!engineError && stallRecovery.active()) {')
    expect(block).toContain('recovery: stallRecovery,')
    expect(block).toContain('engineProcessing,')
    expect(block).toContain('getWs: () => ws,')
    expect(block).toContain('reconnect: reconnectMissionSocket,')
    expect(block).toContain("frameFor: (text) => JSON.stringify({ type: 'user.message', text, cwd: CWD, readOnlyPaths, unattended: true }),")
    // After a re-prompt: the clocks every injection resets, and the wait goes on.
    expect(block).toMatch(/if \(round\.reprompted\) \{\s+sawMessageComplete = false\s+lastActivityAt = Date\.now\(\)\s+progress\.reset\(\)\s+continue\s+\}/)
    expect(block).toContain('if (round.error) engineError = round.error')
  })

  it('does not move the mission\'s clock: `start` is a constant the loop bound and remainingS both read', () => {
    expect(driver.match(/\bstart = /g)).toEqual(['start = '])
    expect(driver).toContain('const start = Date.now()')
    expect(driver).toContain('(Date.now() - start) / 1000 < TIMEOUT_S')
    expect(driver).toContain('const remainingS = () => TIMEOUT_S - (Date.now() - start) / 1000')
  })

  it('a stall left standing when the wait ends becomes the engine error before the gate and the outcome are decided', () => {
    const standing = at('if (!engineError && stallRecovery.standing()) engineError = stallRecovery.standing()')
    expect(standing).toBeGreaterThan(at('exitReason = waitExitReason({'))
    expect(standing).toBeLessThan(at('const gate = gateDisposition({'))
    expect(standing).toBeLessThan(at('const outcome = missionOutcome({'))
  })

  it('writes the stalls onto the record it appends', () => {
    const build = at('const record = buildMissionRecord(collector, {')
    expect(driver.slice(build, driver.indexOf('ensureLedgerDir()', build))).toContain('stalls: stallRecovery.record(),')
  })
})
