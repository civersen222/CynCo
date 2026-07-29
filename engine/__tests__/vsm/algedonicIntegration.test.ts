import { describe, expect, it, beforeEach } from 'bun:test'
import { AlgedonicIntegration } from '../../vsm/algedonicIntegration.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId } from '../../cybernetics-core/src/index.js'
import { HaltedError } from '../../cybernetics-core/src/algedonic/index.js'

describe('AlgedonicIntegration', () => {
  let alg: AlgedonicIntegration

  beforeEach(() => {
    resetEventBus()
    alg = new AlgedonicIntegration(new NodeId())
  })

  it('records tool success as pleasure signal', () => {
    const action = alg.recordToolResult('Read', true, 100)
    expect(action.type).toBe('Log') // Low severity → Log routing
    expect(alg.getPainRatio()).toBe(0)
  })

  it('records tool failure as pain signal', () => {
    alg.recordToolResult('Bash', false, 500)
    expect(alg.getPainRatio()).toBe(1)
  })

  it('activates kill switch after 5 consecutive failures', () => {
    for (let i = 0; i < 4; i++) {
      alg.recordToolResult('Edit', false, 100)
    }
    // Not halted yet at 4
    expect(alg.killSwitch.isHalted()).toBe(false)

    // 5th failure triggers kill switch
    alg.recordToolResult('Edit', false, 100)
    expect(alg.killSwitch.isHalted()).toBe(true)
  })

  it('checkOrHalt throws HaltedError when kill switch active', () => {
    for (let i = 0; i < 5; i++) {
      alg.recordToolResult('Edit', false, 100)
    }
    expect(() => alg.checkOrHalt()).toThrow(HaltedError)
  })

  it('resets kill switch and consecutive count', () => {
    for (let i = 0; i < 5; i++) {
      alg.recordToolResult('Edit', false, 100)
    }
    expect(alg.killSwitch.isHalted()).toBe(true)

    alg.reset()
    expect(alg.killSwitch.isHalted()).toBe(false)
    alg.checkOrHalt() // should not throw
  })

  it('success resets consecutive pain count', () => {
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Read', true, 50) // reset!
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Edit', false, 100)
    // Only 2 consecutive after reset, not 5
    expect(alg.killSwitch.isHalted()).toBe(false)
  })

  it('emits kill switch event to EventBus', () => {
    for (let i = 0; i < 5; i++) {
      alg.recordToolResult('Edit', false, 100)
    }
    const bus = getEventBus()
    const killEvents = bus.replayFiltered(e => e.payload.kind === 'KillSwitchActivated')
    expect(killEvents.length).toBeGreaterThan(0)
  })

  // A denial is the engine refusing to run a tool — the read-loop gate, the
  // commit-scope guard, the allowedTools pin. Nothing executed, so nothing in
  // the environment failed. Measured live 2026-07-28 in the Gilded L4.5 run:
  // five consecutive read-loop denials (3 Read, 2 Grep) drove consecutivePainCount
  // to 5, the kill switch fired, and the session halted with 148 lines of
  // uncommitted work and a red suite. Governance's own steering fed governance's
  // own kill switch. Denials still reach the channel — the pain ratio should show
  // that the run was being refused — they just must not arm the halt.
  it('a governance denial does not arm the kill switch', () => {
    for (let i = 0; i < 10; i++) {
      alg.recordToolResult('Read', false, 0, { governanceDenial: true })
    }
    expect(alg.killSwitch.isHalted()).toBe(false)
  })

  it('a governance denial still registers as pain', () => {
    alg.recordToolResult('Read', false, 0, { governanceDenial: true })
    expect(alg.getPainRatio()).toBe(1)
  })

  // Neutral, not forgiving: a denial interleaved with real failures must not
  // launder the streak. Edit failing five times is still five times whether or
  // not the read-loop gate refused a Read in between.
  it('a denial neither arms nor clears a real failure streak', () => {
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Read', false, 0, { governanceDenial: true })
    alg.recordToolResult('Edit', false, 100)
    alg.recordToolResult('Edit', false, 100)
    expect(alg.killSwitch.isHalted()).toBe(false)
    alg.recordToolResult('Edit', false, 100)
    expect(alg.killSwitch.isHalted()).toBe(true)
  })

  it('tracks SLA violations', () => {
    alg.recordToolResult('Bash', false, 120000) // very slow
    expect(alg.getSlaViolationCount()).toBeGreaterThan(0)
  })

  it('unacknowledged count tracks high/critical signals', () => {
    alg.recordToolResult('Edit', false, 100) // pain score 0.7 → High severity
    expect(alg.getUnacknowledgedCount()).toBe(1)
    alg.recordToolResult('Read', true, 50) // pleasure → Low severity
    expect(alg.getUnacknowledgedCount()).toBe(1) // still 1 unacknowledged
  })
})
