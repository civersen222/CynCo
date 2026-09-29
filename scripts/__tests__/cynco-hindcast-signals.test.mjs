// F165 fix round 1 (review I1): the runner's hindcast trains on ONE signals
// version — the current one — and says how many eligible missions each
// version had. v1 rows (consecutiveUnstable = the turn index, algedonicAlerts
// cumulative) and v2 rows describe different instruments; a model fitted on
// both learns the era. Temp dirs only; the python run is the real script.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportOutcomeDatasets, runHindcast, hindcastOf, noEligibleFault, HINDCAST_SIGNALS_VERSION } from '../cynco-hindcast.mjs'
import { hindcastLine } from '../cynco-campaign-verdict.mjs'
import { main as ruleVerdictsMain } from '../cynco-rule-verdicts.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'hindcast-signals-'))
const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
const turns = (n, v) => Array.from({ length: n }, (_, i) => ({ toolSuccessRate: i % 2 ? 1 : 0.5, health: 'healthy',
  ...(v === 2 ? { signalsVersion: 2, algedonicAlertsTotal: i, consecutiveUnstable: i % 3 } : { consecutiveUnstable: i + 1 }) }))
const row = (missionId, v, ok) => ({ missionId, outcome: ok ? 'landed' : 'failed', verified: ok, mutationSweep: sweep, turns: turns(40, v) })
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const manifestIn = (d, ids) => { const p = join(d, 'frozen-eval.json'); writeFileSync(p, JSON.stringify({ schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ids })); return p }

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

  it('too few v2 rows: the real model refuses, and the unmeasured reading names each version\'s count', () => {
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
    // temp home has no campaigns, so R1.no-progress is UNMEASURED on the line.
    expect(lines[0]).toBe('- Outcome hindcast: UNMEASURED — no eligible labeled mission at K = 16 turns with signals v2 (eligible by version: v1: 4) — nothing to train on'
      + '; R1.no-progress precision null on 0 fired p(Holm) null UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)')
  })
})

describe('the verdict entry names the version and the counts (F165)', () => {
  const h = { version: 5, prefixTurns: 16, nHoldout: 9, baseRate: 0.5, lengthFeature: null, ladder: {}, leakCheck: null, secondary: null }

  it('a model fitted on one version says which, with every version\'s eligible count', () => {
    expect(hindcastLine({ ...h, signalsVersion: 2, rowsByVersion: { 2: 40, 1: 104 } }))
      .toBe('- Outcome hindcast: v5 at K = 16 turns, signals v2 only (eligible v1 104, v2 40) on 9 held-out missions (base 50%): no ladder reading; leak check not run')
  })

  it('a model written before F165 reads as before', () => {
    expect(hindcastLine(h)).toBe('- Outcome hindcast: v5 at K = 16 turns on 9 held-out missions (base 50%): no ladder reading; leak check not run')
  })
})
