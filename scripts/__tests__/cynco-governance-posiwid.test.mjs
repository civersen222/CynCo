import { describe, it, expect } from 'vitest'
import { governanceCounts, governancePosiwid, GOVERNANCE_PURPOSE, governancePurposeFor, governancePosiwidV2, authorityOf } from '../cynco-governance-posiwid.mjs'

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
    // logged: 2 S5 not enforced + 3 control signals (turns are not a signal — ruling 13)
    expect(c.signalsLogged).toBe(5)
  })
  it('is all zeros for a row without governance data', () => {
    expect(governanceCounts({ row: { toolStats: { total: 0 } }, wave: {}, proposalsDecided: 0 })).toEqual({ denialsChanged: 0, recommendationsConsumed: 0, signalsLogged: 0 })
  })
  it('does not count status frames (turns) as a signal — Phase 3 ruling 13', () => {
    const c = governanceCounts({ row: { toolStats: { total: 0 }, turns: new Array(40).fill({}) }, wave: {}, proposalsDecided: 0 })
    expect(c.signalsLogged).toBe(0)
  })
  it('counts only S5-not-enforced and control-signal frames as logged, ignoring turns', () => {
    const c = governanceCounts({
      row: {
        toolStats: { total: 0 },
        s5Decisions: [{ enforced: false }, { enforced: false }, { enforced: false }],
        controlSignals: [{}, {}],
        turns: new Array(40).fill({}),
      },
      wave: {},
      proposalsDecided: 0,
    })
    expect(c.signalsLogged).toBe(5)
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
  it('reports the onset as the stored window wave, not its index — campaigns graded before Task 1 start at wave 4', () => {
    const r = governancePosiwid([{ wave: 4, ...w(2, 1, 30) }])
    expect(r.onsetWave).toBe(4)
  })
  it('reports the onset wave across a gap in the windows', () => {
    const r = governancePosiwid([{ wave: 1, ...w(12, 10, 3) }, { wave: 3, ...w(2, 1, 30) }])
    expect(r.onsetWave).toBe(3)
  })
  it('falls back to the 1-based index when a window carries no wave', () => {
    const r = governancePosiwid([w(12, 10, 3), w(2, 1, 30)])
    expect(r.onsetWave).toBe(2)
  })
  it('exposes the stated purpose with no weight on logging', () => {
    expect(GOVERNANCE_PURPOSE.shareOf('signalsLogged')).toBe(0)
    expect(GOVERNANCE_PURPOSE.shareOf('denialsChanged')).toBe(0.5)
  })
})

// Phase 7 ruling 4: v2 states the purpose the authority table actually grants.
describe('governancePurposeFor', () => {
  const shares = (p) => ({ denialsChanged: p.shareOf('denialsChanged'), recommendationsConsumed: p.shareOf('recommendationsConsumed'), signalsLogged: p.shareOf('signalsLogged') })
  it('gives logging the whole share when no rule has earned authority', () => {
    expect(shares(governancePurposeFor({ earned: 0, total: 8 }))).toEqual({ denialsChanged: 0, recommendationsConsumed: 0, signalsLogged: 1 })
  })
  it('splits the earned fraction across regulation and the rest to logging', () => {
    expect(shares(governancePurposeFor({ earned: 2, total: 8 }))).toEqual({ denialsChanged: 0.125, recommendationsConsumed: 0.125, signalsLogged: 0.75 })
  })
  it('reads an empty authority table as all-logging', () => {
    expect(shares(governancePurposeFor({ earned: 0, total: 0 }))).toEqual({ denialsChanged: 0, recommendationsConsumed: 0, signalsLogged: 1 })
  })
})

describe('governancePosiwidV2', () => {
  // The C9 shape: 1201 signals logged, 5 denials that changed the next call, nothing consumed.
  const c9 = { denialsChanged: 5, recommendationsConsumed: 0, signalsLogged: 1201 }
  it('reads the logging-dominated wave Contradicted under v1 and Consistent under v2 at e = 0', () => {
    expect(governancePosiwid([c9]).verdict).toBe('Contradicted')
    const v2 = governancePosiwidV2(c9, { earned: 0, total: 8 })
    expect(v2.verdict).toBe('Consistent')
    expect(v2.dominantObserved).toBe('signalsLogged')
    expect(typeof v2.divergence).toBe('number')
    expect(v2.stated).toEqual({ earned: 0, total: 8 })
  })
  it('reads the same wave Contradicted under v2 when every rule has earned authority (e = 1)', () => {
    expect(governancePosiwidV2(c9, { earned: 8, total: 8 }).verdict).toBe('Contradicted')
  })
  it('is Insufficient under the same support floor as v1', () => {
    expect(governancePosiwidV2({ denialsChanged: 1, recommendationsConsumed: 0, signalsLogged: 3 }, { earned: 0, total: 8 }).verdict).toBe('Insufficient')
  })
})

describe('authorityOf', () => {
  it('counts S5 rule rows with a string verdict, earned = PREDICTIVE, skipping model and runner rows', () => {
    const file = { schema: 1, rules: {
      I1: { verdict: 'PREDICTIVE' }, I2: { verdict: 'NOT PREDICTIVE' }, W5: { verdict: 'PREDICTIVE', source: 'rule' }, X: { verdict: null },
      'M1.lr': { verdict: 'PREDICTIVE', source: 'model' }, 'R1.no-progress': { verdict: 'PREDICTIVE', source: 'runner' } } }
    expect(authorityOf(file)).toEqual({ earned: 2, total: 3 })
  })
  it('is { earned: 0, total: 0 } when there is no verdict file', () => {
    expect(authorityOf(null)).toEqual({ earned: 0, total: 0 })
  })
})
