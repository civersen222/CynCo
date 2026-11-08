import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AlgedonicIntegration } from '../../vsm/algedonicIntegration.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { NodeId } from '../../cybernetics-core/src/index.js'
import { AuditLogger } from '../../audit/auditLogger.js'

/**
 * Every tool result is audited with the kill switch's state. The entry read
 * `killSwitch.isActive`, a property the class does not have (its query is
 * `isHalted()`), so the audit said 'inactive' on every line including the one
 * that halted the session. Found by the strict type-check (A1).
 */
describe('algedonic audit entries carry the real kill-switch state', () => {
  let alg: AlgedonicIntegration
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    resetEventBus()
    alg = new AlgedonicIntegration(new NodeId())
    log = vi.spyOn(AuditLogger, 'log').mockImplementation(() => {})
  })
  afterEach(() => log.mockRestore())

  const lastEntry = () => log.mock.calls[log.mock.calls.length - 1][1] as Record<string, unknown>

  it('says inactive while the switch is open', () => {
    alg.recordToolResult('Read', false, 10)
    expect(lastEntry().killswitch_state).toBe('inactive')
  })

  it('says active once consecutive failures have halted the session', () => {
    for (let i = 0; i < 5; i++) alg.recordToolResult('Edit', false, 10)
    expect(alg.killSwitch.isHalted()).toBe(true)
    alg.recordToolResult('Edit', false, 10)
    expect(lastEntry().killswitch_state).toBe('active')
  })
})
