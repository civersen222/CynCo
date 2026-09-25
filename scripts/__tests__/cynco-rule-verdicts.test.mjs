import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { RULE_VERDICTS_PATH, writeRuleVerdicts, readRuleVerdicts, RULE_VERDICTS_SCHEMA, RULE_VERDICTS_HISTORY_CAP } from '../cynco-rule-verdicts.mjs'
import { analyse, ruleVerdictOf } from '../cynco-signal-validation.mjs'

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
    expect(r).toEqual({ version: 1, predictive: ['X'], total: 2 })
    const f = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(f.schema).toBe(RULE_VERDICTS_SCHEMA)
    expect(f).toMatchObject({ version: 1, writtenAt: '2026-09-25T00:00:00.000Z', campaign: 'c8', predictive: ['X'] })
    expect(f.ledger).toMatchObject({ total: 24, labeled: 24, failures: 12 })
    expect(f.rules.X).toMatchObject({ verdict: 'PREDICTIVE', firedTotal: 12, labeled: 12, failures: 12 })
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
    expect(f.writtenAt).toBe('t2')
    expect(f.ledger.total).toBe(25)
    expect(f.history).toHaveLength(1)
  })

  it('bumps the version and records what moved when a verdict changes', () => {
    const outPath = RULE_VERDICTS_PATH(home())
    writeRuleVerdicts({ rows: predictiveRows(), campaign: 'c8', outPath, now: () => 't1' })
    const r = writeRuleVerdicts({ rows: thinRows(), campaign: 'c8', outPath, now: () => 't2' })
    expect(r).toEqual({ version: 2, predictive: [], total: 2 })
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
    expect(writeRuleVerdicts({ rows: [], campaign: 'c8', outPath })).toEqual({ version: 1, predictive: [], total: 0 })
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
