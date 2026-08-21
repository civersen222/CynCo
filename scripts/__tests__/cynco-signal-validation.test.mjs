import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fisherExact, wilson, labelOf, rulesFired, readLedger, analyse,
} from '../cynco-signal-validation.mjs'

// A tool whose output decides whether a governance rule gets enforcement
// authority is a tool whose arithmetic has to be checked against known values,
// not eyeballed against a table that looks plausible.

describe('fisherExact', () => {
  it('reproduces the textbook tea-tasting table', () => {
    // Fisher's own 3/3 split of eight cups: p = 1/70 one-sided, 2/70 two-sided.
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 3)
    expect(fisherExact(4, 0, 0, 4)).toBeCloseTo(2 / 70, 4)
  })

  it('a table with no association reads p = 1', () => {
    expect(fisherExact(5, 5, 5, 5)).toBeCloseTo(1, 6)
  })

  it('is two-sided — an inverted rule is not filed as "no evidence"', () => {
    // Same strength of association, opposite direction. A one-sided test would
    // return ~1 for one of these, which is how a backwards rule survives.
    const forward = fisherExact(9, 1, 1, 9)
    const inverted = fisherExact(1, 9, 9, 1)
    expect(forward).toBeCloseTo(inverted, 10)
    expect(forward).toBeLessThan(0.01)
  })
})

describe('wilson', () => {
  it('never runs below zero at tiny n, where the normal interval would', () => {
    const [lo, hi] = wilson(1, 3)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThanOrEqual(1)
    // 1/3 on three trials must not read as a confident estimate.
    expect(hi - lo).toBeGreaterThan(0.5)
  })

  it('tightens as n grows around the same proportion', () => {
    const small = wilson(5, 10)
    const large = wilson(500, 1000)
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0])
  })

  it('n = 0 admits the whole range rather than claiming zero', () => {
    expect(wilson(0, 0)).toEqual([0, 1])
  })
})

describe('labelOf', () => {
  const base = { outcome: 'landed', verified: true, mutationSweep: { killed: 3, survived: [] } }

  it('landed + verified + swept is a success', () => {
    expect(labelOf(base)).toBe(true)
  })

  it('an unmeasured mutation sweep is unlabeled, NOT a pass', () => {
    // The whole point of the exclusion: nothing checked whether the delivered
    // tests own the rules they claim, so the row is not evidence either way.
    expect(labelOf({ ...base, mutationSweep: null })).toBe(null)
  })

  it('an unmeasured check-cmd is unlabeled, NOT a pass', () => {
    expect(labelOf({ ...base, verified: null })).toBe(null)
  })

  it('a missing key is treated like null, not like absent-means-fine', () => {
    const { mutationSweep, ...withoutSweep } = base
    expect(labelOf(withoutSweep)).toBe(null)
  })

  it('landed but unverified is a failure, not unlabeled', () => {
    expect(labelOf({ ...base, verified: false })).toBe(false)
  })

  it('a voided mission is a failure even when verified reads true', () => {
    expect(labelOf({ ...base, outcome: 'void-bad-brief' })).toBe(false)
  })
})

describe('rulesFired', () => {
  it('counts a mission once per rule however often the rule fired', () => {
    const row = { s5Decisions: [{ ruleIds: ['I1', 'I3'] }, { ruleIds: ['I1'] }] }
    expect([...rulesFired(row)].sort()).toEqual(['I1', 'I3'])
  })

  it('a mission with no decisions fires nothing', () => {
    expect(rulesFired({}).size).toBe(0)
  })
})

describe('analyse', () => {
  const sweep = { killed: 1, survived: [] }
  const mission = (id, rules, ok) => ({
    missionId: id, outcome: 'landed', verified: ok, mutationSweep: sweep,
    s5Decisions: rules.map(r => ({ ruleIds: [r] })),
  })

  it('excludes unlabeled rows from every count', () => {
    const rows = [
      mission('a', ['I1'], true),
      { ...mission('b', ['I1'], true), mutationSweep: null },
    ]
    const res = analyse(rows)
    expect(res.total).toBe(2)
    expect(res.labeled).toBe(1)
    expect(res.rules.find(r => r.id === 'I1').labeled).toBe(1)
    // ...but `fired` counts the whole ledger, so the two numbers disagreeing is
    // itself the signal that most rows are unmeasured.
    expect(res.rules.find(r => r.id === 'I1').firedTotal).toBe(2)
  })

  it('a rule that fires on every mission gets no credit for the base rate', () => {
    const rows = [
      mission('a', ['ALL'], false), mission('b', ['ALL'], false),
      mission('c', ['ALL'], true), mission('d', ['ALL'], true),
    ]
    const r = analyse(rows).rules.find(x => x.id === 'ALL')
    expect(r.coverage).toBe(1)
    expect(r.lift).toBeCloseTo(0, 10)
    expect(r.p).toBe(null)          // no contrast group exists to test against
  })

  it('reports negative lift for a rule that fires more on successes', () => {
    const rows = [
      mission('a', ['BAD'], true), mission('b', ['BAD'], true),
      mission('c', ['BAD'], true), mission('d', [], false), mission('e', [], false),
    ]
    const r = analyse(rows).rules.find(x => x.id === 'BAD')
    expect(r.precision).toBe(0)
    expect(r.lift).toBeLessThan(0)
  })

  it('Holm adjustment is monotone and never below the raw p', () => {
    const rows = []
    for (let i = 0; i < 40; i++) {
      rows.push(mission(`m${i}`, ['A', 'B', 'C'].slice(0, (i % 3) + 1), i % 3 === 0))
    }
    const res = analyse(rows)
    const tested = res.rules.filter(r => r.p !== null)
    for (const r of tested) expect(r.pAdjusted).toBeGreaterThanOrEqual(r.p - 1e-12)
    const sorted = [...tested].sort((x, y) => x.p - y.p).map(r => r.pAdjusted)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1] - 1e-12)
    }
  })
})

describe('readLedger', () => {
  it('reads every shard in name order and skips blank lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      writeFileSync(join(dir, 'missions.jsonl'), '{"missionId":"one"}\n\n')
      writeFileSync(join(dir, 'missions.0002.jsonl'), '{"missionId":"two"}\n')
      writeFileSync(join(dir, 'README.md'), 'not a shard')
      expect(readLedger(dir).map(r => r.missionId)).toEqual(['two', 'one'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
