import { describe, it, expect } from 'vitest'
import { enforcementNudgeText } from '../../bridge/enforcementNudge.js'

describe('enforcementNudgeText', () => {
  it('keeps the run-tests demand outside a workflow', () => {
    const t = enforcementNudgeText({ pending: 2, failed: 0, phaseName: null, authoringPhase: false })
    expect(t).toMatch(/NOT done/)
    expect(t).toMatch(/2 assertions pending, 0 failed/)
    expect(t).toMatch(/Run the test suite NOW with Bash/)
    expect(t).toMatch(/ContractAssertPass/)
  })

  it('keeps the run-tests demand in a phase that legitimately has Bash', () => {
    const t = enforcementNudgeText({ pending: 1, failed: 1, phaseName: 'run_test_fail', authoringPhase: false })
    expect(t).toMatch(/Run the test suite NOW with Bash/)
  })

  it('does not tell an authoring phase to fix failing tests', () => {
    const t = enforcementNudgeText({ pending: 2, failed: 0, phaseName: 'write_test', authoringPhase: true })
    expect(t).not.toMatch(/fix the errors/i)
    expect(t).not.toMatch(/Run the test suite NOW/)
  })

  it('names the authoring phase and defers to its instruction', () => {
    const t = enforcementNudgeText({ pending: 2, failed: 0, phaseName: 'write_test', authoringPhase: true })
    expect(t).toMatch(/write_test/)
    expect(t).toMatch(/NOT done/)
    expect(t).toMatch(/2 assertions pending, 0 failed/)
  })

  it('tells an authoring phase that a failing test is expected and to end its turn', () => {
    const t = enforcementNudgeText({ pending: 1, failed: 0, phaseName: 'write_test', authoringPhase: true })
    expect(t).toMatch(/expected/i)
    expect(t).toMatch(/end your turn/i)
    expect(t).toMatch(/ContractAssertFail/)
  })

  it('handles an authoring phase with no name', () => {
    const t = enforcementNudgeText({ pending: 1, failed: 0, phaseName: null, authoringPhase: true })
    expect(t).toMatch(/NOT done/)
    expect(typeof t).toBe('string')
  })
})
