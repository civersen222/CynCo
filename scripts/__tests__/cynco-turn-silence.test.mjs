// F235: a turn that goes silent in the middle ends the mission instead of its
// wall clock. Replays the 2026-11-14 t5 wave: 80 minutes of work (tool calls,
// thinking, commits), one token of the final answer, then 73 minutes in which
// the only frames were governance status, /api/run said "processing" and the
// driver printed `[gov] status=healthy stuck=0` every 30 s.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createProgressClock, turnSilenceLimitMs, waitExitReason, missionOutcome, gateDisposition, PROGRESS_FRAMES,
  MODEL_SILENCE_MS, TOOL_SILENCE_MARGIN_MS } from '../cynco-ledger.mjs'

const MIN = 60_000
function fakeClock() {
  let t = 0
  return { now: () => t, advance: (ms) => { t += ms } }
}
// A turn the engine says is open, with work begun: the state the t5 driver sat in.
const openTurn = { landed: true, sawMessageComplete: false, msSinceActivity: 0, engineError: null, engineProcessing: true, workBegun: true }
const exitAfter = (clock, toolCapMs = 25 * MIN) => waitExitReason({ ...openTurn,
  msSinceProgress: clock.msSinceProgress(), silenceLimitMs: turnSilenceLimitMs({ toolsOpen: clock.toolsOpen(), toolCapMs }) })

describe('the t5 stall, replayed (F235)', () => {
  it('80 minutes of work, one token of the answer, then only governance frames: turn_silent at 30 minutes, not at the wall clock', () => {
    const c = fakeClock()
    const p = createProgressClock(c.now)
    // The work: tool calls with thinking between them, governance status interleaved.
    for (let i = 0; i < 223; i++) {
      p.observe({ type: 'stream.thinking' }); c.advance(10_000)
      p.observe({ type: 'tool.start', toolName: 'Bash' }); c.advance(5_000)
      p.observe({ type: 'tool.complete', toolName: 'Bash' })
      p.observe({ type: 'governance.status', status: 'healthy' })
    }
    p.observe({ type: 'stream.thinking' })
    p.observe({ type: 'stream.token', text: 'I' })
    expect(p.toolsOpen()).toBe(0)
    // Then nothing but governance, every 30 s, as the driver polled.
    let minute = 0
    let reason = null
    while (!reason && minute < 600) {
      for (let k = 0; k < 2; k++) { c.advance(30_000); p.observe({ type: 'governance.status', status: 'healthy', stuckTurns: 0 }) }
      minute++
      reason = exitAfter(p)
    }
    expect(reason).toBe('turn_silent')
    expect(minute).toBe(30)
    expect(p.msSinceProgress()).toBe(MODEL_SILENCE_MS)
  })

  it('before 30 minutes of model silence the open turn is still waited on, as before', () => {
    const c = fakeClock()
    const p = createProgressClock(c.now)
    p.observe({ type: 'stream.token' })
    c.advance(29 * MIN)
    expect(exitAfter(p)).toBeNull()
  })
})

describe('what counts as progress', () => {
  it('the model\'s output, tools, sub-agents and the turn ending; never governance, alerts or a replayed session.ready', () => {
    for (const t of ['stream.token', 'stream.thinking', 'tool.start', 'tool.complete', 'message.complete', 'subagent.spawned', 'subagent.tool', 'subagent.complete', 'subagent.killed']) {
      expect(PROGRESS_FRAMES.has(t)).toBe(true)
    }
    const c = fakeClock()
    const p = createProgressClock(c.now)
    c.advance(5 * MIN)
    for (const t of ['governance.status', 'governance.alert', 'session.ready', 'context.status', 'brain.entropy', undefined]) p.observe({ type: t })
    p.observe(null)
    expect(p.msSinceProgress()).toBe(5 * MIN)
    p.observe({ type: 'subagent.tool' })
    expect(p.msSinceProgress()).toBe(0)
  })

  it('a long Bash is not silence: the limit while a tool is open is the engine\'s Bash cap plus ten minutes', () => {
    const c = fakeClock()
    const p = createProgressClock(c.now)
    p.observe({ type: 'tool.start', toolName: 'Bash' })
    c.advance(34 * MIN)
    expect(exitAfter(p, 25 * MIN)).toBeNull()
    c.advance(1 * MIN)
    expect(exitAfter(p, 25 * MIN)).toBe('turn_silent')
    expect(turnSilenceLimitMs({ toolsOpen: 1, toolCapMs: 25 * MIN })).toBe(25 * MIN + TOOL_SILENCE_MARGIN_MS)
    expect(turnSilenceLimitMs({ toolsOpen: 0, toolCapMs: 25 * MIN })).toBe(MODEL_SILENCE_MS)
  })

  it('tools open and close by count; a finished message closes any left open; the driver\'s own message resets the clock', () => {
    const c = fakeClock()
    const p = createProgressClock(c.now)
    p.observe({ type: 'tool.start' }); p.observe({ type: 'tool.start' }); p.observe({ type: 'tool.complete' })
    expect(p.toolsOpen()).toBe(1)
    p.observe({ type: 'tool.complete' }); p.observe({ type: 'tool.complete' })
    expect(p.toolsOpen()).toBe(0)
    p.observe({ type: 'tool.start' }); p.observe({ type: 'message.complete' })
    expect(p.toolsOpen()).toBe(0)
    c.advance(20 * MIN)
    p.reset()
    expect(p.msSinceProgress()).toBe(0)
  })
})

describe('waitExitReason with the silence rule', () => {
  const silent = { msSinceProgress: 31 * MIN, silenceLimitMs: MODEL_SILENCE_MS }
  it('a turn the engine closed is closed, however long it was silent', () => {
    expect(waitExitReason({ ...openTurn, engineProcessing: false, ...silent })).toBe('engine_closed_the_turn')
  })
  it('an unanswered /api/run mid-turn is a stall too once the silence passes the limit', () => {
    expect(waitExitReason({ ...openTurn, engineProcessing: null, ...silent })).toBe('turn_silent')
    expect(waitExitReason({ ...openTurn, engineProcessing: null, msSinceProgress: 5 * MIN, silenceLimitMs: MODEL_SILENCE_MS })).toBeNull()
  })
  it('before any work it is not this rule\'s case (CYNCO_SILENCE_S covers a mission never accepted)', () => {
    expect(waitExitReason({ ...openTurn, workBegun: false, ...silent })).toBeNull()
  })
  it('an engine error and a gone engine still come first; a caller that passes no limit keeps the old behaviour', () => {
    expect(waitExitReason({ ...openTurn, engineError: 'llama-server stopped sending mid-reply', ...silent })).toBe('engine_error')
    expect(waitExitReason({ ...openTurn, engineGone: true, ...silent })).toBe('engine_gone')
    expect(waitExitReason({ ...openTurn })).toBeNull()
  })
})

describe('how a silent turn is labelled', () => {
  it('nothing landed: engine_error, not stopped_without_commit (the server stalled; the model did not choose to stop)', () => {
    expect(missionOutcome({ landed: false, zeroToolCompletion: false, wentQuiet: true, engineError: 'turn_silent', neverDispatched: false })).toBe('engine_error')
  })
  it('something landed: the gate runs and records, but labels nothing (the last commit may be work in progress)', () => {
    const d = gateDisposition({ neverDispatched: false, engineError: true, landed: true, quiet: true, runStillOpen: false })
    expect(d).toMatchObject({ run: true, label: false })
  })
})

describe('the driver is wired to it', () => {
  const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8')
  it('observes every frame, resets on each message it sends itself, and passes the limit to the exit rule', () => {
    expect(driver).toMatch(/collector\.ingest\(m\)\s+progress\.observe\(m\)/)
    // The dispatch, a probe injection, the marker-check note and the re-prompt after a stalled stream.
    expect(driver.match(/progress\.reset\(\)/g)).toHaveLength(4)
    expect(driver).toMatch(/const TOOL_CAP_MS = bashMaxTimeoutMs\(\)/)
    expect(driver).toMatch(/msSinceProgress: progress\.msSinceProgress\(\), silenceLimitMs \}\)/)
  })
  it('says the silence on the [gov] line and names the stall when it ends the wait', () => {
    expect(driver).toMatch(/\[gov\] status=\$\{g\.status\} stuck=\$\{g\.stuckTurns\} toolOK=\$\{g\.toolSuccessRate\} silent=/)
    expect(driver).toMatch(/if \(exitReason === 'turn_silent'\) console\.log\(`\[driver\] TURN SILENT/)
  })
  it('treats a silent turn as the harness\'s failure for the gate and the outcome', () => {
    expect(driver).toMatch(/exitReason === 'engine_gone' \|\| exitReason === 'turn_silent'\) \|\| null\)/)
    expect(driver).toMatch(/engineError: engineError \?\? \(exitReason === 'turn_silent' \? exitReason : null\)/)
  })
  it('dispatch-mission.sh hands the driver the Bash cap it hands the engine', () => {
    const sh = readFileSync('scripts/dispatch-mission.sh', 'utf-8')
    // Changed on purpose in wave 19b: the driver's start passes --no-install; the needle must be found.
    expect(sh.indexOf('  bun --no-install scripts/cynco-mission-driver.mjs')).toBeGreaterThan(0)
    const driverLaunch = sh.slice(sh.lastIndexOf('CYNCO_CHECK_TIMEOUT_MS="$CYNCO_CHECK_TIMEOUT_MS"'), sh.indexOf('  bun --no-install scripts/cynco-mission-driver.mjs'))
    expect(driverLaunch).toContain('CYNCO_BASH_TIMEOUT_MS="$CYNCO_BASH_TIMEOUT_MS" \\')
  })
})
