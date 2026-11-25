// Wave 19 (plan P6 item 6, the w12 checker's R2): a mission the driver stopped under the integrity latch, or with a
// guard folder that could not be used, is the harness's stop, never a delivery: engine_error even when a commit landed.
import { describe, it, expect } from 'vitest'
import { missionOutcome } from '../cynco-ledger.mjs'

describe('missionOutcome under an integrity stop', () => {
  it('is engine_error whatever landed', () => {
    expect(missionOutcome({ landed: true, integrityStop: true })).toBe('engine_error')
    expect(missionOutcome({ landed: false, wentQuiet: true, integrityStop: true })).toBe('engine_error')
  })
  it('without one, the outcomes are as before', () => {
    expect(missionOutcome({ landed: true })).toBe('landed')
    expect(missionOutcome({ landed: true, integrityStop: false, engineError: 'x' })).toBe('landed')
    expect(missionOutcome({ landed: false, engineError: 'x' })).toBe('engine_error')
    expect(missionOutcome({ landed: false, wentQuiet: true })).toBe('stopped_without_commit')
  })
})
