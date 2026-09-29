import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { RULE_VERDICTS_PATH, writeRuleVerdicts, readRuleVerdicts, RULE_VERDICTS_SCHEMA, RULE_VERDICTS_HISTORY_CAP, OUTCOME_MODEL_PATH, modelRowsFrom, main, verdictsLine } from '../cynco-rule-verdicts.mjs'
import { analyse, ruleVerdictOf, holm } from '../cynco-signal-validation.mjs'
import { runnerRowsFrom } from '../cynco-campaign-progress.mjs'

afterEach(() => { vi.restoreAllMocks() })

const home = () => mkdtempSync(join(tmpdir(), 'verdicts-'))
const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
const failed = (ruleIds) => ({ outcome: 'failed', verified: false, mutationSweep: sweep, s5Decisions: [{ ruleIds }] })
const landed = (ruleIds) => ({ outcome: 'landed', verified: true, mutationSweep: sweep, s5Decisions: [{ ruleIds }] })

// X fires on all twelve failures and none of the twelve successes: PREDICTIVE.
// Y fires on every mission: CONSTANT. Real rows through the real `analyse`,
// so the writer is checked against the verdicts the table prints.
const predictiveRows = () => [
  ...Array.from({ length: 12 }, () => failed(['X', 'Y'])),
  ...Array.from({ length: 12 }, () => landed(['Y'])),
]
// The same two rules on three missions: TOO FEW for both.
const thinRows = () => [failed(['X', 'Y']), landed(['Y']), landed(['Y'])]

describe('ruleVerdictOf — the one verdict string', () => {
  it('is the verdict the S5 table prints, for every branch', () => {
    const r = (over) => ({ labeled: 20, coverage: 0.5, p: 0.5, pAdjusted: 0.5, lift: 0.1, ...over })
    expect(ruleVerdictOf(r({ labeled: 3 }))).toBe('TOO FEW — cannot tell')
    expect(ruleVerdictOf(r({ coverage: 0.99 }))).toBe('CONSTANT — fires on everything, predicts nothing')
    expect(ruleVerdictOf(r({ p: 0.001, pAdjusted: 0.01, lift: 0.3 }))).toBe('PREDICTIVE')
    expect(ruleVerdictOf(r({ p: 0.001, pAdjusted: 0.01, lift: -0.3 }))).toBe('INVERTED — fires more on successes')
    expect(ruleVerdictOf(r({ p: 0.01, pAdjusted: 0.2 }))).toBe('NOT AFTER CORRECTION — chance across this many rules')
    expect(ruleVerdictOf(r({}))).toBe('NO EVIDENCE')
  })
})

describe('writeRuleVerdicts', () => {
  it('lives at <home>/datasets/rule-verdicts.json', () => {
    expect(RULE_VERDICTS_PATH('H').replace(/\\/g, '/')).toBe('H/datasets/rule-verdicts.json')
  })

  it('writes the schema: one verdict per rule, the predictive ids, the ledger totals, a history entry', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const r = writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath, now: () => '2026-09-25T00:00:00.000Z' })
    expect(r).toEqual({ version: 1, predictive: ['X'], total: 2, rules: 2, modelRows: 0 })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.schema).toBe(RULE_VERDICTS_SCHEMA)
    expect(f).toMatchObject({ version: 1, at: '2026-09-25T00:00:00.000Z', campaign: 'c8', predictive: ['X'] })
    expect(f.writtenAt).toBeUndefined()
    expect(f.ledger).toMatchObject({ total: 24, labeled: 24, failures: 12 })
    // The spec's per-rule schema: { verdict, precision, ci, p, n, … }.
    expect(f.rules.X).toMatchObject({ verdict: 'PREDICTIVE', precision: 1, n: 12, firedTotal: 12, failures: 12 })
    expect(f.rules.X.ci).toHaveLength(2)
    expect(f.rules.X.ci[0]).toBeGreaterThan(0.7)
    expect(typeof f.rules.X.p).toBe('number')
    expect(f.rules.Y.verdict).toBe('CONSTANT — fires on everything, predicts nothing')
    expect(f.history).toEqual([{ version: 1, at: '2026-09-25T00:00:00.000Z', campaign: 'c8', predictive: ['X'],
      changed: [{ id: 'X', from: null, to: 'PREDICTIVE' }, { id: 'Y', from: null, to: 'CONSTANT — fires on everything, predicts nothing' }] }])
    // tmp + rename: nothing is left beside the file.
    expect(readdirSync(dirname(outPath))).toEqual(['rule-verdicts.json'])
  })

  it('stores exactly the string the table prints for each rule', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const rows = predictiveRows()
    writeRuleVerdicts({ rows, campaign: 'c8', outPath })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    for (const r of analyse(rows).rules) expect(f.rules[r.id].verdict).toBe(ruleVerdictOf(r))
  })

  it('does not bump the version when the verdict set did not change', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath, now: () => 't1' })
    // More evidence, same verdicts: the numbers are refreshed, the version is not.
    const r = writeRuleVerdicts({ rows: [...predictiveRows(), landed(['Y'])], campaign: 'c9', outPath, now: () => 't2' })
    expect(r.version).toBe(1)
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.version).toBe(1)
    expect(f.at).toBe('t2')
    expect(f.ledger.total).toBe(25)
    expect(f.history).toHaveLength(1)
  })

  it('bumps the version and records what moved when a verdict changes', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath, now: () => 't1' })
    const r = writeRuleVerdicts({ rows: thinRows(), campaign: 'c8', outPath, now: () => 't2' })
    expect(r).toEqual({ version: 2, predictive: [], total: 2, rules: 2, modelRows: 0 })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.history).toHaveLength(2)
    expect(f.history[1]).toEqual({ version: 2, at: 't2', campaign: 'c8', predictive: [],
      changed: [{ id: 'X', from: 'PREDICTIVE', to: 'TOO FEW — cannot tell' }, { id: 'Y', from: 'CONSTANT — fires on everything, predicts nothing', to: 'TOO FEW — cannot tell' }] })
  })

  it('a rule that stops appearing is a change', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const analyseFn = (ids) => () => ({ total: 1, labeled: 1, failures: 0, base: 0, rulesTested: 0, rules: ids.map(id => ({ id, labeled: 0, coverage: 0, p: null, pAdjusted: null, lift: null })) })
    writeRuleVerdicts({ rows: [], campaign: 'c8', outPath, analyse: analyseFn(['A', 'B']) })
    const r = writeRuleVerdicts({ rows: [], campaign: 'c8', outPath, analyse: analyseFn(['A']) })
    expect(r.version).toBe(2)
    expect(JSON.parse(readFileSync(outPath, 'utf8')).history[1].changed).toEqual([{ id: 'B', from: 'TOO FEW — cannot tell', to: null }])
  })

  it(`keeps the last ${RULE_VERDICTS_HISTORY_CAP} history entries`, () => {
    const outPath = RULE_VERDICTS_PATH(home())
    for (let i = 0; i < 25; i++) writeRuleVerdicts({ rows: i % 2 ? thinRows() : predictiveRows(), campaign: 'c8', outPath, now: () => `t${i}` })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.version).toBe(25)
    expect(f.history).toHaveLength(RULE_VERDICTS_HISTORY_CAP)
    expect(f.history.at(-1).version).toBe(25)
    expect(f.history[0].version).toBe(6)
  })

  it('an empty ledger writes a file with no rules — the engine reads that as "nothing earned"', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    expect(writeRuleVerdicts({ rows: [], campaign: 'c8', outPath })).toEqual({ version: 1, predictive: [], total: 0, rules: 0, modelRows: 0 })
    expect(JSON.parse(readFileSync(outPath, 'utf8')).rules).toEqual({})
  })

  it('starts over at the next version when the file on disk is corrupt, and says so', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, '{ not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath })
    expect(r.version).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})

// ── Phase 5 ruling 5: the outcome model enters the ladder as a rule would ────

describe('modelRowsFrom', () => {
  const model = { models: {
    lr: { predictions: [{ missionId: 'a', pFail: 0.5 }, { missionId: 'b', pFail: 0.49 }, { missionId: 'gone', pFail: 0.9 }] },
    gbt: { predictions: [{ missionId: 'a', pFail: 0.1 }, { missionId: 'b', pFail: 0.95 }] },
  } }
  const rows = [{ missionId: 'a' }, { missionId: 'b' }, { missionId: 'train-only' }]

  it('one synthetic rule per model: fired = pFail ≥ 0.5, scope = the held-out ids the ledger still has', () => {
    const out = modelRowsFrom(model, rows)
    expect(out.map(m => m.id)).toEqual(['M1.gbt', 'M1.lr'])
    const lr = out.find(m => m.id === 'M1.lr')
    expect(lr.source).toBe('model')
    expect([...lr.scope].sort()).toEqual(['a', 'b'])
    expect([...lr.fired]).toEqual(['a'])
    expect([...out.find(m => m.id === 'M1.gbt').fired]).toEqual(['b'])
  })

  it('no model file, or no models in it, is no rows', () => {
    expect(modelRowsFrom(null, rows)).toEqual([])
    expect(modelRowsFrom({}, rows)).toEqual([])
  })

  it('lives at <home>/datasets/outcome-model.json', () => {
    expect(OUTCOME_MODEL_PATH('H').replace(/\\/g, '/')).toBe('H/datasets/outcome-model.json')
  })
})

describe('writeRuleVerdicts with model rows', () => {
  // 20 held-out missions (12 failures, 8 successes) and 10 training missions
  // the model never scored. The model fires on 10 held-out missions: 8
  // failures and 2 successes.
  const withId = (row, missionId) => ({ ...row, missionId })
  const holdoutRows = () => [
    ...Array.from({ length: 12 }, (_, i) => withId(failed([]), `hf${i}`)),
    ...Array.from({ length: 8 }, (_, i) => withId(landed([]), `hs${i}`)),
  ]
  const trainRows = () => Array.from({ length: 10 }, (_, i) => withId(i % 2 ? landed([]) : failed([]), `t${i}`))
  const firedIds = ['hf0', 'hf1', 'hf2', 'hf3', 'hf4', 'hf5', 'hf6', 'hf7', 'hs0', 'hs1']
  const modelRow = () => ({ id: 'M1.gbt', source: 'model', fired: new Set(firedIds), scope: new Set(holdoutRows().map(r => r.missionId)) })

  it('gets exactly the numbers `analyse` gives a rule firing on the same missions, over the holdout only', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: [...holdoutRows(), ...trainRows()], campaign: 'c9', outPath, modelRows: [modelRow()] })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    // The same missions as an ordinary rule 'R', over the 20 held-out rows alone.
    const asRule = analyse(holdoutRows().map(r => firedIds.includes(r.missionId) ? { ...r, s5Decisions: [{ ruleIds: ['R'] }] } : r)).rules.find(r => r.id === 'R')
    expect(asRule).toMatchObject({ labeled: 10, failures: 8, precision: 0.8 })
    expect(f.rules['M1.gbt']).toMatchObject({
      verdict: ruleVerdictOf(asRule), precision: asRule.precision, ci: asRule.ci, p: asRule.p, n: 10,
      pAdjusted: asRule.pAdjusted, lift: asRule.lift, failures: 8, source: 'model', scope: 'holdout',
    })
    // lift is against the HOLDOUT base (12/20), not the whole ledger's (17/30).
    expect(f.rules['M1.gbt'].lift).toBeCloseTo(0.8 - 12 / 20, 10)
    expect(f.rules['M1.gbt'].base).toBeCloseTo(12 / 20, 10)
    expect(f.rules['M1.gbt'].scopeN).toBe(20)
  })

  it('the Holm family is the S5 rules and the model rows together', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    // X is the PREDICTIVE rule from above; Y fires everywhere (p null, untested).
    const rows = predictiveRows().map((r, i) => withId(r, `p${i}`))
    const alone = analyse(rows).rules.find(r => r.id === 'X')
    const scope = new Set(rows.map(r => r.missionId))
    const m = { id: 'M1.lr', source: 'model', fired: new Set(rows.slice(0, 12).map(r => r.missionId)), scope }
    writeRuleVerdicts({ rows, campaign: 'c9', outPath, modelRows: [m] })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    // Two tested members (X and M1.lr, same p): each is corrected by 2 at the first step.
    expect(f.rules.X.pAdjusted).toBeCloseTo(Math.min(1, alone.p * 2), 12)
    expect(f.rules['M1.lr'].pAdjusted).toBeCloseTo(Math.min(1, alone.p * 2), 12)
    expect(f.ledger.holmFamily).toBe(2)
    expect(f.rules.X.source).toBeUndefined()
  })

  it('a model row that fired on nothing is written with no numbers, not zeros (F16)', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const quiet = { ...modelRow(), fired: new Set() }
    writeRuleVerdicts({ rows: holdoutRows(), campaign: 'c9', outPath, modelRows: [quiet] })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.rules['M1.gbt']).toMatchObject({ verdict: 'TOO FEW — cannot tell', precision: null, p: null, pAdjusted: null, n: 0, source: 'model', scope: 'holdout' })
  })

  // Final review M2 (T5-M2): the version counts changes in what S5 may
  // enforce. An M1 row appearing, vanishing or moving is on the record in
  // `modelChanged`, never a version bump.
  it('M1.* rows appearing or vanishing do not bump the version; the move is kept as modelChanged', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const rows = [...holdoutRows(), ...trainRows()]
    const v1 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't1' })
    // wave N: the hindcast ran — M1.gbt appears.
    const v2 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't2', modelRows: [modelRow()] })
    // wave N+1: the hindcast faulted — it vanishes.
    const v3 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't3' })
    expect([v1.version, v2.version, v3.version]).toEqual([1, 1, 1])
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.version).toBe(1)
    expect(f.history.map(h => ({ version: h.version, at: h.at, changed: h.changed, modelChanged: h.modelChanged }))).toEqual([
      { version: 1, at: 't1', changed: [], modelChanged: undefined },
      { version: 1, at: 't2', changed: [], modelChanged: [{ id: 'M1.gbt', from: null, to: f.history[1].modelChanged[0].to }] },
      { version: 1, at: 't3', changed: [], modelChanged: [{ id: 'M1.gbt', from: f.history[1].modelChanged[0].to, to: null }] },
    ])
    expect(f.history[1].modelChanged[0].to).toEqual(expect.any(String))
    // Unchanged model rows add nothing.
    writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't4' })
    expect(JSON.parse(readFileSync(outPath, 'utf8')).history).toHaveLength(3)
  })

  it('a rule move still bumps the version, and a model move in the same write rides on that entry', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const thin = thinRows().map((r, i) => withId(r, `hf${i}`))
    writeRuleVerdicts({ rows: thin, campaign: 'c9', outPath, now: () => 't1' })
    const rows = predictiveRows().map((r, i) => withId(r, `hf${i}`))
    const m = { id: 'M1.lr', source: 'model', fired: new Set(rows.slice(0, 12).map(r => r.missionId)), scope: new Set(rows.map(r => r.missionId)) }
    const r = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't2', modelRows: [m] })
    expect(r.version).toBe(2)
    const last = JSON.parse(readFileSync(outPath, 'utf8')).history.at(-1)
    expect(last.version).toBe(2)
    expect(last.changed.map(c => c.id)).toContain('X')
    expect(last.changed.map(c => c.id)).not.toContain('M1.lr')
    expect(last.modelChanged).toEqual([{ id: 'M1.lr', from: null, to: expect.any(String) }])
  })

  it('no model rows leaves the file exactly as before (no holmFamily recomputation of the rules)', () => {
    const a = RULE_VERDICTS_PATH(home()), b = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath: a, now: () => 't' })
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath: b, now: () => 't', modelRows: [] })
    expect(readFileSync(b, 'utf8')).toBe(readFileSync(a, 'utf8'))
  })
})

// Phase 6 Task 4: the runner's shadow regulator `R1.no-progress` in the ladder,
// as a `source: 'runner'` row built from the wave records (runnerRowsFrom) —
// the same Fisher/Wilson/Holm as a rule, never authority, never the version.
describe('writeRuleVerdicts with runner rows', () => {
  const past = [{ at: 't', sha: 's', fails: 2, elapsedFraction: 0.6 }]
  const wave = (missionId, kind, fired) => ({ missionId, decision: { kind }, progress: past, shadowDecisions: [{ rule: 'R1.no-progress', fired, elapsedFraction: 0.6 }] })
  // 15 in-scope waves: R1 fired on 5 (4 failed, 1 passed) and stayed quiet on
  // 10 (3 failed, 7 passed). Two out-of-scope waves: one never read past 50 %,
  // one a `stop` that never ran.
  const waves = () => [
    ...['f0', 'f1', 'f2', 'f3'].map(id => wave(id, 'next', true)), wave('p0', 'pass', true),
    ...['q0', 'q1', 'q2'].map(id => wave(id, 'budget', false)),
    ...Array.from({ length: 7 }, (_, i) => wave(`s${i}`, i % 2 ? 'pass-with-survivors' : 'pass', false)),
    { missionId: 'early', decision: { kind: 'next' }, progress: [{ fails: 2, elapsedFraction: 0.3 }], shadowDecisions: [{ rule: 'R1.no-progress', fired: true, elapsedFraction: 0.3 }] },
    { missionId: 'stopped', decision: { kind: 'stop' }, progress: past, shadowDecisions: [{ rule: 'R1.no-progress', fired: true, elapsedFraction: 0.6 }] },
  ]
  // The same 15 missions as ledger rows of an ordinary rule 'R'.
  const asRuleRows = () => [
    ...Array.from({ length: 4 }, () => failed(['R'])), landed(['R']),
    ...Array.from({ length: 3 }, () => failed([])), ...Array.from({ length: 7 }, () => landed([])),
  ]

  it('a runner row with 4 of 5 fired waves failing gets exactly the numbers `analyse` gives a rule', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const r = writeRuleVerdicts({ rows: [], campaign: 'c9', outPath, runnerRows: runnerRowsFrom(waves()) })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    const asRule = analyse(asRuleRows()).rules.find(x => x.id === 'R')
    expect(asRule).toMatchObject({ labeled: 5, failures: 4, precision: 0.8 })
    expect(f.rules['R1.no-progress']).toEqual({
      verdict: ruleVerdictOf(asRule), precision: 0.8, ci: asRule.ci, p: asRule.p, n: 5,
      pAdjusted: asRule.pAdjusted, lift: asRule.lift, firedTotal: 5, failures: 4,
      source: 'runner', scope: 'waves', base: 7 / 15, scopeN: 15, note: null,
    })
    expect(f.rules['R1.no-progress'].lift).toBeCloseTo(0.8 - 7 / 15, 10)
    expect(f.rules['R1.no-progress'].verdict).toBe('TOO FEW — cannot tell')
    // The return names the runner rows apart from the rules and the model rows.
    expect(r).toMatchObject({ rules: 0, modelRows: 0, runnerRows: 1, total: 1 })
    expect(r.runners['R1.no-progress']).toEqual(f.rules['R1.no-progress'])
  })

  it('the Holm family is the rules, the model rows and the runner rows together', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const rows = predictiveRows().map((r, i) => ({ ...r, missionId: `p${i}` }))
    const x = analyse(rows).rules.find(r => r.id === 'X')
    const run = analyse(asRuleRows()).rules.find(r => r.id === 'R')
    writeRuleVerdicts({ rows, campaign: 'c9', outPath, runnerRows: runnerRowsFrom(waves()) })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    const family = [{ id: 'X', p: x.p }, { id: 'R', p: run.p }]
    holm(family)
    expect(f.ledger.holmFamily).toBe(2)
    expect(f.rules.X.pAdjusted).toBeCloseTo(family[0].pAdjusted, 12)
    expect(f.rules['R1.no-progress'].pAdjusted).toBeCloseTo(family[1].pAdjusted, 12)
  })

  it('no fired decision in scope is UNMEASURED with n 0 and no numbers, never a rate (F16)', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const quiet = waves().map(w => ({ ...w, shadowDecisions: w.shadowDecisions.map(d => ({ ...d, fired: false })) }))
    writeRuleVerdicts({ rows: [], campaign: 'c9', outPath, runnerRows: runnerRowsFrom(quiet) })
    expect(JSON.parse(readFileSync(outPath, 'utf8')).rules['R1.no-progress']).toMatchObject({
      verdict: 'UNMEASURED — fired on no in-scope wave', n: 0, firedTotal: 0, failures: 0, precision: null, p: null, pAdjusted: null, lift: null,
      ci: null, source: 'runner', scope: 'waves', scopeN: 15, base: 7 / 15 })
    // An empty scope (no wave read past 50 %) says so, and has no base either.
    const empty = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: [], campaign: 'c9', outPath: empty, runnerRows: runnerRowsFrom([]) })
    expect(JSON.parse(readFileSync(empty, 'utf8')).rules['R1.no-progress']).toMatchObject({
      verdict: 'UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)', n: 0, precision: null, p: null, ci: null, scopeN: 0, base: null })
  })

  // Review M1: a malformed wave record costs that record, never the row.
  it('a malformed wave record is skipped and named on the row; the rest is measured', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const bad = [{ missionId: 'bad-obj', decision: { kind: 'next' }, shadowDecisions: {} }, 'not a record', null]
    writeRuleVerdicts({ rows: [], campaign: 'c9', outPath, runnerRows: runnerRowsFrom([...waves(), ...bad]) })
    const e = JSON.parse(readFileSync(outPath, 'utf8')).rules['R1.no-progress']
    expect(e).toMatchObject({ n: 5, failures: 4, scopeN: 15, note: '3 malformed wave record(s) skipped: bad-obj, record #19, record #20' })
  })

  // Review M4: "N predictive of R rules" and the `predictive` list agree —
  // R1 is in neither, even when it reads PREDICTIVE.
  it('a PREDICTIVE runner row is not in the file\'s `predictive` list, as it is not in the rule count', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const strong = [...Array.from({ length: 12 }, (_, i) => wave(`sf${i}`, 'next', true)), ...Array.from({ length: 12 }, (_, i) => wave(`sp${i}`, 'pass', false))]
    const r = writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c9', outPath, runnerRows: runnerRowsFrom(strong) })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.rules['R1.no-progress'].verdict).toBe('PREDICTIVE')
    expect(f.predictive).toEqual(['X'])
    expect(r.predictive).toEqual(['X'])
    expect(verdictsLine(r, 'P')).toBe('rule verdicts v1: 1 predictive of 2 rules (+1 runner row) (X) → P')
  })

  it('a runner row appearing, moving or vanishing never bumps the version; it is kept as runnerChanged', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    const rows = predictiveRows()
    const v1 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't1' })
    const v2 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't2', runnerRows: runnerRowsFrom([]) })
    const v3 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't3', runnerRows: runnerRowsFrom(waves()) })
    const v4 = writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't4' })
    expect([v1.version, v2.version, v3.version, v4.version]).toEqual([1, 1, 1, 1])
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.version).toBe(1)
    const unmeasured = 'UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)'
    expect(f.history.map(h => ({ version: h.version, at: h.at, changed: h.changed, runnerChanged: h.runnerChanged, modelChanged: h.modelChanged }))).toEqual([
      { version: 1, at: 't1', changed: f.history[0].changed, runnerChanged: undefined, modelChanged: undefined },
      { version: 1, at: 't2', changed: [], runnerChanged: [{ id: 'R1.no-progress', from: null, to: unmeasured }], modelChanged: undefined },
      { version: 1, at: 't3', changed: [], runnerChanged: [{ id: 'R1.no-progress', from: unmeasured, to: 'TOO FEW — cannot tell' }], modelChanged: undefined },
      { version: 1, at: 't4', changed: [], runnerChanged: [{ id: 'R1.no-progress', from: 'TOO FEW — cannot tell', to: null }], modelChanged: undefined },
    ])
    // Unchanged runner rows add nothing.
    writeRuleVerdicts({ rows, campaign: 'c9', outPath, now: () => 't5' })
    expect(JSON.parse(readFileSync(outPath, 'utf8')).history).toHaveLength(4)
  })

  it('a rule move still bumps the version, and a runner move in the same write rides on that entry', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: thinRows(), campaign: 'c9', outPath, now: () => 't1' })
    const r = writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c9', outPath, now: () => 't2', runnerRows: runnerRowsFrom(waves()) })
    expect(r.version).toBe(2)
    const last = JSON.parse(readFileSync(outPath, 'utf8')).history.at(-1)
    expect(last.changed.map(c => c.id)).toContain('X')
    expect(last.changed.map(c => c.id)).not.toContain('R1.no-progress')
    expect(last.runnerChanged).toEqual([{ id: 'R1.no-progress', from: null, to: 'TOO FEW — cannot tell' }])
  })

  it('verdictsLine counts the runner rows apart', () => {
    expect(verdictsLine({ version: 3, predictive: [], rules: 8, modelRows: 2, runnerRows: 1, total: 11 }, 'P'))
      .toBe('rule verdicts v3: 0 predictive of 8 rules (+2 model rows) (+1 runner row) (none) → P')
  })
})

describe('readRuleVerdicts', () => {
  it('null without a word when there is no file — the legacy state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readRuleVerdicts(join(home(), 'nope.json'))).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('null WITH a warning for a file that will not parse or is not the schema', () => {
    const dir = home()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, 'a.json'), '{ nope', 'utf8')
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ schema: 99, rules: {} }), 'utf8')
    expect(readRuleVerdicts(join(dir, 'a.json'))).toBeNull()
    expect(readRuleVerdicts(join(dir, 'b.json'))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('reads back what the writer wrote', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath })
    const f = readRuleVerdicts(outPath)
    expect(f.predictive).toEqual(['X'])
    expect(existsSync(outPath)).toBe(true)
  })
})

// Final review M7 (T7-M5 + `--with-hindcast`): the CLI names rules and model
// rows apart, and with `--with-hindcast` runs the runner's own sequence —
// export → model → verdicts. The python seam is stubbed; every file lands in a
// temp `--datasets-dir`; `cyncoHome` throws, so the real home is never read.
describe('the CLI (main)', () => {
  const noHome = () => { throw new Error('the real home must not be touched') }
  // Review I1: every CLI run builds the runner row from a campaigns dir; an
  // empty temp one here (the real home is never read).
  const noCampaigns = () => ['--campaigns-dir', home()]
  const R1_EMPTY = 'R1.no-progress precision null on 0 fired p(Holm) null UNMEASURED — no wave in scope (no shadow decision at 50 % of its clock or later)'
  const turnsOf = (n) => Array.from({ length: n }, (_, i) => ({ toolSuccessRate: i % 2 ? 1 : 0.5, health: 'healthy' }))
  // 12 failures firing X and Y, 12 successes firing Y — X PREDICTIVE, Y CONSTANT — each with 20 turns.
  // v2 turns (F165): the hindcast trains on the current signals version only.
  const ledgerRows = () => predictiveRows().map((r, i) => ({ ...r, missionId: `m${i}`, turns: turnsOf(20).map(t => ({ ...t, signalsVersion: 2 })) }))
  // A per-version holdout with a frozen v2 set (F165 fix round 2) — without
  // one the 24 v2 missions read "v2 holdout not yet frozen" and python never runs.
  const frozenV2 = () => {
    const p = join(home(), 'frozen-eval.json')
    writeFileSync(p, JSON.stringify({ schema: 2, sets: { 2: { schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ledgerRows().map(r => r.missionId) } }, history: [] }))
    return p
  }
  const modelAt = (path) => {
    mkdirSync(dirname(path), { recursive: true })
    const preds = (fired) => ledgerRows().map(r => ({ missionId: r.missionId, pFail: fired(r) ? 0.9 : 0.1 }))
    writeFileSync(path, JSON.stringify({ schema: 1, version: 4, trainedAt: 't', prefixTurns: 16, nTrain: 20, nHoldout: 24, baseRate: 0.5, features: ['a'], droppedFeatures: ['b', 'c'], lengthFeature: null,
      models: { gbt: { precision: 1, recall: 1, brier: 0.1, auc: 0.9, predictions: preds(r => r.outcome === 'failed') }, lr: { precision: null, recall: null, brier: 0.3, auc: 0.5, predictions: preds(() => false) } },
      leakCheck: { gbt: { aucPrefix: 0.9, aucHindsight: 0.95 }, lr: { aucPrefix: 0.5, aucHindsight: 0.5 } }, secondary: { refusal: 'TOO FEW: x' } }))
  }

  it('rules only: "N predictive of R rules" — the model rows never counted as rules', async () => {
    const out = join(home(), 'rv.json')
    const lines = []
    expect(await main(['--out', out, ...noCampaigns()], { readLedger: predictiveRows, cyncoHome: noHome, log: (s) => lines.push(s) })).toBe(0)
    expect(lines).toEqual([`rule verdicts v1: 1 predictive of 2 rules (+1 runner row) (X) → ${out}`])
  })

  it('verdictsLine prints the model rows beside the rules, as the scoreboard reads them', () => {
    expect(verdictsLine({ version: 3, predictive: [], rules: 8, modelRows: 2, total: 10 }, 'P')).toBe('rule verdicts v3: 0 predictive of 8 rules (+2 model rows) (none) → P')
  })

  it('--with-hindcast runs export → model → verdicts into --datasets-dir, and prints the hindcast line', async () => {
    const dir = join(home(), 'ds')
    const lines = [], seen = {}
    const code = await main(['--with-hindcast', '--datasets-dir', dir, '--manifest', frozenV2(), ...noCampaigns()], {
      readLedger: ledgerRows, cyncoHome: noHome, log: (s) => lines.push(s),
      runHindcast: ({ paths }) => { seen.paths = paths; modelAt(paths.out); return { status: 0, stdout: 'ok', stderr: '', fault: null } },
    })
    expect(code).toBe(0)
    // Every file in the temp dir, named as the runner names them.
    expect(seen.paths).toMatchObject({ dataset: join(dir, 'outcome-dataset.jsonl'), dataset32: join(dir, 'outcome-dataset-k32.jsonl'),
      hindsight: join(dir, 'outcome-dataset-hindsight.jsonl'), out: join(dir, 'outcome-model.json') })
    expect(readdirSync(dir).sort()).toEqual(['outcome-dataset-hindsight.jsonl', 'outcome-dataset-k32.jsonl', 'outcome-dataset.jsonl', 'outcome-model.json', 'rule-verdicts.json'])
    const f = JSON.parse(readFileSync(join(dir, 'rule-verdicts.json'), 'utf8'))
    expect(f.rules['M1.gbt']).toMatchObject({ source: 'model', scope: 'holdout', n: 12, failures: 12 })
    expect(f.rules['M1.lr']).toMatchObject({ source: 'model', n: 0 })
    expect(lines[0]).toMatch(/^- Outcome hindcast: v4 at K = 16 turns on 24 held-out missions \(base 50%\): M1\.gbt precision 100% .* on 12 fired p\(Holm\) .*; M1\.lr precision null on 0 fired p\(Holm\) null TOO FEW; R1\.no-progress precision null on 0 fired p\(Holm\) null UNMEASURED — no wave in scope \(no shadow decision at 50 % of its clock or later\); leak check gbt AUC prefix 0\.90 \/ hindsight 0\.95, lr AUC prefix 0\.50 \/ hindsight 0\.50; K = 32 TOO FEW: x; dropped 2 dead column\(s\)$/)
    expect(lines[1]).toMatch(new RegExp(`^rule verdicts v1: \\d predictive of 2 rules \\(\\+2 model rows\\) \\(\\+1 runner row\\) \\(.*\\) → ${join(dir, 'rule-verdicts.json').replace(/\\/g, '\\\\')}$`))
  })

  it('a hindcast that fails prints UNMEASURED and writes the rules without model rows — as the runner does', async () => {
    const dir = join(home(), 'ds')
    const lines = []
    await main(['--with-hindcast', '--datasets-dir', dir, '--manifest', frozenV2(), ...noCampaigns()], {
      readLedger: ledgerRows, cyncoHome: noHome, log: (s) => lines.push(s),
      runHindcast: () => ({ status: 2, stdout: 'TOO FEW: train 3 < 30 or holdout 1 < 8\n', stderr: '', fault: null }),
    })
    expect(lines[0]).toBe(`- Outcome hindcast: UNMEASURED — exit 2: TOO FEW: train 3 < 30 or holdout 1 < 8; ${R1_EMPTY}`)
    expect(lines[1]).toMatch(/^rule verdicts v1: 1 predictive of 2 rules \(\+1 runner row\) \(X\) → /)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'rule-verdicts.json'), 'utf8')).rules)).toEqual(['X', 'Y', 'R1.no-progress'])
  })

  it('--out wins over --datasets-dir for the verdict file', async () => {
    const dir = join(home(), 'ds'), out = join(home(), 'elsewhere.json')
    await main(['--with-hindcast', '--datasets-dir', dir, '--manifest', frozenV2(), '--out', out, ...noCampaigns()], {
      readLedger: ledgerRows, cyncoHome: noHome, log: () => {},
      runHindcast: ({ paths }) => { modelAt(paths.out); return { status: 0, stdout: '', stderr: '', fault: null } },
    })
    expect(existsSync(out)).toBe(true)
    expect(existsSync(join(dir, 'rule-verdicts.json'))).toBe(false)
  })
})
