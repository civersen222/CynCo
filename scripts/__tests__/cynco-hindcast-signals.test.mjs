// F165 fix round 1 (review I1): the runner's hindcast trains on ONE signals
// version — the current one — and says how many eligible missions each
// version had. v1 rows (consecutiveUnstable = the turn index, algedonicAlerts
// cumulative) and v2 rows describe different instruments; a model fitted on
// both learns the era. Temp dirs only; the python run is the real script.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportOutcomeDatasets, runHindcast, hindcastOf, noEligibleFault, hindcastReady, HINDCAST_SIGNALS_VERSION,
  exportReadingDataset, readingReady, readingNotFrozenFault, runReadingHindcast } from '../cynco-hindcast.mjs'
import { manifestSets, heldSetFor, freezeManifest, rowsOfVersion, FREEZE_MIN_ELIGIBLE, AUTO_FREEZE_SEED } from '../cynco-outcome-dataset.mjs'
import { hindcastLine } from '../cynco-campaign-verdict.mjs'
import { main as ruleVerdictsMain } from '../cynco-rule-verdicts.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'hindcast-signals-'))
const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
const turns = (n, v) => Array.from({ length: n }, (_, i) => ({ toolSuccessRate: i % 2 ? 1 : 0.5, health: 'healthy',
  ...(v === 2 ? { signalsVersion: 2, algedonicAlertsTotal: i, consecutiveUnstable: i % 3 } : { consecutiveUnstable: i + 1 }) }))
const row = (missionId, v, ok) => ({ missionId, outcome: ok ? 'landed' : 'failed', verified: ok, mutationSweep: sweep, turns: turns(40, v) })
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
// A per-version manifest whose v2 set is `ids` (fix round 2).
const manifestIn = (d, ids) => { const p = join(d, 'frozen-eval.json'); writeFileSync(p, JSON.stringify({ schema: 2, sets: { 2: { schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ids } }, history: [] })); return p }
// Phase 5's shape: the file that IS v1's set.
const V1_SET = { schema: 1, version: 1, seed: 20260926, frozenAt: '2026-09-26T18:59:02.676Z', missionIds: ['v1-0', 'v1-1', 'v1-2'] }
const v1Manifest = (d) => { const p = join(d, 'frozen-eval.json'); writeFileSync(p, JSON.stringify(V1_SET, null, 2) + '\n'); return p }

describe('the hindcast trains on one signals version (F165)', () => {
  it('the current version is 2', () => {
    expect(HINDCAST_SIGNALS_VERSION).toBe(2)
  })

  it('a ledger with v1 and v2 rows: every dataset holds v2 rows only, and both counts are recorded', () => {
    const d = dir()
    const rows = [row('a1', 1, false), row('a2', 1, true), row('a3', 1, false), row('b1', 2, false), row('b2', 2, true)]
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: manifestIn(d, ['a1', 'b1']) })
    expect(r).toMatchObject({ n: 2, n32: 2, nHindsight: 2, signalsVersion: 2, rowsByVersion: { 1: 3, 2: 2 } })
    expect(r.excluded).toEqual({ unlabeled: 0, short: 0, otherVersion: 3 })
    for (const p of [r.paths.dataset, r.paths.dataset32, r.paths.hindsight]) {
      expect(readJsonl(p).map(x => [x.missionId, x.signalsVersion])).toEqual([['b1', 2], ['b2', 2]])
    }
    // The held-out v1 mission is named as another version, never as missing.
    expect(r.split[16]).toEqual({ train: 1, holdout: 1, ineligible: [], missing: [], otherVersion: ['a1'] })
    // The model is told the version and the counts.
    const calls = []
    runHindcast({ paths: r.paths, run: (cmd, args) => { calls.push(args); return { status: 0 } } })
    const args = calls[0]
    expect(args[args.indexOf('--signals-version') + 1]).toBe('2')
    expect(JSON.parse(args[args.indexOf('--rows-by-version') + 1])).toEqual({ 1: 3, 2: 2 })
  })

  it('a frozen v2 set but too few v2 rows: the real model refuses, and the unmeasured reading names each version\'s count', () => {
    const d = dir()
    const rows = [...Array.from({ length: 40 }, (_, i) => row(`v1-${i}`, 1, i % 2 === 0)), row('b1', 2, false), row('b2', 2, true)]
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: manifestIn(d, ['b1']) })
    expect(r.rowsByVersion).toEqual({ 1: 40, 2: 2 })
    const h = hindcastOf(runHindcast({ paths: r.paths }), r.paths.out)
    expect(h).toEqual({ fault: 'exit 2: TOO FEW: train 1 < 30 or holdout 1 < 8 (signals v2: 2 eligible; v1: 40)' })
    expect(existsSync(r.paths.out)).toBe(false)
  }, 120_000)

  it('zero v2 rows: nothing to train on — n is 0 with every v1 row counted, and the model says so if run', () => {
    const d = dir()
    const rows = Array.from({ length: 6 }, (_, i) => row(`v1-${i}`, 1, i % 2 === 0))
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: manifestIn(d, []) })
    expect(r).toMatchObject({ n: 0, n32: 0, nHindsight: 0, rowsByVersion: { 1: 6 } })
    expect(readFileSync(r.paths.dataset, 'utf8')).toBe('')
    const h = hindcastOf(runHindcast({ paths: r.paths }), r.paths.out)
    expect(h).toEqual({ fault: 'exit 2: TOO FEW: train 0 < 30 or holdout 0 < 8 (signals v2: 0 eligible; v1: 6)' })
    // The runner never spawns python on n = 0; its reading names the version.
    expect(noEligibleFault(r)).toBe('no eligible labeled mission at K = 16 turns with signals v2 (eligible by version: v1: 6) — nothing to train on')
    expect(noEligibleFault({ n: 0, paths: {} })).toBe('no eligible labeled mission at K = 16 turns — nothing to train on')
  }, 120_000)

  it('the --with-hindcast CLI on a v1-only ledger prints UNMEASURED with the version reason', async () => {
    const d = dir()
    const rows = Array.from({ length: 4 }, (_, i) => row(`v1-${i}`, 1, i % 2 === 0))
    const lines = []
    await ruleVerdictsMain(['--with-hindcast', '--datasets-dir', d], {
      readLedger: () => rows, cyncoHome: () => d, log: (s) => lines.push(s),
      runHindcast: () => { throw new Error('python must not be spawned with no v2 row') },
    })
    // The CLI builds the runner row as the VERDICT does (Task 4 review I1): the
    // temp home has no campaigns, so R1.no-progress (and, Phase 7, R2.stalled)
    // is UNMEASURED on the line.
    expect(lines[0]).toBe('- Outcome hindcast: UNMEASURED — no eligible labeled mission at K = 16 turns with signals v2 (eligible by version: v1: 4) — nothing to train on'
      + '; R1.no-progress precision null on 0 fired p(Holm) null UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)'
      + '; R2.stalled precision null on 0 fired p(Holm) null UNMEASURED — no wave in scope (no shadow decision at 25 % of its clock or later)'
      // Phase 7 ruling 1: no waves, so no readings — the reading learner says how far off its holdout is.
      + '; readings: UNMEASURED — reading holdout not yet frozen (0 of 38 labeled; improved 0 / stalled 0; need 8 of each)')
  })
})

describe('the holdout is per signals version and freezes itself once (F165 fix round 2)', () => {
  const now = (t) => () => t
  const ledger = (nV2) => [...Array.from({ length: 3 }, (_, i) => row(`v1-${i}`, 1, i % 2 === 0)),
    ...Array.from({ length: nV2 }, (_, i) => row(`v2-${String(i).padStart(2, '0')}`, 2, i % 3 !== 0))]

  it('the Phase 5 (schema-1) file loads as version 1\'s set, verbatim; no file is empty; anything else throws', () => {
    expect(manifestSets(V1_SET)).toEqual({ schema: 2, sets: { 1: V1_SET }, history: [] })
    expect(heldSetFor(manifestSets(V1_SET), 1)).toBe(V1_SET)
    expect(heldSetFor(manifestSets(V1_SET), 2)).toBeNull()
    expect(manifestSets(null)).toEqual({ schema: 2, sets: {}, history: [] })
    expect(() => manifestSets({ schema: 9 })).toThrow(/not a frozen-eval manifest/)
    expect(FREEZE_MIN_ELIGIBLE).toBe(38)
  })

  it('a v2 pool below the minimum: "not yet frozen" with the counts, python not spawned, the file untouched', () => {
    const d = dir()
    const path = v1Manifest(d)
    const before = readFileSync(path, 'utf8')
    const r = exportOutcomeDatasets({ rows: ledger(37), home: null, datasetsDir: d, manifestPath: path })
    expect(r.n).toBe(37)
    expect(r.holdout).toEqual({ frozen: false, eligible: 37, needed: 38 })
    expect(hindcastReady(r)).toBe(false)
    expect(noEligibleFault(r)).toBe('v2 holdout not yet frozen (37 of 38 labeled; eligible by version: v1: 3, v2: 37)')
    expect(r.split[16]).toMatchObject({ holdout: 0, train: 37 })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('a v2 pool at the minimum: v2\'s set is frozen once with Phase 5\'s rule; a second run changes nothing; v1\'s ids never move', () => {
    const d = dir()
    const path = v1Manifest(d)
    const rows = ledger(38)
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: path, now: now('2026-10-01T00:00:00.000Z') })
    const expected = freezeManifest(rowsOfVersion(rows, 2, 16), { seed: AUTO_FREEZE_SEED, turns: 16, now: now('2026-10-01T00:00:00.000Z') })
    expect(expected.missionIds).toHaveLength(8)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.schema).toBe(2)
    expect(file.sets['1']).toEqual(V1_SET)
    expect(file.sets['2']).toEqual(expected)
    expect(file.history).toEqual([{ signalsVersion: 2, frozenAt: '2026-10-01T00:00:00.000Z', count: 8, eligible: 38, seed: AUTO_FREEZE_SEED, how: 'auto' }])
    expect(r.holdout).toEqual({ frozen: true, frozenNow: true, frozenAt: '2026-10-01T00:00:00.000Z', ids: 8 })
    expect(hindcastReady(r)).toBe(true)
    expect(r.split[16]).toMatchObject({ holdout: 8, train: 30 })
    // The model reads the same eight ids from the per-version file.
    const calls = []
    runHindcast({ paths: r.paths, run: (cmd, args) => { calls.push(args); return { status: 0 } } })
    expect(calls[0][calls[0].indexOf('--manifest') + 1]).toBe(path)
    // Frozen means frozen: a later, larger ledger leaves the file as it was.
    const text = readFileSync(path, 'utf8')
    const again = exportOutcomeDatasets({ rows: ledger(60), home: null, datasetsDir: d, manifestPath: path, now: now('2026-11-01T00:00:00.000Z') })
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(again.holdout).toEqual({ frozen: true, frozenNow: false, frozenAt: '2026-10-01T00:00:00.000Z', ids: 8 })
    expect(again.split[16]).toMatchObject({ holdout: 8, train: 52 })
  })

  // Task 2 review N4: a holdout frozen from a one-class pool can never give an
  // AUC, and a frozen set only grows by hand — so the freeze waits for
  // MODEL_MIN_HOLDOUT (8) of EACH label in the eligible pool.
  it('a 38-mission all-fail v2 pool is not frozen: "pass 0 / fail 38; need 8 of each", the file untouched', () => {
    const d = dir()
    const path = v1Manifest(d)
    const before = readFileSync(path, 'utf8')
    const rows = Array.from({ length: 38 }, (_, i) => row(`v2-${String(i).padStart(2, '0')}`, 2, false))
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: path })
    expect(r.holdout).toEqual({ frozen: false, eligible: 38, needed: 38, pass: 0, fail: 38, needEach: 8 })
    expect(hindcastReady(r)).toBe(false)
    expect(noEligibleFault(r)).toBe('v2 holdout not yet frozen (pass 0 / fail 38; need 8 of each; eligible by version: v2: 38)')
    expect(readFileSync(path, 'utf8')).toBe(before)
    // Seven of one label is still one short; eight of each freezes.
    const seven = Array.from({ length: 38 }, (_, i) => row(`v2-${String(i).padStart(2, '0')}`, 2, i < 7))
    expect(exportOutcomeDatasets({ rows: seven, home: null, datasetsDir: d, manifestPath: path }).holdout).toMatchObject({ frozen: false, pass: 7, fail: 31 })
    const eight = Array.from({ length: 38 }, (_, i) => row(`v2-${String(i).padStart(2, '0')}`, 2, i < 8))
    expect(exportOutcomeDatasets({ rows: eight, home: null, datasetsDir: d, manifestPath: path }).holdout).toMatchObject({ frozen: true, frozenNow: true, ids: 8 })
  })

  it('the model trains on v2\'s frozen set from the per-version file (real python)', () => {
    const d = dir()
    const path = v1Manifest(d)
    // v2 rows whose one varying signal separates the labels.
    const sep = (id, ok) => ({ ...row(id, 2, ok), turns: Array.from({ length: 20 }, () => ({ signalsVersion: 2, toolSuccessRate: ok ? 0.9 : 0.2, health: 'healthy' })) })
    const rows = Array.from({ length: 40 }, (_, i) => sep(`v2-${String(i).padStart(2, '0')}`, i % 2 === 0))
    const r = exportOutcomeDatasets({ rows, home: null, datasetsDir: d, manifestPath: path })
    const h = hindcastOf(runHindcast({ paths: r.paths }), r.paths.out)
    expect(h.fault).toBeUndefined()
    expect(h.summary).toMatchObject({ signalsVersion: 2, nHoldout: 8, nTrain: 32, rowsByVersion: { 2: 40 } })
  }, 120_000)
})

// Phase 7 ruling 1: the reading unit — one labeled sample per inter-tick
// interval — through the same export → freeze → model path, its holdout the
// set `reading:2`, frozen once by the same rule.
describe('the reading unit through the hindcast (Phase 7 ruling 1)', () => {
  const T0 = Date.parse('2026-10-01T00:00:00.000Z')
  const iso = (ms) => new Date(ms).toISOString()
  // One mission whose wave has one interval per label in `labels`: five v2
  // turns per interval, toolSuccessRate 0.9 on an improved one and 0.2 on a
  // stalled one (so the real model can separate them), a tick between each.
  const mission = (id, labels) => {
    const turns = labels.flatMap((l, j) => Array.from({ length: 5 }, (_, i) => ({ t: T0 + (j * 5 + i) * 1000, signalsVersion: 2, health: 'healthy', toolSuccessRate: l === 'improved' ? 0.9 : 0.2 })))
    let fails = 100
    const ticks = [{ at: iso(T0 - 500), fails, elapsedFraction: 0 }]
    labels.forEach((l, j) => { if (l === 'improved') fails -= 1; ticks.push({ at: iso(T0 + 5000 * (j + 1) - 500), fails, elapsedFraction: (j + 1) / labels.length }) })
    return { row: { missionId: id, outcome: 'landed', verified: true, mutationSweep: sweep, turns }, wave: { missionId: id, wave: 1, shadowDecisions: ticks } }
  }
  const pool = (n, labels) => {
    const ms = Array.from({ length: n }, (_, i) => mission(`r${String(i).padStart(2, '0')}`, labels(i)))
    return { rows: ms.map(m => m.row), waves: ms.map(m => m.wave) }
  }
  // A per-version file with mission sets "1" and "2" already frozen.
  const SET_1 = { schema: 1, version: 1, seed: 20260926, frozenAt: 't1', missionIds: ['v1-a'] }
  const SET_2 = { schema: 1, version: 1, seed: AUTO_FREEZE_SEED, frozenAt: 't2', missionIds: ['v2-a'] }
  const perVersion = (d) => { const p = join(d, 'frozen-eval.json'); writeFileSync(p, JSON.stringify({ schema: 2, sets: { 1: SET_1, 2: SET_2 }, history: [] }, null, 2) + '\n'); return p }
  const noPython = () => { throw new Error('python must not be spawned before the reading holdout is frozen') }

  it('below the minimum: "reading holdout not yet frozen (n of 38 labeled; improved a / stalled b; need 8 of each)", no python, the file untouched', () => {
    const d = dir()
    const path = perVersion(d)
    const before = readFileSync(path, 'utf8')
    const { rows, waves } = pool(12, (i) => (i % 2 ? ['improved', 'stalled', 'improved'] : ['stalled', 'improved', 'stalled']))
    const exp = exportReadingDataset({ rows, waves, home: null, datasetsDir: d, manifestPath: path })
    expect(exp).toMatchObject({ n: 36, waves: 12, signalsVersion: 2, rowsByVersion: { 2: 36 } })
    expect(exp.paths).toMatchObject({ dataset: join(d, 'outcome-dataset-intervals.jsonl'), out: join(d, 'outcome-model.json'), manifest: path, unit: 'reading', signalsVersion: 2 })
    expect(readJsonl(exp.paths.dataset)).toHaveLength(36)
    expect(readingReady(exp)).toBe(false)
    expect(readingNotFrozenFault(exp)).toBe('reading holdout not yet frozen (36 of 38 labeled; improved 18 / stalled 18; need 8 of each)')
    const { reading, model } = runReadingHindcast({ exported: exp, runHindcast: noPython })
    expect(model).toBeNull()
    expect(reading).toEqual({ fault: 'reading holdout not yet frozen (36 of 38 labeled; improved 18 / stalled 18; need 8 of each)', signalsVersion: 2, rowsByVersion: { 2: 36 },
      holdout: { frozen: false, unit: 'reading', eligible: 36, needed: 38, improved: 18, stalled: 18, needEach: 8 }, waves: 12, excluded: exp.excluded })
    expect(readFileSync(path, 'utf8')).toBe(before)
    // No readings at all reads the same way, never as an empty success.
    const none = exportReadingDataset({ rows: [], waves: [], home: null, datasetsDir: d, manifestPath: path })
    expect(readingNotFrozenFault(none)).toBe('reading holdout not yet frozen (0 of 38 labeled; improved 0 / stalled 0; need 8 of each)')
  })

  it('at the minimum: frozen once under sets["reading:2"], "1" and "2" byte-identical, the model run with --unit reading', () => {
    const d = dir()
    const path = perVersion(d)
    const setText = (k) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).sets[k], null, 2)
    const before = { 1: setText('1'), 2: setText('2') }
    const { rows, waves } = pool(19, (i) => (i % 2 ? ['improved', 'stalled'] : ['stalled', 'improved']))
    const exp = exportReadingDataset({ rows, waves, home: null, datasetsDir: d, manifestPath: path, now: () => '2026-10-02T00:00:00.000Z' })
    expect(exp.n).toBe(FREEZE_MIN_ELIGIBLE)
    expect(exp.holdout).toMatchObject({ frozen: true, frozenNow: true, frozenAt: '2026-10-02T00:00:00.000Z' })
    expect(readingReady(exp)).toBe(true)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.sets['reading:2']).toMatchObject({ unit: 'reading', seed: AUTO_FREEZE_SEED })
    expect(file.sets['reading:2'].ids).toHaveLength(exp.holdout.ids)
    expect(setText('1')).toBe(before[1])
    expect(setText('2')).toBe(before[2])
    expect(file.history).toEqual([expect.objectContaining({ signalsVersion: 2, unit: 'reading', how: 'auto', eligible: 38 })])
    const calls = []
    runHindcast({ paths: exp.paths, run: (cmd, args) => { calls.push(args); return { status: 0 } } })
    const args = calls[0]
    expect(args[args.indexOf('--unit') + 1]).toBe('reading')
    expect(args[args.indexOf('--dataset') + 1]).toBe(exp.paths.dataset)
    expect(args[args.indexOf('--manifest') + 1]).toBe(path)
    expect(args[args.indexOf('--signals-version') + 1]).toBe('2')
    expect(args).not.toContain('--hindsight')
    expect(args).not.toContain('--dataset32')
    // A second export: frozen means frozen.
    const text = readFileSync(path, 'utf8')
    expect(exportReadingDataset({ rows, waves, home: null, datasetsDir: d, manifestPath: path }).holdout).toMatchObject({ frozen: true, frozenNow: false })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('the real model on a frozen reading set: `reading` beside the mission model, every interval of a held mission held', () => {
    const d = dir()
    const path = perVersion(d)
    const { rows, waves } = pool(30, (i) => (i % 2 ? ['improved', 'stalled'] : ['stalled', 'improved']))
    const exp = exportReadingDataset({ rows, waves, home: null, datasetsDir: d, manifestPath: path })
    const { reading, model } = runReadingHindcast({ exported: exp })
    expect(reading.fault).toBeUndefined()
    const held = JSON.parse(readFileSync(path, 'utf8')).sets['reading:2']
    expect(reading).toMatchObject({ unit: 'reading', signalsVersion: 2, nHoldout: held.ids.length, nTrain: 60 - held.ids.length, rowsByVersion: { 2: 60 }, holdout: { frozen: true, frozenNow: true } })
    for (const k of ['gbt', 'lr']) {
      expect(model.models[k].predictions.map(p => p.id).sort()).toEqual([...held.ids].sort())
      expect(reading.models[k].auc).toBeGreaterThan(0.9)
    }
    expect(JSON.parse(readFileSync(exp.paths.out, 'utf8')).reading.models.gbt.predictions).toEqual(model.models.gbt.predictions)
  }, 120_000)

  it('a model that exits 0 without a reading block is a fault, never a stale reading', () => {
    const d = dir()
    const out = join(d, 'outcome-model.json')
    writeFileSync(out, JSON.stringify({ schema: 1, version: 2, models: {} }))
    expect(hindcastOf({ status: 0 }, out, undefined, { unit: 'reading' })).toEqual({ fault: `exit 0 but no reading block in ${out}` })
  })
})

describe('the verdict entry names the version and the counts (F165)', () => {
  const h = { version: 5, prefixTurns: 16, nHoldout: 9, baseRate: 0.5, lengthFeature: null, ladder: {}, leakCheck: null, secondary: null }

  it('a model fitted on one version says which, with every version\'s eligible count', () => {
    expect(hindcastLine({ ...h, signalsVersion: 2, rowsByVersion: { 2: 40, 1: 104 } }))
      .toBe('- Outcome hindcast: v5 at K = 16 turns, signals v2 only (eligible v1 104, v2 40) on 9 held-out missions (base 50%): no ladder reading; leak check not run')
  })

  // Task 2 review N3: the one irreversible act of this machinery is named on
  // the wave that did it, and only there.
  it('the wave whose export froze the holdout says so; a later wave does not', () => {
    const base = { ...h, signalsVersion: 2, rowsByVersion: { 2: 40 } }
    expect(hindcastLine({ ...base, holdout: { frozen: true, frozenNow: true, frozenAt: 't', ids: 8 } }))
      .toBe('- Outcome hindcast: v5 at K = 16 turns, signals v2 only (eligible v2 40) on 9 held-out missions (base 50%): no ladder reading; leak check not run; v2 holdout frozen now (8 ids)')
    expect(hindcastLine({ ...base, holdout: { frozen: true, frozenNow: false, frozenAt: 't', ids: 8 } }))
      .toBe('- Outcome hindcast: v5 at K = 16 turns, signals v2 only (eligible v2 40) on 9 held-out missions (base 50%): no ladder reading; leak check not run')
  })

  it('a model written before F165 reads as before', () => {
    expect(hindcastLine(h)).toBe('- Outcome hindcast: v5 at K = 16 turns on 9 held-out missions (base 50%): no ladder reading; leak check not run')
  })

  // Phase 7 ruling 1: the reading unit is reported beside the mission unit,
  // in the same grammar, after the mission learner's clause.
  describe('; readings:', () => {
    const notFrozen = 'reading holdout not yet frozen (36 of 38 labeled; improved 18 / stalled 18; need 8 of each)'
    const R1 = { verdict: 'UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)', precision: null, n: 0, pAdjusted: null, ci: null }
    const reading = { version: 2, unit: 'reading', signalsVersion: 2, rowsByVersion: { 2: 60 }, nHoldout: 12, baseRate: 0.5, leakCheck: null, secondary: null, droppedFeatures: ['a'],
      ladder: { 'M2.lr': { verdict: 'TOO FEW — cannot tell', precision: null, n: 0, pAdjusted: null, ci: [0, 1] },
        'M2.gbt': { verdict: 'NO EVIDENCE', precision: 0.8, n: 5, pAdjusted: 0.5, ci: [0.375, 0.964] } } }

    it('an unfrozen reading holdout: UNMEASURED with the counts, after the mission clause', () => {
      expect(hindcastLine({ ...h, signalsVersion: 2, rowsByVersion: { 2: 40 }, reading: { fault: notFrozen } }))
        .toBe(`- Outcome hindcast: v5 at K = 16 turns, signals v2 only (eligible v2 40) on 9 held-out missions (base 50%): no ladder reading; leak check not run; readings: UNMEASURED — ${notFrozen}`)
      expect(hindcastLine({ fault: 'v2 holdout not yet frozen (5 of 38 labeled; eligible by version: v2: 5)', reading: { fault: notFrozen } }, { runners: { 'R1.no-progress': R1 } }))
        .toBe(`- Outcome hindcast: UNMEASURED — v2 holdout not yet frozen (5 of 38 labeled; eligible by version: v2: 5); R1.no-progress precision null on 0 fired p(Holm) null ${R1.verdict}; readings: UNMEASURED — ${notFrozen}`)
    })

    it('a trained reading learner: its M2 rungs in the mission grammar; the freeze named on the wave that did it', () => {
      expect(hindcastLine({ ...h, reading }))
        .toBe('- Outcome hindcast: v5 at K = 16 turns on 9 held-out missions (base 50%): no ladder reading; leak check not run'
          + '; readings: v2 per interval, signals v2 only (eligible v2 60) on 12 held-out readings (base 50%): M2.gbt precision 80% [38, 96] on 5 fired p(Holm) 0.500 NO EVIDENCE; M2.lr precision null on 0 fired p(Holm) null TOO FEW; leak check not run; dropped 1 dead column(s)')
      expect(hindcastLine({ ...h, reading: { ...reading, ladder: null, holdout: { frozen: true, frozenNow: true, ids: 12, missions: 6 } } }, { detail: true }))
        .toMatch(/; readings: v2 per interval, .*: no ladder reading; leak check not run; dropped 1 dead column\(s\): a; reading:2 holdout frozen now \(12 readings of 6 missions\)$/)
    })

    it('a record without a reading block (before Phase 7) prints no readings clause', () => {
      expect(hindcastLine(h)).not.toMatch(/readings/)
    })
  })
})
