// engine/__tests__/vsm/governanceSignal.test.ts
import { describe, expect, it } from 'bun:test'
import { buildGovernanceSignal } from '../../vsm/governanceSignal.js'

describe('buildGovernanceSignal', () => {
  it('returns null below the stuck threshold', () => {
    expect(buildGovernanceSignal(0)).toBeNull()
    expect(buildGovernanceSignal(2)).toBeNull()
  })

  it('returns a warning at stuck 3-4', () => {
    const s = buildGovernanceSignal(3)!
    expect(s).toContain('## GOVERNANCE SIGNAL (turn 3)')
    expect(s).toContain('WARNING')
    expect(s).not.toContain('CRITICAL')
  })

  it('returns the critical signal at stuck >= 5', () => {
    const s = buildGovernanceSignal(5)!
    expect(s).toContain('## GOVERNANCE SIGNAL — CRITICAL (turn 5)')
    expect(s).toContain('MUST BE DIFFERENT')
  })

  it('is deterministic for the same stuck count', () => {
    expect(buildGovernanceSignal(4)).toBe(buildGovernanceSignal(4))
  })
})
