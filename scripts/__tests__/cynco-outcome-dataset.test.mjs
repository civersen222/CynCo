import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  featuresOf, datasetRows, frozenSplit, freezeManifest, FEATURE_KEYS_V1, FEATURE_KEYS_V2, FEATURE_KEYS_BY_VERSION,
  signalsVersionOf, PREFIX_TURNS, DEFAULT_TURNS, main,
  setKeyOf, READING_UNIT, readingIdOf, heldSetFor, manifestSets, ensureVersionHoldout, FREEZE_MIN_ELIGIBLE, AUTO_FREEZE_SEED,
} from '../cynco-outcome-dataset.mjs'
import { labelOf } from '../cynco-signal-validation.mjs'

const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }

// One turn as the ledger writes it (keys copied from a real row), every signal
// carrying the turn index so "which turns went in" is readable off the value.
const turn = (i, over = {}) => ({
  t: 1000 + i, health: 'healthy', s3s4Balance: 'balanced',
  toolSuccessRate: i / 100, stuckTurns: i, varietyRatio: i, varietyWindowed: i,
  taskError: i, errorTrend: 'flat', fingerprintAlarm: null, infoGain: i,
  progressRate: i, explorationState: 'healthy_exploration', varietyBalance: 'balanced',
  algedonicAlerts: i, axiomHealth: { holding: 1, total: 3, violations: Array.from({ length: i }, (_, k) => `v${k}`) },
  consecutiveUnstable: i, agreementRatio: 0, predictions: null, s4: null,
  heterarchy: { context: 'normal', commander: 'S3', shifted: false },
  brain: { tier: 'live', layerConvergence: null, toolEntropy: { mean: i, max: i * 2, spikeCount: 0 } },
  snapshot: null, ...over,
})

const row = (id, { label = 'fail', turns = 40, turnFn = turn, ...over } = {}) => ({
  missionId: id,
  outcome: label === 'success' ? 'landed' : 'failed',
  verified: label === 'unlabeled' ? null : label === 'success',
  mutationSweep: sweep,
  toolStats: { total: 999 }, durationS: 12345, exitReason: 'done', commits: 7,
  turns: Array.from({ length: turns }, (_, i) => turnFn(i)),
  ...over,
})

// The documented feature list (benchmark/cynco-ledger/README.md, "Outcome
// dataset and the frozen holdout"). Written out here, not derived, so adding a
// feature is a deliberate change to the doc and this list together.
const LEVELS = ['toolSuccessRate', 'varietyRatio', 'varietyWindowed', 'taskError', 'infoGain', 'progressRate',
  'axiomViolations', 'toolEntropyMean', 'toolEntropyMax']
const DOCUMENTED = [
  ...LEVELS.flatMap(n => [`${n}.mean`, `${n}.last`, `${n}.max`]),
  'stuckTurns.rate', 'stuckTurns.last', 'stuckTurns.max',
  // `.last`/`.max` dropped (final review T4-N2): the session-era alert count
  // before the mission began is an era confound; `.rate` measures from the
  // prefix's own first value.
  'algedonicAlerts.rate',
  'consecutiveUnstable.last', 'consecutiveUnstable.max',
  'brainPresent',
  'errorTrend.rising', 'errorTrend.flat', 'errorTrend.falling',
  'explorationState.healthy_exploration', 'explorationState.thrashing', 'explorationState.floundering',
  'health.healthy', 'health.warning', 'health.critical',
  's3s4Balance.balanced', 's3s4Balance.s3_dominant', 's3s4Balance.s4_dominant', 's3s4Balance.critical',
  'varietyBalance.balanced', 'varietyBalance.underload', 'varietyBalance.overload', 'varietyBalance.critical',
  'commander.S1', 'commander.S2', 'commander.S3', 'commander.S4', 'commander.S5',
]
// F165: a v2 row (every prefix turn carries signalsVersion 2) adds the
// cumulative alert count's rate — what v1's algedonicAlerts.rate measured.
const DOCUMENTED_V2 = [...DOCUMENTED, 'algedonicAlertsTotal.rate']
const FORBIDDEN = ['verified', 'outcome', 'mutationSweep', 'toolStats', 'durationS', 'exitReason', 'commits',
  'identityGuard', 'regulatorFidelity', 'posiwidLive', 's5Decisions', 'invariants', 'routing', 'brainStats', 'ultrastable']

describe('featuresOf — the first K turns only', () => {
  it('the prefix points are K = 16 (primary) and K = 32', () => {
    expect(PREFIX_TURNS).toEqual([16, 32])
    expect(DEFAULT_TURNS).toBe(16)
  })

  it('K = 16 of 40 turns reads turns 0–15 and nothing after', () => {
    const f = featuresOf(row('m1'), 16)
    expect(f).toEqual({ missionId: 'm1', prefixTurns: 16, signalsVersion: 1, label: false, features: expect.any(Object), leakGuard: true })
    expect(f.features['varietyRatio.last']).toBe(15)
    expect(f.features['varietyRatio.max']).toBe(15)
    expect(f.features['varietyRatio.mean']).toBe(7.5)
    expect(f.features['stuckTurns.last']).toBe(15)
    expect(f.features['axiomViolations.max']).toBe(15)
    expect(f.features['toolEntropyMax.max']).toBe(30)
    expect(f.features['consecutiveUnstable.max']).toBe(15)
    expect(f.features.brainPresent).toBe(1)
    expect('turnsInPrefix' in f.features).toBe(false)
  })

  it('one-hots come from turn K−1, never a later one', () => {
    const r = row('m2', { turnFn: (i) => turn(i, i === 15 ? { health: 'warning', heterarchy: { commander: 'S4' } }
      : i >= 16 ? { health: 'critical', errorTrend: 'rising', heterarchy: { commander: 'S5' } } : {}) })
    const f = featuresOf(r, 16).features
    expect(f['health.warning']).toBe(1)
    expect(f['health.critical']).toBe(0)
    expect(f['commander.S4']).toBe(1)
    expect(f['commander.S5']).toBe(0)
    expect(f['errorTrend.flat']).toBe(1)
    expect(f['errorTrend.rising']).toBe(0)
  })

  it('LEAK: no whole-mission field is a feature key or a prefix of one, and the key set is the documented list', () => {
    const r = row('m3', { verified: true, outcome: 'landed', toolStats: { total: 5 }, mutationSweep: sweep,
      identityGuard: {}, regulatorFidelity: {}, posiwidLive: {}, s5Decisions: [], invariants: [], routing: {}, brainStats: {}, ultrastable: {} })
    const keys = Object.keys(featuresOf(r, 16).features)
    expect(keys.filter(k => FORBIDDEN.some(n => k.startsWith(n)))).toEqual([])
    expect([...keys].sort()).toEqual([...DOCUMENTED].sort())
    expect([...FEATURE_KEYS_V1].sort()).toEqual([...DOCUMENTED].sort())
    expect(FEATURE_KEYS_V1).toHaveLength(56)
    expect(FEATURE_KEYS_V1.filter(k => k.startsWith('algedonicAlerts.'))).toEqual(['algedonicAlerts.rate'])
  })

  it('LEAK (v2, F165): a v2 row\'s key set is the documented v2 list, forbidden-free; algedonicAlertsTotal.* only on v2', () => {
    const v2 = (i) => turn(i, { signalsVersion: 2, algedonicAlertsTotal: 30 + i })
    const r = row('m3v2', { turnFn: v2, verified: true, outcome: 'landed', toolStats: { total: 5 }, identityGuard: {}, brainStats: {}, ultrastable: {} })
    const f = featuresOf(r, 16)
    expect(f.signalsVersion).toBe(2)
    const keys = Object.keys(f.features)
    expect(keys.filter(k => FORBIDDEN.some(n => k.startsWith(n)))).toEqual([])
    expect([...keys].sort()).toEqual([...DOCUMENTED_V2].sort())
    expect([...FEATURE_KEYS_V2].sort()).toEqual([...DOCUMENTED_V2].sort())
    expect(FEATURE_KEYS_V2).toHaveLength(57)
    expect(FEATURE_KEYS_BY_VERSION).toEqual({ 1: FEATURE_KEYS_V1, 2: FEATURE_KEYS_V2 })
    expect(FEATURE_KEYS_V1.some(k => k.startsWith('algedonicAlertsTotal.'))).toBe(false)
    expect(f.features['algedonicAlertsTotal.rate']).toBe(1)
    // A v1 row (no signalsVersion on its turns) never carries the v2 key.
    const v1 = featuresOf(row('m3v1'), 16)
    expect(v1.signalsVersion).toBe(1)
    expect('algedonicAlertsTotal.rate' in v1.features).toBe(false)
  })

  it('a prefix mixing versions is the older version (the minimum over its turns); after K does not count', () => {
    const mixed = row('mix', { turnFn: (i) => turn(i, i === 3 ? {} : { signalsVersion: 2, algedonicAlertsTotal: i }) })
    expect(featuresOf(mixed, 16).signalsVersion).toBe(1)
    const lateV1 = row('late', { turnFn: (i) => turn(i, i < 16 ? { signalsVersion: 2, algedonicAlertsTotal: i } : {}) })
    expect(featuresOf(lateV1, 16).signalsVersion).toBe(2)
    expect(signalsVersionOf([])).toBe(1)
  })

  it('LEAK (v2): a constant v2 row reads identically at K = 16 and K = 32', () => {
    const constant = row('c2', { turnFn: () => ({ signalsVersion: 2, algedonicAlertsTotal: 9, algedonicAlerts: 2, consecutiveUnstable: 3 }) })
    const a = featuresOf(constant, 16).features
    const b = featuresOf(constant, 32).features
    for (const k of Object.keys(a)) expect([k, b[k]]).toEqual([k, a[k]])
  })

  it('LEAK: no feature is a function of the turn index — a constant row reads identically at K = 16 and K = 32', () => {
    const constant = row('c', { turnFn: () => ({
      health: 'warning', s3s4Balance: 's3_dominant', toolSuccessRate: 0.7, stuckTurns: 2, varietyRatio: 3,
      varietyWindowed: 4, taskError: 0.5, errorTrend: 'rising', infoGain: 0.2, progressRate: 0.1,
      explorationState: 'thrashing', varietyBalance: 'overload', algedonicAlerts: 5,
      axiomHealth: { holding: 1, total: 3, violations: ['a', 'b'] }, consecutiveUnstable: 3,
      heterarchy: { commander: 'S4' }, brain: { toolEntropy: { mean: 0.4, max: 1.2 } },
    }) })
    const a = featuresOf(constant, 16).features
    const b = featuresOf(constant, 32).features
    const nonNull = Object.keys(a).filter(k => a[k] !== null)
    expect(nonNull).toHaveLength(56)
    // identical up to float summation order (a mean of sixteen 0.7s is not
    // bit-equal to a mean of thirty-two)
    for (const k of nonNull) expect(b[k], k).toBeCloseTo(a[k], 12)
  })

  it('the counters are per-turn rates: new alerts per turn, share of turns stuck', () => {
    // alerts climb one per turn; stuck on every other turn
    const r = row('r', { turnFn: (i) => turn(i, { algedonicAlerts: 10 + i, stuckTurns: i % 2 }) })
    for (const K of PREFIX_TURNS) {
      const f = featuresOf(r, K).features
      expect(f['algedonicAlerts.rate']).toBe(1)
      expect(f['stuckTurns.rate']).toBe(0.5)
    }
  })

  it('a prefix whose signal is null throughout reads null, not 0; no entropy → brainPresent 0', () => {
    const r = row('m4', { turnFn: (i) => turn(i, { stuckTurns: null, algedonicAlerts: null, brain: { tier: 'off', toolEntropy: null },
      axiomHealth: null, errorTrend: null, heterarchy: null }) })
    const f = featuresOf(r, 16).features
    for (const k of ['toolEntropyMean.mean', 'toolEntropyMax.max', 'axiomViolations.last', 'stuckTurns.rate',
      'stuckTurns.last', 'algedonicAlerts.rate']) expect([k, f[k]]).toEqual([k, null])
    expect(f.brainPresent).toBe(0)
    expect(f['errorTrend.flat'] + f['errorTrend.rising'] + f['errorTrend.falling']).toBe(0)
    expect(f['commander.S3']).toBe(0)
  })

  it('.last is the last non-null value in the prefix; nulls are skipped by mean', () => {
    const r = row('m5', { turnFn: (i) => turn(i, { taskError: i === 15 ? null : i }) })
    const f = featuresOf(r, 16).features
    expect(f['taskError.last']).toBe(14)
    expect(f['taskError.mean']).toBe(7)
  })

  it('label is labelOf(row), for every branch', () => {
    for (const r of [row('a', { label: 'success' }), row('b', { label: 'fail' }), row('c', { label: 'unlabeled' }),
      row('d', { label: 'success', mutationSweep: null })]) {
      expect(featuresOf(r, 16).label).toBe(labelOf(r))
    }
    expect(featuresOf(row('a', { label: 'success' }), 16).label).toBe(true)
  })

  it('a mission shorter than K is refused, never truncated; a bad K throws', () => {
    expect(() => featuresOf(row('m6', { turns: 15 }), 16)).toThrow(/fewer than K = 16/)
    expect(() => featuresOf(row('m6'), 0)).toThrow(/turns/)
    expect(() => featuresOf(row('m6'), 0.5)).toThrow(/turns/)
  })
})

describe('datasetRows', () => {
  it('keeps labeled rows with ≥ K turns and counts exclusions per K', () => {
    const rows = [row('ok1'), row('mid', { label: 'success', turns: 20 }), row('short', { turns: 10 }),
      row('unl', { label: 'unlabeled' }), row('unl-short', { label: 'unlabeled', turns: 1 })]
    const at16 = datasetRows(rows, 16)
    expect(at16.rows.map(r => r.missionId)).toEqual(['ok1', 'mid'])
    expect(at16.excluded).toEqual({ unlabeled: 2, short: 1 })
    expect(at16.rows.every(r => r.prefixTurns === 16)).toBe(true)
    const at32 = datasetRows(rows, 32)
    expect(at32.rows.map(r => r.missionId)).toEqual(['ok1'])
    expect(at32.excluded).toEqual({ unlabeled: 2, short: 2 })
  })

  it('signalsVersion filter keeps version-N rows and counts the rest (F165)', () => {
    const v2 = (id, label = 'fail') => row(id, { label, turnFn: (i) => turn(i, { signalsVersion: 2, algedonicAlertsTotal: i }) })
    const rows = [row('old1'), row('old2', { label: 'success' }), v2('new1'), row('short', { turns: 3 })]
    const all = datasetRows(rows, 16)
    expect(all.rows.map(r => [r.missionId, r.signalsVersion])).toEqual([['old1', 1], ['old2', 1], ['new1', 2]])
    expect(all.excluded).toEqual({ unlabeled: 0, short: 1 })
    const only2 = datasetRows(rows, 16, { signalsVersion: 2 })
    expect(only2.rows.map(r => r.missionId)).toEqual(['new1'])
    expect(only2.excluded).toEqual({ unlabeled: 0, short: 1, otherVersion: 2 })
    expect(datasetRows(rows, 16, { signalsVersion: 1 }).rows.map(r => r.missionId)).toEqual(['old1', 'old2'])
    expect(() => datasetRows(rows, 16, { signalsVersion: 1.5 })).toThrow(/signalsVersion/)
  })

  it('counts out-of-vocabulary categorical values on turn K−1 (and not absent ones)', () => {
    const odd = row('odd', { turnFn: (i) => turn(i, i === 15 ? { health: 'meltdown', heterarchy: { commander: 'S9' } } : {}) })
    const out = datasetRows([odd, row('odd2', { turnFn: (i) => turn(i, { health: 'meltdown', errorTrend: null }) }), row('fine')], 16)
    expect(out.unknownValues).toEqual({ 'health.meltdown': 2, 'commander.S9': 1 })
    expect(out.rows[0].features['health.healthy'] + out.rows[0].features['health.warning'] + out.rows[0].features['health.critical']).toBe(0)
    expect(datasetRows([row('fine')], 16).unknownValues).toEqual({})
  })
})

const twenty = () => [
  ...Array.from({ length: 12 }, (_, i) => row(`f${String(i).padStart(2, '0')}`, { label: 'fail' })),
  ...Array.from({ length: 8 }, (_, i) => row(`s${String(i).padStart(2, '0')}`, { label: 'success' })),
]

describe('freezeManifest', () => {
  const now = () => '2026-09-26T00:00:00.000Z'

  it('20 labeled rows (12 fail / 8 success) → 4 ids, both labels, deterministic for the seed', () => {
    const m = freezeManifest(twenty(), { seed: 7, now })
    expect(m).toMatchObject({ schema: 1, version: 1, seed: 7, frozenAt: '2026-09-26T00:00:00.000Z' })
    expect(m.missionIds).toHaveLength(4)
    expect(m.missionIds.some(id => id.startsWith('f'))).toBe(true)
    expect(m.missionIds.some(id => id.startsWith('s'))).toBe(true)
    expect(freezeManifest(twenty(), { seed: 7, now }).missionIds).toEqual(m.missionIds)
    expect(freezeManifest(twenty().reverse(), { seed: 7, now }).missionIds).toEqual(m.missionIds)
    const others = [1, 2, 3, 4, 5].map(seed => freezeManifest(twenty(), { seed, now }).missionIds.join())
    expect(others.some(ids => ids !== m.missionIds.join())).toBe(true)
  })

  it('each label draws from its own stream: one more failure does not move the successes drawn', () => {
    const successes = (m) => m.missionIds.filter(id => id.startsWith('s'))
    for (const seed of [1, 2, 3, 7, 20260926]) {
      const base = freezeManifest(twenty(), { seed, now })
      const grown = freezeManifest([...twenty(), row('f99')], { seed, now })
      expect(successes(grown)).toEqual(successes(base))
    }
  })

  it('unlabeled rows and rows shorter than K are never held out', () => {
    const extra = [...Array.from({ length: 10 }, (_, i) => row(`u${i}`, { label: 'unlabeled' })),
      ...Array.from({ length: 10 }, (_, i) => row(`t${i}`, { turns: 20 }))]
    const m = freezeManifest([...twenty(), ...extra], { seed: 7, turns: 32, now })
    expect(m.missionIds).toHaveLength(4)
    expect(m.missionIds.every(id => /^[fs]/.test(id))).toBe(true)
  })

  it('one label only still yields 20 %; one of each when both exist even if rounding says 0', () => {
    expect(freezeManifest(twenty().slice(0, 12), { seed: 1, now }).missionIds).toHaveLength(2)
    const skew = [...Array.from({ length: 9 }, (_, i) => row(`f${i}`)), row('s0', { label: 'success' })]
    const m = freezeManifest(skew, { seed: 1, now })
    expect(m.missionIds).toContain('s0')
    expect(m.missionIds.some(id => id.startsWith('f'))).toBe(true)
  })

  it('refreeze keeps every previous id (even one no longer in the rows) and writes version + 1', () => {
    const v1 = freezeManifest(twenty(), { seed: 7, now })
    const grown = [...twenty(), ...Array.from({ length: 20 }, (_, i) => row(`g${i}`, { label: i % 2 ? 'success' : 'fail' }))]
    const withGhost = { ...v1, missionIds: [...v1.missionIds, 'ghost'] }
    const v2 = freezeManifest(grown, { seed: 9, previous: withGhost, now })
    expect(v2.version).toBe(2)
    for (const id of withGhost.missionIds) expect(v2.missionIds).toContain(id)
    expect(v2.missionIds.length).toBeGreaterThanOrEqual(8)
    expect(freezeManifest(twenty().slice(0, 5), { seed: 3, previous: v1, now }).missionIds).toEqual(expect.arrayContaining(v1.missionIds))
  })

  it('refuses a seed that is not an integer', () => {
    expect(() => freezeManifest(twenty(), { seed: 'x', now })).toThrow(/seed/)
  })
})

describe('frozenSplit', () => {
  it('splits by manifest and reports manifest ids missing from the rows', () => {
    const split = frozenSplit(twenty(), { missionIds: ['f00', 's01', 'gone'] })
    expect(split.holdout.map(r => r.missionId)).toEqual(['f00', 's01'])
    expect(split.train).toHaveLength(18)
    expect(split.missing).toEqual(['gone'])
    expect(split.ineligible).toEqual([])
    expect(split.train.some(r => r.missionId === 'f00')).toBe(false)
  })

  it('with turns: K, held ids not eligible at K are reported as ineligible and leave both splits', () => {
    const rows = [...twenty(), row('short-held', { turns: 20 }), row('short-train', { turns: 20 }), row('unl-held', { label: 'unlabeled' })]
    const split = frozenSplit(rows, { missionIds: ['f00', 'short-held', 'unl-held', 'gone'] }, { turns: 32 })
    expect(split.holdout.map(r => r.missionId)).toEqual(['f00'])
    expect(split.ineligible).toEqual(['short-held', 'unl-held'])
    expect(split.missing).toEqual(['gone'])
    expect(split.train).toHaveLength(19)
    expect(frozenSplit(rows, { missionIds: ['short-held'] }, { turns: 16 }).ineligible).toEqual([])
  })
})

// Phase 7 ruling 1: the reading unit's holdout — a set of its own,
// `reading:<v>`, frozen by the same rule, split by WHOLE missions.
describe('the reading unit\'s holdout', () => {
  const now = () => '2026-10-02T00:00:00.000Z'
  // `n` missions with `per` intervals each; mission i's intervals alternate
  // improved / stalled starting from i's parity, so every mission has both.
  const readings = (n, per = 3, label = (m, k) => ((m + k) % 2 ? 'improved' : 'stalled')) =>
    Array.from({ length: n }, (_, m) => Array.from({ length: per }, (_, k) => ({
      missionId: `m${String(m).padStart(2, '0')}`, interval: k, label: label(m, k), signalsVersion: 2, features: {}, leakGuard: true,
    }))).flat()

  it('the set key is "<v>" for missions and "reading:<v>" for readings', () => {
    expect(setKeyOf(2)).toBe('2')
    expect(setKeyOf(2, 'mission')).toBe('2')
    expect(setKeyOf(2, READING_UNIT)).toBe('reading:2')
    expect(readingIdOf({ missionId: 'm01', interval: 3 })).toBe('m01:3')
    const file = { schema: 2, sets: { 2: { missionIds: ['a'] }, 'reading:2': { missionIds: ['b'] } }, history: [] }
    expect(heldSetFor(file, 2).missionIds).toEqual(['a'])
    expect(heldSetFor(file, 2, { unit: 'reading' }).missionIds).toEqual(['b'])
  })

  it('freezes ~20 % of the readings by whole missions, both labels, deterministic for the seed', () => {
    const rows = readings(20, 2)
    const m = freezeManifest(rows, { unit: 'reading', seed: 7, now })
    expect(m).toMatchObject({ schema: 1, unit: 'reading', version: 1, seed: 7, frozenAt: '2026-10-02T00:00:00.000Z' })
    // 40 readings → 8 held (4 of each label); each mission carries one of each, so 4 whole missions.
    expect(m.ids).toHaveLength(8)
    expect(m.missionIds).toHaveLength(4)
    const others = [1, 2, 3, 4, 5].map(seed => freezeManifest(rows, { unit: 'reading', seed, now }).missionIds.join())
    expect(others.some(ids => ids !== m.missionIds.join())).toBe(true)
    // Whole missions: every interval of a held mission is held, and nothing else.
    expect(m.ids).toEqual(rows.filter(r => m.missionIds.includes(r.missionId)).map(readingIdOf).sort())
    const held = rows.filter(r => m.missionIds.includes(r.missionId))
    expect(held.some(r => r.label === 'improved') && held.some(r => r.label === 'stalled')).toBe(true)
    expect(freezeManifest([...rows].reverse(), { unit: 'reading', seed: 7, now })).toEqual(m)
  })

  it('frozenSplit by a reading set never puts one mission\'s intervals on both sides', () => {
    const rows = readings(20, 3)
    const m = freezeManifest(rows, { unit: 'reading', seed: 7, now })
    // A reading added later to a held mission is held too — the mission is the unit of the split.
    const heldLate = { missionId: m.missionIds[0], interval: 9, label: 'improved' }
    const s = frozenSplit([...rows, { missionId: 'late', interval: 0, label: 'improved' }, heldLate], m, { unit: 'reading' })
    const trainM = new Set(s.train.map(r => r.missionId)), holdM = new Set(s.holdout.map(r => r.missionId))
    expect([...trainM].filter(id => holdM.has(id))).toEqual([])
    expect(s.holdout).toHaveLength(m.ids.length + 1)
    expect(s.train).toHaveLength(60 - m.ids.length + 1)
    expect(s.missing).toEqual([])
    expect(() => frozenSplit(rows, m, { unit: 'reading', turns: 16 })).toThrow(/turns/)
  })

  it('ensureVersionHoldout below the minimum: not frozen, the counts per label, the file untouched', () => {
    const d = mkdtempSync(join(tmpdir(), 'reading-holdout-'))
    const path = join(d, 'frozen-eval.json')
    writeFileSync(path, JSON.stringify({ schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ['x'] }, null, 2) + '\n')
    const before = readFileSync(path, 'utf8')
    expect(ensureVersionHoldout({ rows: readings(12), path, v: 2, unit: 'reading', now }))
      .toEqual({ set: null, holdout: { frozen: false, unit: 'reading', eligible: 36, needed: 38, improved: 18, stalled: 18, needEach: 8 } })
    // 38 readings but 7 improved: still not frozen.
    const skew = readings(19, 2, (m, k) => (m * 2 + k < 7 ? 'improved' : 'stalled'))
    expect(ensureVersionHoldout({ rows: skew, path, v: 2, unit: 'reading', now }).holdout).toMatchObject({ frozen: false, eligible: 38, improved: 7, stalled: 31 })
    // Readings of another version are not in the pool.
    expect(ensureVersionHoldout({ rows: readings(13).map(r => ({ ...r, signalsVersion: 3 })), path, v: 2, unit: 'reading', now }).holdout).toMatchObject({ eligible: 0 })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('at the minimum: frozen once under sets["reading:2"], recorded on the history, "1" and "2" byte-identical', () => {
    const d = mkdtempSync(join(tmpdir(), 'reading-holdout-'))
    const path = join(d, 'frozen-eval.json')
    const one = { schema: 1, version: 1, seed: 20260926, frozenAt: 't1', missionIds: ['v1-a', 'v1-b'] }
    const two = { schema: 1, version: 1, seed: AUTO_FREEZE_SEED, frozenAt: 't2', missionIds: ['v2-a'] }
    writeFileSync(path, JSON.stringify({ schema: 2, sets: { 1: one, 2: two }, history: [{ signalsVersion: 2, frozenAt: 't2', count: 1, eligible: 38, seed: AUTO_FREEZE_SEED, how: 'auto' }] }, null, 2) + '\n')
    const setText = (k) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).sets[k], null, 2)
    const before = { 1: setText('1'), 2: setText('2') }
    const rows = readings(19, 2)
    expect(rows).toHaveLength(FREEZE_MIN_ELIGIBLE)
    const r = ensureVersionHoldout({ rows, path, v: 2, unit: 'reading', now })
    const expected = freezeManifest(rows, { unit: 'reading', seed: AUTO_FREEZE_SEED, now })
    expect(r.set).toEqual(expected)
    expect(r.holdout).toEqual({ frozen: true, frozenNow: true, frozenAt: '2026-10-02T00:00:00.000Z', ids: expected.ids.length, missions: expected.missionIds.length })
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(file.sets).sort()).toEqual(['1', '2', 'reading:2'])
    expect(file.sets['reading:2']).toEqual(expected)
    expect(setText('1')).toBe(before[1])
    expect(setText('2')).toBe(before[2])
    expect(file.history.at(-1)).toEqual({ signalsVersion: 2, unit: 'reading', frozenAt: '2026-10-02T00:00:00.000Z', count: expected.ids.length,
      missions: expected.missionIds.length, eligible: 38, seed: AUTO_FREEZE_SEED, how: 'auto' })
    // Frozen means frozen: a later, larger pool changes nothing on disk.
    const text = readFileSync(path, 'utf8')
    expect(ensureVersionHoldout({ rows: readings(40), path, v: 2, unit: 'reading', now: () => 'later' }).holdout)
      .toEqual({ frozen: true, frozenNow: false, frozenAt: '2026-10-02T00:00:00.000Z', ids: expected.ids.length, missions: expected.missionIds.length })
    expect(readFileSync(path, 'utf8')).toBe(text)
    // The mission set "2" is not the reading set: a v2 mission freeze would see its own.
    expect(heldSetFor(manifestSets(file), 2)).toEqual(two)
  })
})

describe('CLI', () => {
  const ledger = (rows = twenty()) => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-ledger-'))
    writeFileSync(join(dir, 'missions.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return dir
  }
  const capture = () => { const lines = []; return { lines, log: (s) => lines.push(s), error: (s) => lines.push(s) } }

  it('--export --turns K writes one JSONL row per eligible mission, each carrying prefixTurns', async () => {
    const dir = ledger([...twenty(), row('mid', { turns: 20 })])
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'sub', 'ds.jsonl')
    const io = capture()
    expect(await main(['--export', '--ledger-dir', dir, '--turns', '32', '--out', out], io)).toBe(0)
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(20)
    expect(lines[0]).toMatchObject({ prefixTurns: 32, leakGuard: true })
    expect(io.lines[0]).toMatch(/20 rows at K = 32 turns \(excluded 0 unlabeled, 1 short\)/)
    expect(await main(['--export', '--ledger-dir', dir, '--out', out], capture())).toBe(0)
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(21)
  })

  it('--export --signals-version N keeps only version-N rows and says how many it left out (F165)', async () => {
    const v2 = row('new', { turnFn: (i) => turn(i, { signalsVersion: 2, algedonicAlertsTotal: i }) })
    const dir = ledger([...twenty(), v2])
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'ds.jsonl')
    const io = capture()
    expect(await main(['--export', '--ledger-dir', dir, '--signals-version', '2', '--out', out], io)).toBe(0)
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => [l.missionId, l.signalsVersion])).toEqual([['new', 2]])
    expect('algedonicAlertsTotal.rate' in lines[0].features).toBe(true)
    expect(io.lines[0]).toMatch(/1 rows at K = 16 turns, signals v2 \(excluded 0 unlabeled, 0 short, 20 other signals version\)/)
    expect(await main(['--export', '--ledger-dir', dir, '--out', out], capture())).toBe(0)
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(21)
    expect(await main(['--export', '--ledger-dir', dir, '--signals-version', 'two', '--out', out], capture())).toBe(2)
    expect(await main(['--export', '--ledger-dir', dir, '--signals-version', '0', '--out', out], capture())).toBe(2)
  })

  it('--export prints unknown categorical values; --fraction and a bad --turns are refused', async () => {
    const dir = ledger([row('odd', { turnFn: (i) => turn(i, { health: 'meltdown' }) })])
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'ds.jsonl')
    const io = capture()
    expect(await main(['--export', '--ledger-dir', dir, '--out', out], io)).toBe(0)
    expect(io.lines[0]).toMatch(/unknown categorical values: health\.meltdown ×1/)
    expect(await main(['--export', '--ledger-dir', dir, '--fraction', '0.5', '--out', out], capture())).toBe(2)
    expect(await main(['--export', '--ledger-dir', dir, '--turns', 'x', '--out', out], capture())).toBe(2)
  })

  it('--freeze writes the manifest and refuses when it exists; --refreeze adds', async () => {
    const dir = ledger()
    const manifest = join(mkdtempSync(join(tmpdir(), 'outcome-man-')), 'frozen-eval.json')
    expect(await main(['--freeze', '--seed', '5', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(0)
    const v1 = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(v1.missionIds).toHaveLength(4)
    expect(await main(['--freeze', '--seed', '5', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(v1)
    expect(await main(['--refreeze', '--seed', '6', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(0)
    const v2 = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(v2.version).toBe(2)
    expect(v2.missionIds).toEqual(expect.arrayContaining(v1.missionIds))
  })

  it('--freeze/--refreeze --signals-version N act on that version\'s set only; v1\'s ids never move (F165 fix round 2)', async () => {
    const v2 = (id, label) => row(id, { label, turnFn: (i) => turn(i, { signalsVersion: 2 }) })
    const dir = ledger([...twenty(), ...Array.from({ length: 10 }, (_, i) => v2(`n${i}`, i < 6 ? 'fail' : 'success'))])
    const manifest = join(mkdtempSync(join(tmpdir(), 'outcome-man-')), 'frozen-eval.json')
    // A Phase 5 file (v1's set) first.
    expect(await main(['--freeze', '--seed', '5', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(0)
    const v1 = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(v1.schema).toBe(1)
    // The v2 freeze migrates the file and draws from v2 rows only.
    expect(await main(['--freeze', '--seed', '7', '--signals-version', '2', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(0)
    const f = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(f.schema).toBe(2)
    expect(f.sets['1']).toEqual(v1)
    expect(f.sets['2'].missionIds.length).toBe(2)
    expect(f.sets['2'].missionIds.every(id => id.startsWith('n'))).toBe(true)
    expect(f.history).toEqual([expect.objectContaining({ signalsVersion: 2, count: 2, eligible: 10, seed: 7, how: 'freeze' })])
    // Frozen once: a second --freeze of v2 is refused and changes nothing.
    const text = readFileSync(manifest, 'utf8')
    expect(await main(['--freeze', '--seed', '8', '--signals-version', '2', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(readFileSync(manifest, 'utf8')).toBe(text)
    // --refreeze of v2 only adds; v1 is untouched.
    expect(await main(['--refreeze', '--seed', '9', '--signals-version', '2', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(0)
    const g = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(g.sets['2'].missionIds).toEqual(expect.arrayContaining(f.sets['2'].missionIds))
    expect(g.sets['2'].version).toBe(2)
    expect(g.sets['1']).toEqual(v1)
    expect(g.history.map(h => h.how)).toEqual(['freeze', 'refreeze'])
    // No v3 set to add to; and on a per-version file, a bare --freeze targets v1 (exists: refused).
    expect(await main(['--refreeze', '--seed', '9', '--signals-version', '3', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(await main(['--freeze', '--seed', '9', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).sets['1']).toEqual(v1)
  })

  it('--refreeze without a manifest, and --freeze without a seed, refuse with exit 2', async () => {
    const dir = ledger()
    const manifest = join(mkdtempSync(join(tmpdir(), 'outcome-man-')), 'frozen-eval.json')
    expect(await main(['--refreeze', '--seed', '6', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(await main(['--freeze', '--ledger-dir', dir, '--manifest', manifest], capture())).toBe(2)
    expect(existsSync(manifest)).toBe(false)
  })

  it('the committed manifest has the frozen shape: schema 1, version 1, the recorded seed, 21 unique ids', async () => {
    const committed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'benchmark', 'cynco-ledger', 'frozen-eval.json'), 'utf8'))
    expect(Object.keys(committed).sort()).toEqual(['frozenAt', 'missionIds', 'schema', 'seed', 'version'])
    expect(committed).toMatchObject({ schema: 1, version: 1, seed: 20260926, frozenAt: '2026-09-26T18:59:02.676Z' })
    expect(committed.missionIds).toHaveLength(21)
    expect(new Set(committed.missionIds).size).toBe(21)
  })
})
