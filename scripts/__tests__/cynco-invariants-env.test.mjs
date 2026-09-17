import { describe, it, expect } from 'vitest'
import { invariantsFromEnv } from '../cynco-invariants.mjs'

describe('invariantsFromEnv', () => {
  it('returns null when unset', () => { expect(invariantsFromEnv({})).toBeNull() })
  it('parses a valid block', () => {
    expect(invariantsFromEnv({ CYNCO_MISSION_INVARIANTS: '{"editGapCap":40,"commitGapCap":150,"revertBan":true,"codeIndexFirst":true}' }))
      .toEqual({ editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true })
  })
  it('throws on malformed JSON or missing fields', () => {
    expect(() => invariantsFromEnv({ CYNCO_MISSION_INVARIANTS: '{bad' })).toThrow(/CYNCO_MISSION_INVARIANTS/)
    expect(() => invariantsFromEnv({ CYNCO_MISSION_INVARIANTS: '{"editGapCap":40}' })).toThrow(/commitGapCap/)
  })
})
