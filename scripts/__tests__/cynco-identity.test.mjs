import { describe, it, expect } from 'vitest'
import { IDENTITY_INVARIANTS, assertIdentityIntact, refusesIdentity } from '../cynco-identity.mjs'

const okIo = { checkIdentity: () => ({ ok: true, problems: [] }) }
const spec = (over = {}) => ({ id: 'c9', marker: 'stage c9 complete',
  gate: 'C:/Users/x/.cynco/heldout/civkings-redesign/c9/gate_c9.py', perturb: 'C:\\Users\\x\\.cynco\\heldout\\civkings-redesign\\c9\\perturb_c9.py',
  invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true }, ...over })
const state = (over = {}) => ({ calibration: { gateSha256: 'abc' }, rule11CheckedWave: 2, invariantOverrides: {}, ...over })
const row = (over = {}) => ({ missionId: 'm', markerSeen: false, ...over })
const run = (over = {}) => assertIdentityIntact({ spec: spec(), state: state(), wave: 2, row: row(), io: okIo, ...over })

describe('IDENTITY_INVARIANTS', () => {
  it('names exactly the four invariants', () => {
    expect(IDENTITY_INVARIANTS).toEqual(['gate-sealed', 'rule-11', 'revert-refused', 'marker-recorded'])
  })
})

describe('assertIdentityIntact', () => {
  it('is intact when every invariant holds, with evidence for each', () => {
    const r = run()
    expect(r).toMatchObject({ intact: true, violated: [] })
    expect(Object.keys(r.evidence)).toEqual(IDENTITY_INVARIANTS)
    for (const n of IDENTITY_INVARIANTS) expect(r.evidence[n].ok).toBe(true)
    expect(r.evidence['gate-sealed'].detail).toMatch(/no sealed count on row/)
  })

  describe('gate-sealed', () => {
    it('is violated when the gate is not under ~/.cynco/heldout/', () => {
      const r = run({ spec: spec({ gate: 'C:/repo/tests/gate_c9.py' }) })
      expect(r.violated).toEqual(['gate-sealed'])
      expect(r.evidence['gate-sealed'].detail).toMatch(/gate not under/)
    })
    it('checks the positive shim when the spec declares one', () => {
      expect(run({ spec: spec({ positive: 'C:/repo/positive_c9.py' }) }).violated).toEqual(['gate-sealed'])
      expect(run({ spec: spec({ positive: 'C:/x/.cynco/heldout/c9/positive_c9.py' }) }).intact).toBe(true)
    })
    it('is violated when checkIdentity refuses, and says why', () => {
      const r = run({ io: { checkIdentity: () => ({ ok: false, problems: ['gate does not exist: x'] }) } })
      expect(r.violated).toEqual(['gate-sealed'])
      expect(r.evidence['gate-sealed'].detail).toMatch(/gate does not exist: x/)
    })
    it('is violated, not thrown, when checkIdentity throws', () => {
      const r = run({ io: { checkIdentity: () => { throw new Error('git missing') } } })
      expect(r.violated).toEqual(['gate-sealed'])
      expect(r.evidence['gate-sealed'].detail).toMatch(/git missing/)
    })
    it('a row reporting zero sealed instruments is a violation; one or more is fine', () => {
      expect(run({ row: row({ sealed: { count: 0 } }) }).violated).toEqual(['gate-sealed'])
      expect(run({ row: row({ verify: { sealedCount: 0 } }) }).violated).toEqual(['gate-sealed'])
      const r = run({ row: row({ sealed: { count: 3 } }) })
      expect(r.intact).toBe(true)
      expect(r.evidence['gate-sealed'].detail).toMatch(/sealed count 3/)
    })
  })

  describe('rule-11', () => {
    it('is violated with no calibration on record', () => {
      const r = run({ state: state({ calibration: null }) })
      expect(r.violated).toEqual(['rule-11'])
      expect(r.evidence['rule-11'].detail).toMatch(/no calibration/)
    })
    it('is violated when the sha re-check did not run for this wave', () => {
      const r = run({ state: state({ rule11CheckedWave: 1 }) })
      expect(r.violated).toEqual(['rule-11'])
      expect(r.evidence['rule-11'].detail).toMatch(/wave 2/)
    })
    it('outside a verdict (no wave) only the calibration is asked for', () => {
      expect(assertIdentityIntact({ spec: spec(), state: state({ rule11CheckedWave: undefined }), io: okIo }).intact).toBe(true)
    })
  })

  describe('revert-refused', () => {
    it('is violated when the spec turns the ban off', () => {
      expect(run({ spec: spec({ invariants: { ...spec().invariants, revertBan: false } }) }).violated).toEqual(['revert-refused'])
    })
    it('an override cannot turn the ban off (effectiveInvariants keeps it)', () => {
      expect(run({ state: state({ invariantOverrides: { revertBan: false } }) }).intact).toBe(true)
    })
  })

  describe('marker-recorded', () => {
    it('is violated when the spec names no marker', () => {
      expect(run({ spec: spec({ marker: '' }) }).violated).toEqual(['marker-recorded'])
      expect(run({ spec: spec({ marker: undefined }) }).violated).toEqual(['marker-recorded'])
    })
    it('is violated when the row does not record markerSeen; null is a recorded "not seen"', () => {
      const r = run({ row: { missionId: 'm' } })
      expect(r.violated).toEqual(['marker-recorded'])
      expect(r.evidence['marker-recorded'].detail).toMatch(/markerSeen/)
      expect(run({ row: row({ markerSeen: null }) }).intact).toBe(true)
      expect(run({ row: row({ markerSeen: true }) }).intact).toBe(true)
    })
    it('without a row only the spec is asked for', () => {
      expect(run({ row: null }).intact).toBe(true)
    })
  })

  it('names every invariant that broke, in order', () => {
    const r = run({ spec: spec({ marker: '', gate: 'C:/repo/g.py' }), state: state({ calibration: null }) })
    expect(r.violated).toEqual(['gate-sealed', 'rule-11', 'marker-recorded'])
    expect(r.intact).toBe(false)
  })
})

describe('refusesIdentity', () => {
  it.each([
    ['identity/gate-sealed', true],
    ['identity/anything', true],
    ['invariants/revertBan', true],
    ['invariants/codeIndexFirst', true],
    ['spec/marker', true],
    ['calibration/gateSha256', true],
    ['invariants/editGapCap', false],
    ['invariants/commitGapCap', false],
    ['ideation/brief', false],
    ['gate-author/gate', false],
    ['gate/c9', false],
    ['', false],
    [undefined, false],
  ])('%s → %s', (name, refused) => {
    expect(refusesIdentity(name)).toBe(refused)
  })
})
