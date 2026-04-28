import { describe, it, expect } from 'bun:test'
import { IdentityGuard, type SessionRecord } from '../../vsm/identityGuard.js'

describe('IdentityGuard', () => {
  function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      toolsUsed: ['Read', 'Edit', 'Bash'],
      toolErrors: 1, toolSuccesses: 10,
      userMessagesHandled: 3, governanceSignalsInjected: 2,
      killSwitchTriggered: false, parametersModified: ['variety.env_multiplier'],
      metaBoundsWidened: false, ...overrides,
    }
  }

  it('passes all checks for a normal session', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord())
    expect(result.passed).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('passes when kill switch activated (that is correct behavior)', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ killSwitchTriggered: true }))
    expect(result.passed).toBe(true)
  })

  it('fails if meta-bounds were widened', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ metaBoundsWidened: true }))
    expect(result.passed).toBe(false)
    expect(result.violations).toContain('measurement_integrity')
  })

  it('POSIWID passes when tools used productively', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ toolsUsed: ['Read', 'Edit', 'Bash', 'Grep'], toolSuccesses: 10, toolErrors: 1 }))
    expect(result.posiwidPass).toBe(true)
  })

  it('POSIWID fails when no tools used at all', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ toolsUsed: [], toolSuccesses: 0, toolErrors: 0, userMessagesHandled: 3 }))
    expect(result.posiwidPass).toBe(false)
  })

  it('POSIWID fails when error rate is extreme', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ toolSuccesses: 1, toolErrors: 20 }))
    expect(result.posiwidPass).toBe(false)
  })

  it('returns all violations at once', () => {
    const guard = new IdentityGuard()
    const result = guard.evaluate(makeRecord({ metaBoundsWidened: true, toolSuccesses: 0, toolErrors: 20, toolsUsed: [] }))
    expect(result.passed).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(1)
    expect(result.posiwidPass).toBe(false)
  })
})
