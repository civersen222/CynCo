// scripts/cynco-hindcast.mjs — the export, the capped python call and the
// reading of its result that the runner's VERDICT seams wrap. Temp homes only.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { exportOutcomeDatasets, runHindcast, hindcastOf, hindcastSummary, HINDCAST_PATHS, hindcastPathsIn, HINDCAST_TIMEOUT_MS, OUTCOME_MODEL_SCRIPT } from '../cynco-hindcast.mjs'
import { featuresOf, DATASET_PATH, MANIFEST_PATH } from '../cynco-outcome-dataset.mjs'
import { OUTCOME_MODEL_PATH } from '../cynco-rule-verdicts.mjs'
import { hindcastLine } from '../cynco-campaign-verdict.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'hindcast-'))
const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
const turns = (n) => Array.from({ length: n }, (_, i) => ({ toolSuccessRate: i % 2 ? 1 : 0.5, stuckTurns: i % 3, health: 'healthy' }))
const row = (missionId, n, ok) => ({ missionId, outcome: ok ? 'landed' : 'failed', verified: ok, mutationSweep: sweep, turns: turns(n) })
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

describe('exportOutcomeDatasets', () => {
  it('writes K = 16, K = 32 and the all-turns hindsight rows for the K = 16-eligible missions', () => {
    const h = home()
    const rows = [row('long', 40, false), row('mid', 20, true), row('short', 10, true), { missionId: 'unlabeled', verified: null, turns: turns(50) }]
    const manifestPath = join(h, 'frozen-eval.json')
    writeFileSync(manifestPath, JSON.stringify({ schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ['long', 'short', 'ghost'] }))
    const r = exportOutcomeDatasets({ rows, home: h, manifestPath })
    expect(r).toMatchObject({ n: 2, n32: 1, nHindsight: 2 })
    expect(r.paths).toEqual({ ...HINDCAST_PATHS(h), manifest: manifestPath })
    // frozenSplit with `turns`: a held-out mission too short at K is named, an unknown id is missing.
    expect(r.split).toEqual({
      16: { train: 1, holdout: 1, ineligible: ['short'], missing: ['ghost'] },
      32: { train: 0, holdout: 1, ineligible: ['short'], missing: ['ghost'] },
    })
    expect(r.paths.dataset).toBe(DATASET_PATH(h))
    expect(r.paths.out).toBe(OUTCOME_MODEL_PATH(h))
    expect(readJsonl(r.paths.dataset).map(x => [x.missionId, x.prefixTurns])).toEqual([['long', 16], ['mid', 16]])
    expect(readJsonl(r.paths.dataset32).map(x => [x.missionId, x.prefixTurns])).toEqual([['long', 32]])
    const hs = readJsonl(r.paths.hindsight)
    expect(hs.map(x => [x.missionId, x.prefixTurns])).toEqual([['long', 40], ['mid', 20]])
    expect(hs[0]).toEqual(featuresOf(rows[0], 40))
  })

  it('`datasetsDir` puts the files directly in that dir; HINDCAST_PATHS(home) is hindcastPathsIn(<home>/datasets)', () => {
    const h = home()
    expect(HINDCAST_PATHS(h)).toEqual(hindcastPathsIn(join(h, 'datasets')))
    const dir = join(home(), 'elsewhere')
    const r = exportOutcomeDatasets({ rows: [row('long', 40, false)], home: null, datasetsDir: dir, manifestPath: MANIFEST_PATH })
    expect(r.paths).toEqual({ ...hindcastPathsIn(dir), manifest: MANIFEST_PATH })
    expect(readJsonl(join(dir, 'outcome-dataset.jsonl')).map(x => x.missionId)).toEqual(['long'])
  })

  it('an empty ledger writes empty files and n = 0 (the committed manifest by default)', () => {
    const r = exportOutcomeDatasets({ rows: [], home: home() })
    expect(r).toMatchObject({ n: 0, n32: 0, nHindsight: 0 })
    expect(r.paths.manifest).toBe(MANIFEST_PATH)
    expect(r.split[16]).toMatchObject({ train: 0, holdout: 0, ineligible: [] })
    expect(r.split[16].missing).toHaveLength(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).missionIds.length)
    expect(readFileSync(r.paths.dataset, 'utf8')).toBe('')
  })
})

describe('runHindcast', () => {
  it('calls python on the model script with every path, the frozen manifest and a 300 s cap', () => {
    const calls = []
    const paths = HINDCAST_PATHS('H')
    const res = runHindcast({ paths, run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 } } })
    expect(res).toEqual({ status: 0 })
    expect(calls).toEqual([{ cmd: 'python', args: [OUTCOME_MODEL_SCRIPT, '--dataset', paths.dataset, '--dataset32', paths.dataset32, '--hindsight', paths.hindsight,
      '--manifest', MANIFEST_PATH, '--out', paths.out], opts: { timeoutMs: HINDCAST_TIMEOUT_MS } }])
    expect(HINDCAST_TIMEOUT_MS).toBe(300_000)
  })

  it('uses the manifest the export read', () => {
    const calls = []
    runHindcast({ paths: { ...HINDCAST_PATHS('H'), manifest: 'M.json' }, run: (cmd, args) => { calls.push(args); return { status: 0 } } })
    expect(calls[0][calls[0].indexOf('--manifest') + 1]).toBe('M.json')
  })
})

describe('hindcastOf', () => {
  const model = { schema: 1, version: 2, trainedAt: 't', prefixTurns: 16, nTrain: 83, nHoldout: 21, baseRate: 12 / 21, features: ['a', 'b', 'c'], droppedFeatures: ['z'], lengthFeature: null,
    models: { lr: { precision: 0.5, recall: 0.25, brier: 0.3, auc: 0.55, predictions: [] }, gbt: { precision: null, recall: 0, brier: 0.26, auc: null, predictions: [] } },
    leakCheck: { lr: { aucPrefix: 0.55, aucHindsight: 0.9 }, gbt: { aucPrefix: null, aucHindsight: 0.8 } }, secondary: null }

  it('reads the model back on exit 0 and keeps the metrics, not the predictions', () => {
    const p = join(home(), 'm.json')
    writeFileSync(p, JSON.stringify(model))
    const r = hindcastOf({ status: 0, stdout: '', stderr: '', fault: null }, p)
    expect(r.model).toEqual(model)
    expect(r.summary).toEqual({ version: 2, trainedAt: 't', prefixTurns: 16, nTrain: 83, nHoldout: 21, baseRate: 12 / 21, features: 3, droppedFeatures: ['z'], droppedReasons: {}, lengthFeature: null,
      models: { gbt: { precision: null, recall: 0, brier: 0.26, auc: null }, lr: { precision: 0.5, recall: 0.25, brier: 0.3, auc: 0.55 } },
      leakCheck: model.leakCheck, secondary: null })
  })

  it('every other outcome is a named fault', () => {
    expect(hindcastOf({ fault: { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', elapsedMs: 7 } }, 'x'))
      .toEqual({ fault: 'the hindcast did not run (code ETIMEDOUT, status null, signal SIGTERM, after 7 ms)' })
    expect(hindcastOf({ timedOut: true, elapsedMs: 300_001, status: null }, 'x')).toEqual({ fault: 'the hindcast timed out after 300001 ms' })
    expect(hindcastOf({ status: 2, stdout: 'TOO FEW: train 3 < 30 or holdout 1 < 8\n', stderr: '' }, 'x')).toEqual({ fault: 'exit 2: TOO FEW: train 3 < 30 or holdout 1 < 8' })
    expect(hindcastOf({ status: 1, stdout: '', stderr: '' }, 'x')).toEqual({ fault: 'exit 1: no output' })
    expect(hindcastOf({ status: 0, stdout: '', stderr: '' }, join(home(), 'absent.json'))).toMatchObject({ fault: expect.stringMatching(/^exit 0 but no model at /) })
  })

  it('a secondary refusal is kept as the refusal', () => {
    expect(hindcastSummary({ ...model, secondary: { refusal: 'TOO FEW: x' } }).secondary).toEqual({ refusal: 'TOO FEW: x' })
  })
})

describe('hindcastLine', () => {
  it('null is no line; a fault is UNMEASURED with its reason', () => {
    expect(hindcastLine(null)).toBeNull()
    expect(hindcastLine({ fault: 'exit 2: TOO FEW: train 3 < 30 or holdout 1 < 8' })).toBe('- Outcome hindcast: UNMEASURED — exit 2: TOO FEW: train 3 < 30 or holdout 1 < 8')
  })

  it('prints the ladder reading per model, the leak check and the K = 32 point', () => {
    const line = hindcastLine({ version: 3, prefixTurns: 16, nHoldout: 21, baseRate: 12 / 21, lengthFeature: null,
      ladder: { 'M1.lr': { verdict: 'NO EVIDENCE', precision: 0.5, ci: [0.2, 0.8], n: 8, pAdjusted: 1 }, 'M1.gbt': { verdict: 'TOO FEW — cannot tell', precision: 0.6, ci: [0.357, 0.802], n: 5, pAdjusted: 1 } },
      leakCheck: { lr: { aucPrefix: 0.5, aucHindsight: 0.6 }, gbt: { aucPrefix: 0.55, aucHindsight: 0.91 } },
      secondary: { prefixTurns: 32, models: { gbt: { auc: 0.6 }, lr: { auc: null } } } })
    expect(line).toBe('- Outcome hindcast: v3 at K = 16 turns on 21 held-out missions (base 57%): M1.gbt precision 60% [36, 80] on 5 fired p(Holm) 1.000 TOO FEW; '
      + 'M1.lr precision 50% [20, 80] on 8 fired p(Holm) 1.000 NO EVIDENCE; leak check gbt AUC prefix 0.55 / hindsight 0.91, lr AUC prefix 0.50 / hindsight 0.60; K = 32 gbt AUC 0.60, lr AUC null')
  })

  it('counts the dead columns on the entry line; the detail (the verb) names them', () => {
    const h = { version: 1, prefixTurns: 16, nHoldout: 21, baseRate: 0.5, lengthFeature: null, ladder: {}, leakCheck: null, secondary: null,
      droppedFeatures: ['stuckTurns.mean', 'consecutiveUnstable.last'] }
    expect(hindcastLine(h))
      .toBe('- Outcome hindcast: v1 at K = 16 turns on 21 held-out missions (base 50%): no ladder reading; leak check not run; dropped 2 dead column(s)')
    expect(hindcastLine(h, { detail: true }))
      .toBe('- Outcome hindcast: v1 at K = 16 turns on 21 held-out missions (base 50%): no ladder reading; leak check not run; dropped 2 dead column(s): stuckTurns.mean, consecutiveUnstable.last')
  })

  it('names a length feature when one reached the prefix', () => {
    expect(hindcastLine({ version: 1, prefixTurns: 16, nHoldout: 21, baseRate: 0.5, lengthFeature: 'turnsInPrefix', ladder: {}, leakCheck: null, secondary: null }))
      .toBe('- Outcome hindcast: v1 at K = 16 turns on 21 held-out missions (base 50%): no ladder reading; leak check not run; LENGTH FEATURE turnsInPrefix in the prefix')
  })
})
