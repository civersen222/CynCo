import { describe, it, expect, afterEach } from 'vitest'
import { governanceCapabilities, CAP_HOUSE_CONDUCT, CAP_S5_ADVISORY } from '../../bridge/capabilities.js'

/**
 * The house-conduct A/B (docs/superpowers/plans/2026-10-27-house-conduct-ab.md)
 * compares ledger rows by the prompt arm the ENGINE declared, not by a label
 * the operator typed. So the engine must say `house-conduct` on session.ready
 * exactly when the section is in its prompt, read from the one predicate the
 * loop reads (`isHouseConductEnabled`), the way the S5 words are (F42/F59).
 */
const base = { seal: () => {}, probe: () => false, unseal: () => {}, s5Enforcing: () => false }

describe('house-conduct capability', () => {
  const before = process.env.LOCALCODE_HOUSE_CONDUCT
  afterEach(() => {
    if (before === undefined) delete process.env.LOCALCODE_HOUSE_CONDUCT
    else process.env.LOCALCODE_HOUSE_CONDUCT = before
  })

  it('is said only when the wiring says the section is live', () => {
    expect(governanceCapabilities({ ...base, houseConduct: () => true })).toContain(CAP_HOUSE_CONDUCT)
    expect(governanceCapabilities({ ...base, houseConduct: () => false })).not.toContain(CAP_HOUSE_CONDUCT)
    // a wiring without the probe never claims it
    expect(governanceCapabilities(base)).not.toContain(CAP_HOUSE_CONDUCT)
  })

  it('a throwing probe withholds the word and leaves the S5 word alone', () => {
    const caps = governanceCapabilities({ ...base, houseConduct: () => { throw new Error('boom') } })
    expect(caps).not.toContain(CAP_HOUSE_CONDUCT)
    expect(caps).toContain(CAP_S5_ADVISORY)
  })

  it('LIVE reads the one predicate: only the string "true" turns it on', () => {
    const cases: Array<[string | undefined, boolean]> = [['true', true], ['1', false], ['TRUE', false], ['false', false], [undefined, false]]
    for (const [v, want] of cases) {
      if (v === undefined) delete process.env.LOCALCODE_HOUSE_CONDUCT
      else process.env.LOCALCODE_HOUSE_CONDUCT = v
      expect(governanceCapabilities().includes(CAP_HOUSE_CONDUCT), `LOCALCODE_HOUSE_CONDUCT=${v}`).toBe(want)
    }
  })
})
