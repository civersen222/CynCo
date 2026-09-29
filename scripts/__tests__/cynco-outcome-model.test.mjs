// scripts/cynco-outcome-model.py — the first learner in the authority ladder
// (Phase 5 ruling 5). These run the REAL python through `runSync` (F155) on
// small committed fixtures under scripts/__tests__/fixtures/outcome/:
//
//   separable.jsonl — 60 rows at prefixTurns 16; `signal.mean` < 0.5 on every failure and > 0.5
//                     on every success, `noise.mean` unrelated, `gappy.last`
//                     null on every 7th row (imputed), `entropy.mean` null on
//                     every row (dropped and listed).
//   tiny.jsonl      — 5 rows: TOO FEW.
//   manifest.json   — 12 held-out ids, s00..s11 (6 failures, 6 successes).
//
// Every output goes to a temp dir; nothing here reads or writes ~/.cynco.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSync } from '../cynco-spawn.mjs'

const SCRIPT = fileURLToPath(new URL('../cynco-outcome-model.py', import.meta.url))
const FIX = fileURLToPath(new URL('./fixtures/outcome/', import.meta.url))
const SEPARABLE = join(FIX, 'separable.jsonl')
const TINY = join(FIX, 'tiny.jsonl')
const MANIFEST = join(FIX, 'manifest.json')
const TIMEOUT_MS = 120_000

const outDir = () => mkdtempSync(join(tmpdir(), 'outcome-model-'))
const run = (args) => runSync('python', [SCRIPT, ...args], { timeoutMs: TIMEOUT_MS })

describe('cynco-outcome-model.py', () => {
  it('trains both models on the training split and scores them on the 12 held-out ids only', () => {
    const out = join(outDir(), 'outcome-model.json')
    const r = run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out])
    expect(r.fault).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const m = JSON.parse(readFileSync(out, 'utf8'))
    expect(m).toMatchObject({ schema: 1, version: 1, prefixTurns: 16, nTrain: 48, nHoldout: 12, baseRate: 0.5, leakCheck: null, secondary: null, lengthFeature: null })
    expect(typeof m.trainedAt).toBe('string')
    // Feature keys come from the rows; the all-null column is dropped and named.
    expect(m.features).toEqual(['signal.mean', 'noise.mean', 'gappy.last'])
    expect(m.droppedFeatures).toEqual(['entropy.mean'])
    expect(m.droppedReasons).toEqual({ 'entropy.mean': 'all null' })
    for (const k of ['lr', 'gbt']) {
      const model = m.models[k]
      expect(model.predictions).toHaveLength(12)
      expect(model.predictions.map(p => p.missionId).sort()).toEqual(['s00', 's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09', 's10', 's11'])
      for (const p of model.predictions) expect(p.pFail).toBeGreaterThanOrEqual(0)
      expect(model.brier).toBeGreaterThanOrEqual(0)
      expect(model.auc).toBeGreaterThan(0.9)
    }
    expect(m.models.gbt.precision).toBeGreaterThanOrEqual(0.8)
    expect(m.models.lr.precision).toBeGreaterThanOrEqual(0.8)
    expect(m.models.lr.recall).toBeGreaterThanOrEqual(0.8)
  }, TIMEOUT_MS)

  it('keeps the version when a retrain predicts the same, and raises it when the predictions change', () => {
    const out = join(outDir(), 'outcome-model.json')
    expect(run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    expect(run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe(1)
    // A previous file whose predictions differ: the next write is version + 1.
    const prev = JSON.parse(readFileSync(out, 'utf8'))
    prev.version = 7
    prev.models.lr.predictions[0].pFail = 0.123456
    writeFileSync(out, JSON.stringify(prev), 'utf8')
    expect(run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe(8)
  }, TIMEOUT_MS)

  it('with --hindsight, writes the leak check: the same models on the 100 % rows, AUC prefix vs hindsight', () => {
    const out = join(outDir(), 'outcome-model.json')
    const r = run(['--dataset', SEPARABLE, '--hindsight', SEPARABLE, '--manifest', MANIFEST, '--out', out])
    expect(r.status, r.stderr).toBe(0)
    const m = JSON.parse(readFileSync(out, 'utf8'))
    for (const k of ['lr', 'gbt']) {
      expect(Object.keys(m.leakCheck[k]).sort()).toEqual(['aucHindsight', 'aucPrefix'])
      // Same rows on both sides here, so the two AUCs are the same number.
      expect(m.leakCheck[k].aucHindsight).toBeCloseTo(m.leakCheck[k].aucPrefix, 10)
    }
  }, TIMEOUT_MS)

  it('drops a column with one value on every measured training row, and names it constant', () => {
    const dir = outDir()
    const flat = join(dir, 'flat.jsonl')
    // `always16.last` is 16 everywhere (null on a few rows); `zero.max` is 0 on training rows, 1 on one held-out row.
    writeFileSync(flat, readFileSync(SEPARABLE, 'utf8').split('\n').filter(Boolean)
      .map((l, i) => { const r = JSON.parse(l); r.features['always16.last'] = i % 5 ? 16 : null; r.features['zero.max'] = r.missionId === 's03' ? 1 : 0; return JSON.stringify(r) }).join('\n') + '\n', 'utf8')
    const out = join(dir, 'outcome-model.json')
    expect(run(['--dataset', flat, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    const m = JSON.parse(readFileSync(out, 'utf8'))
    expect(m.features).toEqual(['signal.mean', 'noise.mean', 'gappy.last'])
    expect(m.droppedFeatures).toEqual(['entropy.mean', 'always16.last', 'zero.max'])
    expect(m.droppedReasons).toEqual({ 'entropy.mean': 'all null', 'always16.last': 'constant', 'zero.max': 'constant' })
  }, TIMEOUT_MS)

  it('names a length-carrying feature in lengthFeature (the fixed-K prefix is supposed to have none)', () => {
    const dir = outDir()
    const leaky = join(dir, 'leaky.jsonl')
    writeFileSync(leaky, readFileSync(SEPARABLE, 'utf8').split('\n').filter(Boolean)
      .map((l, i) => { const r = JSON.parse(l); r.features.turnsInPrefix = r.label ? 90 + i : 170 + i; return JSON.stringify(r) }).join('\n') + '\n', 'utf8')
    const out = join(dir, 'outcome-model.json')
    expect(run(['--dataset', leaky, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).lengthFeature).toBe('turnsInPrefix')
  }, TIMEOUT_MS)

  it('--dataset32 is scored the same way under `secondary`; its refusal is recorded, not fatal', () => {
    const out = join(outDir(), 'outcome-model.json')
    expect(run(['--dataset', SEPARABLE, '--dataset32', SEPARABLE, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    const m = JSON.parse(readFileSync(out, 'utf8'))
    expect(m.secondary).toMatchObject({ prefixTurns: 16, nTrain: 48, nHoldout: 12 })
    expect(m.secondary.models.gbt.predictions).toEqual(m.models.gbt.predictions)
    expect(run(['--dataset', SEPARABLE, '--dataset32', TINY, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).secondary).toEqual({ refusal: 'TOO FEW: train 0 < 30 or holdout 5 < 8' })
  }, TIMEOUT_MS)

  it('--signals-version N trains on version-N rows only and reports the other version under secondary (F165)', () => {
    const dir = outDir()
    const mixed = join(dir, 'mixed.jsonl')
    // The 60 separable rows are v1 (no signalsVersion). Six v2 rows are added,
    // two of them held out, with a feature that would separate nothing.
    const v2 = Array.from({ length: 6 }, (_, i) => JSON.stringify({ missionId: i < 2 ? `s0${i}` : `v2-${i}`, prefixTurns: 16, signalsVersion: 2,
      label: i % 2 === 0, features: { 'signal.mean': 0.5, 'algedonicAlertsTotal.rate': i }, leakGuard: true }))
    writeFileSync(mixed, readFileSync(SEPARABLE, 'utf8').trim() + '\n' + v2.join('\n') + '\n', 'utf8')
    const out = join(dir, 'outcome-model.json')
    const r = run(['--dataset', mixed, '--manifest', MANIFEST, '--out', out, '--signals-version', '1'])
    expect(r.status, r.stderr).toBe(0)
    const m = JSON.parse(readFileSync(out, 'utf8'))
    expect(m).toMatchObject({ signalsVersion: 1, nTrain: 48, nHoldout: 12 })
    expect(m.features).not.toContain('algedonicAlertsTotal.rate')
    expect(m.secondary).toEqual({ otherSignalsVersions: { 2: { eligible: 6, failures: 3, successes: 3, holdout: 2 } } })
    // Without the flag the file says so (null) and `secondary` is as before.
    expect(run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out]).status).toBe(0)
    const plain = JSON.parse(readFileSync(out, 'utf8'))
    expect(plain.signalsVersion).toBeNull()
    expect(plain.secondary).toBeNull()
    // v2 alone is six rows: refused, nothing about v1 leaks in.
    const r2 = run(['--dataset', mixed, '--manifest', MANIFEST, '--out', join(dir, 'v2.json'), '--signals-version', '2'])
    expect(r2.status).toBe(2)
    expect(r2.stdout).toMatch(/^TOO FEW: train 4 < 30 or holdout 2 < 8$/m)
  }, TIMEOUT_MS)

  it('exits 2 and says TOO FEW on 5 rows, writing nothing', () => {
    const out = join(outDir(), 'outcome-model.json')
    const r = run(['--dataset', TINY, '--manifest', MANIFEST, '--out', out])
    expect(r.fault).toBeNull()
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/^TOO FEW: train 0 < 30 or holdout 5 < 8$/m)
    expect(existsSync(out)).toBe(false)
  }, TIMEOUT_MS)

  it('honours --min-train / --min-holdout', () => {
    const out = join(outDir(), 'outcome-model.json')
    const r = run(['--dataset', SEPARABLE, '--manifest', MANIFEST, '--out', out, '--min-train', '49'])
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/^TOO FEW: train 48 < 49 or holdout 12 < 8$/m)
  }, TIMEOUT_MS)
})
