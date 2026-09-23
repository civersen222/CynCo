import { describe, it, expect } from 'vitest'
import { governanceCounts, governancePosiwid, GOVERNANCE_PURPOSE } from '../cynco-governance-posiwid.mjs'

const row = () => ({
  missionId: 'm', toolStats: { total: 100 },
  invariants: { denialCount: 4, denials: [
    { callIndex: 1, invariant: 'edit-gap', tool: 'Read', nextCallClass: 'sourceEdit' },
    { callIndex: 2, invariant: 'edit-gap', tool: 'Grep', nextCallClass: 'inspect' },
    { callIndex: 3, invariant: 'commit-gap', tool: 'Read', nextCallClass: 'commit' },
    { callIndex: 4, invariant: 'revert', tool: 'Bash', nextCallClass: 'read' } ],
    denialsByInvariant: { 'edit-gap': 2, 'commit-gap': 1, revert: 1 } },
  s5Decisions: [{ enforced: true, ruleIds: ['I3'] }, { enforced: false, ruleIds: ['I1'] }, { enforced: null, ruleIds: ['I4'] }],
  controlSignals: [{}, {}, {}],
  turns: new Array(10).fill({}),
  routing: { entries: [{ kind: 'revert', outcome: 'passed', nextCallClass: 'sourceEdit' }, { kind: 'low-confidence-edit', outcome: 'failed', nextCallClass: 'inspect' }] },
})
const wave = () => ({ s4: { followed: true, workOrder: { applied: false } } })

describe('governanceCounts', () => {
  it('counts denials that changed the next call, consumed recommendations, and logged-only signals', () => {
    const c = governanceCounts({ row: row(), wave: wave(), proposalsDecided: 1 })
    // changed: sourceEdit, commit → 2 (inspect, read are looks)
    expect(c.denialsChanged).toBe(2)
    // consumed: 1 enforced S5 + followed 1 + workOrder 0 + proposals 1 + routed-then-complied 1 (the revert route whose next call was sourceEdit)
    expect(c.recommendationsConsumed).toBe(4)
    // logged: 2 S5 not enforced + 3 control signals + 10 status frames
    expect(c.signalsLogged).toBe(15)
  })
  it('is all zeros for a row without governance data', () => {
    expect(governanceCounts({ row: { toolStats: { total: 0 } }, wave: {}, proposalsDecided: 0 })).toEqual({ denialsChanged: 0, recommendationsConsumed: 0, signalsLogged: 0 })
  })
})

describe('governancePosiwid', () => {
  const w = (changed, consumed, logged) => ({ denialsChanged: changed, recommendationsConsumed: consumed, signalsLogged: logged })
  it('reads Contradicted when logging dominates — the collector verdict', () => {
    const r = governancePosiwid([w(2, 3, 40)])
    expect(r.verdict).toBe('Contradicted'); expect(r.dominantObserved).toBe('signalsLogged'); expect(r.support).toBe(45)
  })
  it('reads Consistent when the wave mostly regulated', () => {
    const r = governancePosiwid([w(12, 10, 3)])
    expect(r.verdict).toBe('Consistent'); expect(r.dominantObserved).toBe('denialsChanged')
  })
  it('is Insufficient under 20 observations and has no onset', () => {
    const r = governancePosiwid([w(2, 1, 5)])
    expect(r.verdict).toBe('Insufficient'); expect(r.onsetWave).toBeNull()
  })
  it('detects a drift onset at the wave where logging takes over, replaying deterministically', () => {
    const windows = [w(12, 10, 3), w(11, 9, 4), w(3, 2, 30), w(2, 2, 40)]
    const r = governancePosiwid(windows)
    expect(r.windows).toBe(4)
    expect(r.onsetWave).toBeGreaterThanOrEqual(3)
    expect(governancePosiwid(windows).onsetWave).toBe(r.onsetWave)   // replay is deterministic
  })
  it('exposes the stated purpose with no weight on logging', () => {
    expect(GOVERNANCE_PURPOSE.shareOf('signalsLogged')).toBe(0)
    expect(GOVERNANCE_PURPOSE.shareOf('denialsChanged')).toBe(0.5)
  })
})
