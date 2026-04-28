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
