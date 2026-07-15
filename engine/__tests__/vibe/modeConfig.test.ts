import { describe, expect, it } from 'bun:test'
import { MODE_CONFIG, minAgreementForBuild } from '../../vibe/types.js'
import { AgreementLevel } from '../../cybernetics-core/src/conversation/index.js'

describe('MODE_CONFIG', () => {
  it('defines a config entry for every VibeMode', () => {
    for (const mode of ['new', 'continue', 'fix', 'explain'] as const) {
      expect(MODE_CONFIG[mode]).toBeDefined()
    }
  })
  it('fix mode requires reproduce-first and explain mode is read-only', () => {
    expect(MODE_CONFIG.fix.reproduceFirst).toBe(true)
    expect(MODE_CONFIG.explain.readOnly).toBe(true)
    expect(MODE_CONFIG.new.readOnly).toBe(false)
  })
  it('build agreement floor is SharedProcedures for all modes', () => {
    expect(minAgreementForBuild('new')).toBe(AgreementLevel.SharedProcedures)
    expect(minAgreementForBuild('fix')).toBe(AgreementLevel.SharedProcedures)
  })
})
