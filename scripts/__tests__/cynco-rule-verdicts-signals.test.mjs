// F165 fix round 1 (review I2): the S5 rules whose condition reads a signal
// that changed meaning in signals v2 (W5, I2 — the homeostat streak) are
// scored on v2 missions only, their v1 table kept apart as `v1`; every other
// rule pools across versions as before. Temp dirs only.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuleVerdicts, V2_CHANGED_RULES } from '../cynco-rule-verdicts.mjs'
import { analyse } from '../cynco-signal-validation.mjs'

const out = () => join(mkdtempSync(join(tmpdir(), 'verdicts-signals-')), 'rule-verdicts.json')
const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
const turns = (v) => Array.from({ length: 4 }, () => (v === 2 ? { signalsVersion: 2 } : {}))
const mission = (ok, ruleIds, v) => ({ outcome: ok ? 'landed' : 'failed', verified: ok, mutationSweep: sweep, s5Decisions: [{ ruleIds }], turns: turns(v) })

// v1: W5 and I2 fired on EVERY mission (the homeostat never read stable) — 12
// failures and 12 successes. v2: W5 fires on the 12 failures only, I2 on 3
// successes. X (an unaffected rule) fires on every failure in both eras.
const rows = () => [
  ...Array.from({ length: 12 }, () => mission(false, ['W5', 'I2', 'X'], 1)),
  ...Array.from({ length: 12 }, () => mission(true, ['W5', 'I2'], 1)),
  ...Array.from({ length: 12 }, () => mission(false, ['W5', 'X'], 2)),
  ...Array.from({ length: 12 }, (_, i) => mission(true, i < 3 ? ['I2'] : [], 2)),
]

describe('rules that read v2-changed signals are scored on v2 rows only (F165)', () => {
  it('the affected rules are W5 and I2', () => {
    expect(V2_CHANGED_RULES).toEqual(['I2', 'W5'])
  })

  it('W5/I2 count v2 missions only, with their v1 table kept apart; X pools as before', () => {
    const path = out()
    writeRuleVerdicts({ rows: rows(), campaign: 'c', outPath: path })
    const file = JSON.parse(readFileSync(path, 'utf8'))
    const w5 = file.rules.W5
    // v2: fired on the 12 failures and nothing else — 12 fired, all failures.
    expect(w5).toMatchObject({ signals: 'v2', n: 12, failures: 12, precision: 1, firedTotal: 12, scopeN: 24 })
    expect(w5.v1).toMatchObject({ n: 24, failures: 12, precision: 0.5, firedTotal: 24, scopeN: 24 })
    expect(file.rules.I2).toMatchObject({ signals: 'v2', n: 3, failures: 0, precision: 0, scopeN: 24, verdict: 'TOO FEW — cannot tell' })
    expect(file.rules.I2.v1).toMatchObject({ n: 24, failures: 12 })
    // Pooled, W5 would read CONSTANT-ish at 36 fired of 48; it reads the v2 table.
    expect(w5.verdict).not.toMatch(/^CONSTANT/)
    // X: the ordinary pooled table over all 48 missions, no `signals`, no `v1`.
    const pooled = analyse(rows(), { firedOf: (r) => new Set(r.s5Decisions[0].ruleIds.filter(id => id === 'X')) }).rules.find(r => r.id === 'X')
    expect(file.rules.X).toMatchObject({ n: pooled.labeled, failures: pooled.failures, precision: pooled.precision, p: pooled.p })
    expect(file.rules.X.n).toBe(24)
    expect('signals' in file.rules.X).toBe(false)
    expect('v1' in file.rules.X).toBe(false)
    expect(file.ledger).toMatchObject({ total: 48, v2Rules: ['I2', 'W5'] })
    // One Holm family over all three rules, as before.
    expect(file.ledger.rulesTested).toBe(3)
  })

  it('an affected rule that fired only in v1 has an empty v2 table (n 0, null numbers), never the v1 one', () => {
    const path = out()
    const v1only = [...Array.from({ length: 6 }, () => mission(false, ['W5'], 1)), ...Array.from({ length: 6 }, () => mission(true, ['W5'], 1)),
      ...Array.from({ length: 4 }, (_, i) => mission(i % 2 === 0, [], 2))]
    writeRuleVerdicts({ rows: v1only, campaign: 'c', outPath: path })
    const w5 = JSON.parse(readFileSync(path, 'utf8')).rules.W5
    expect(w5).toMatchObject({ signals: 'v2', n: 0, precision: null, p: null, firedTotal: 0, scopeN: 4, verdict: 'TOO FEW — cannot tell' })
    expect(w5.v1).toMatchObject({ n: 12, failures: 6, precision: 0.5 })
  })

  it('a ledger where no affected rule fired is written exactly as before', () => {
    const path = out()
    const plain = [...Array.from({ length: 12 }, () => mission(false, ['X'], 1)), ...Array.from({ length: 12 }, () => mission(true, [], 2))]
    writeRuleVerdicts({ rows: plain, campaign: 'c', outPath: path })
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(file.rules)).toEqual(['X'])
    expect('v2Rules' in file.ledger).toBe(false)
    expect('signals' in file.rules.X).toBe(false)
  })
})
