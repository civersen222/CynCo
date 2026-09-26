import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  featuresOf, datasetRows, frozenSplit, freezeManifest, FEATURE_KEYS, MIN_TURNS, main,
} from '../cynco-outcome-dataset.mjs'
import { labelOf } from '../cynco-signal-validation.mjs'

const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }

// One turn as the ledger writes it (keys copied from a real row), every signal
// carrying the turn index so "which turns went in" is readable off the value.
const turn = (i, over = {}) => ({
  t: 1000 + i, health: 'healthy', s3s4Balance: 'balanced',
  toolSuccessRate: i / 10, stuckTurns: i, varietyRatio: i, varietyWindowed: i,
  taskError: i, errorTrend: 'flat', fingerprintAlarm: null, infoGain: i,
  progressRate: i, explorationState: 'healthy_exploration', varietyBalance: 'balanced',
  algedonicAlerts: i, axiomHealth: { holding: 1, total: 3, violations: Array.from({ length: i }, (_, k) => `v${k}`) },
  consecutiveUnstable: i, agreementRatio: 0, predictions: null, s4: null,
  heterarchy: { context: 'normal', commander: 'S3', shifted: false },
  brain: { tier: 'live', layerConvergence: null, toolEntropy: { mean: i, max: i * 2, spikeCount: 0 } },
  snapshot: null, ...over,
})

const row = (id, { label = 'fail', turns = 8, turnFn = turn, ...over } = {}) => ({
  missionId: id,
  outcome: label === 'success' ? 'landed' : 'failed',
  verified: label === 'unlabeled' ? null : label === 'success',
  mutationSweep: sweep,
  toolStats: { total: 999 }, durationS: 12345, exitReason: 'done', commits: 7,
  turns: Array.from({ length: turns }, (_, i) => turnFn(i)),
  ...over,
})

// The documented feature list (benchmark/cynco-ledger/README.md, "Outcome
// dataset"). Written out here, not derived, so adding a feature is a deliberate
// change to the doc and this list together.
const NUMERIC = ['toolSuccessRate', 'stuckTurns', 'varietyRatio', 'varietyWindowed', 'taskError', 'infoGain',
  'progressRate', 'algedonicAlerts', 'consecutiveUnstable', 'axiomViolations', 'toolEntropyMean', 'toolEntropyMax']
const DOCUMENTED = [
  ...NUMERIC.flatMap(n => [`${n}.mean`, `${n}.last`, `${n}.max`]),
  'brainPresent',
  'errorTrend.rising', 'errorTrend.flat', 'errorTrend.falling',
  'explorationState.healthy_exploration', 'explorationState.thrashing', 'explorationState.floundering',
  'health.healthy', 'health.warning', 'health.critical',
  's3s4Balance.balanced', 's3s4Balance.s3_dominant', 's3s4Balance.s4_dominant', 's3s4Balance.critical',
  'varietyBalance.balanced', 'varietyBalance.underload', 'varietyBalance.overload', 'varietyBalance.critical',
  'commander.S1', 'commander.S2', 'commander.S3', 'commander.S4', 'commander.S5',
]
const FORBIDDEN = ['verified', 'outcome', 'mutationSweep', 'toolStats', 'durationS', 'exitReason', 'commits',
  'identityGuard', 'regulatorFidelity', 'posiwidLive', 's5Decisions', 'invariants', 'routing', 'brainStats', 'ultrastable']

describe('featuresOf — prefix only', () => {
  it('fraction 0.5 of 8 turns reads turns 0–3 and nothing after', () => {
    const f = featuresOf(row('m1'), 0.5)
    expect(f).toMatchObject({ missionId: 'm1', fraction: 0.5, turnsInPrefix: 4, label: false, leakGuard: true })
    expect(f.features['stuckTurns.last']).toBe(3)
    expect(f.features['stuckTurns.max']).toBe(3)
    expect(f.features['stuckTurns.mean']).toBe(1.5)
    expect(f.features['axiomViolations.max']).toBe(3)
    expect(f.features['toolEntropyMax.max']).toBe(6)
    expect(f.features['toolEntropyMean.last']).toBe(3)
    expect(f.features.brainPresent).toBe(1)
  })

  it('one-hots come from the LAST prefix turn, never a later one', () => {
    const r = row('m2', { turnFn: (i) => turn(i, i === 3 ? { health: 'warning', heterarchy: { commander: 'S4' } }
      : i >= 4 ? { health: 'critical', errorTrend: 'rising', heterarchy: { commander: 'S5' } } : {}) })
    const f = featuresOf(r, 0.5).features
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
    const keys = Object.keys(featuresOf(r, 0.5).features)
    const hits = keys.filter(k => FORBIDDEN.some(n => k === n || k.startsWith(`${n}.`) || k.startsWith(n)))
    expect(hits).toEqual([])
    expect(keys.includes('toolStats.total')).toBe(false)
    expect([...keys].sort()).toEqual([...DOCUMENTED].sort())
    expect([...FEATURE_KEYS].sort()).toEqual([...DOCUMENTED].sort())
  })

  it('a prefix whose signal is null throughout reads null, not 0; no entropy → brainPresent 0', () => {
    const r = row('m4', { turnFn: (i) => turn(i, { stuckTurns: null, brain: { tier: 'off', toolEntropy: null },
      axiomHealth: null, errorTrend: null, heterarchy: null }) })
    const f = featuresOf(r, 0.5).features
    for (const k of ['stuckTurns', 'toolEntropyMean', 'toolEntropyMax', 'axiomViolations']) {
      expect(f[`${k}.mean`]).toBeNull()
      expect(f[`${k}.last`]).toBeNull()
      expect(f[`${k}.max`]).toBeNull()
    }
    expect(f.brainPresent).toBe(0)
    expect(f['errorTrend.flat'] + f['errorTrend.rising'] + f['errorTrend.falling']).toBe(0)
    expect(f['commander.S3']).toBe(0)
  })

  it('.last is the last non-null value in the prefix; nulls are skipped by mean', () => {
    const r = row('m5', { turnFn: (i) => turn(i, { taskError: i === 3 ? null : i }) })
    const f = featuresOf(r, 0.5).features
    expect(f['taskError.last']).toBe(2)
    expect(f['taskError.mean']).toBe(1)
  })

  it('label is labelOf(row), for every branch', () => {
    for (const r of [row('a', { label: 'success' }), row('b', { label: 'fail' }), row('c', { label: 'unlabeled' }),
      row('d', { label: 'success', mutationSweep: null })]) {
      expect(featuresOf(r, 0.5).label).toBe(labelOf(r))
    }
    expect(featuresOf(row('a', { label: 'success' }), 0.5).label).toBe(true)
  })

  it('the prefix is at least one turn, and a bad fraction throws', () => {
    expect(featuresOf(row('m6', { turns: 4 }), 0.1).turnsInPrefix).toBe(1)
    expect(() => featuresOf(row('m6'), 0)).toThrow(/fraction/)
    expect(() => featuresOf(row('m6'), 1.5)).toThrow(/fraction/)
  })
})

describe('datasetRows', () => {
  it('keeps labeled rows with at least MIN_TURNS turns and counts what it excluded', () => {
    expect(MIN_TURNS).toBe(4)
    const out = datasetRows([row('ok1'), row('ok2', { label: 'success', turns: 4 }), row('short', { turns: 3 }),
      row('unl', { label: 'unlabeled' }), row('unl-short', { label: 'unlabeled', turns: 1 })], 0.5)
    expect(out.rows.map(r => r.missionId)).toEqual(['ok1', 'ok2'])
    expect(out.excluded).toEqual({ unlabeled: 2, short: 1 })
    expect(out.rows[1].turnsInPrefix).toBe(2)
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
    // input order does not matter, only the seed does
    expect(freezeManifest(twenty().reverse(), { seed: 7, now }).missionIds).toEqual(m.missionIds)
    const others = [1, 2, 3, 4, 5].map(seed => freezeManifest(twenty(), { seed, now }).missionIds.join())
    expect(others.some(ids => ids !== m.missionIds.join())).toBe(true)
  })

  it('unlabeled and short rows are never held out', () => {
    const m = freezeManifest([...twenty(), ...Array.from({ length: 10 }, (_, i) => row(`u${i}`, { label: 'unlabeled' })),
      ...Array.from({ length: 10 }, (_, i) => row(`t${i}`, { turns: 2 }))], { seed: 7, now })
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
    // a refreeze over rows that shrank never drops an id either
    expect(freezeManifest(twenty().slice(0, 5), { seed: 3, previous: v1, now }).missionIds).toEqual(expect.arrayContaining(v1.missionIds))
  })

  it('refuses a seed that is not an integer', () => {
    expect(() => freezeManifest(twenty(), { seed: 'x', now })).toThrow(/seed/)
  })
})

describe('frozenSplit', () => {
  it('splits by manifest and reports manifest ids missing from the rows', () => {
    const rows = twenty()
    const split = frozenSplit(rows, { missionIds: ['f00', 's01', 'gone'] })
    expect(split.holdout.map(r => r.missionId)).toEqual(['f00', 's01'])
    expect(split.train).toHaveLength(18)
    expect(split.missing).toEqual(['gone'])
    expect(split.train.some(r => r.missionId === 'f00')).toBe(false)
  })
})

describe('CLI', () => {
  const ledger = () => {
    const dir = mkdtempSync(join(tmpdir(), 'outcome-ledger-'))
    writeFileSync(join(dir, 'missions.jsonl'), twenty().map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return dir
  }
  const quiet = { log: () => {}, error: () => {} }

  it('--export writes one JSONL row per labeled mission at the fraction', async () => {
    const dir = ledger()
    const out = join(mkdtempSync(join(tmpdir(), 'outcome-out-')), 'sub', 'ds.jsonl')
    expect(await main(['--export', '--ledger-dir', dir, '--fraction', '0.25', '--out', out], quiet)).toBe(0)
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(20)
    expect(lines[0]).toMatchObject({ fraction: 0.25, turnsInPrefix: 2, leakGuard: true })
  })

  it('--freeze writes the manifest and refuses when it exists; --refreeze adds', async () => {
    const dir = ledger()
    const manifest = join(mkdtempSync(join(tmpdir(), 'outcome-man-')), 'frozen-eval.json')
    expect(await main(['--freeze', '--seed', '5', '--ledger-dir', dir, '--manifest', manifest], quiet)).toBe(0)
    const v1 = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(v1.missionIds).toHaveLength(4)
    expect(await main(['--freeze', '--seed', '5', '--ledger-dir', dir, '--manifest', manifest], quiet)).toBe(2)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(v1)
    expect(await main(['--refreeze', '--seed', '6', '--ledger-dir', dir, '--manifest', manifest], quiet)).toBe(0)
    const v2 = JSON.parse(readFileSync(manifest, 'utf8'))
    expect(v2.version).toBe(2)
    expect(v2.missionIds).toEqual(expect.arrayContaining(v1.missionIds))
  })

  it('--refreeze without a manifest, and --freeze without a seed, refuse with exit 2', async () => {
    const dir = ledger()
    const manifest = join(mkdtempSync(join(tmpdir(), 'outcome-man-')), 'frozen-eval.json')
    expect(await main(['--refreeze', '--seed', '6', '--ledger-dir', dir, '--manifest', manifest], quiet)).toBe(2)
    expect(await main(['--freeze', '--ledger-dir', dir, '--manifest', manifest], quiet)).toBe(2)
    expect(existsSync(manifest)).toBe(false)
  })

  it('the committed manifest has the frozen shape: schema 1, version 1, the recorded seed, unique ids', async () => {
    const committed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'benchmark', 'cynco-ledger', 'frozen-eval.json'), 'utf8'))
    expect(Object.keys(committed).sort()).toEqual(['frozenAt', 'missionIds', 'schema', 'seed', 'version'])
    expect(committed).toMatchObject({ schema: 1, version: 1, seed: 20260926 })
    expect(new Set(committed.missionIds).size).toBe(committed.missionIds.length)
  })
})
