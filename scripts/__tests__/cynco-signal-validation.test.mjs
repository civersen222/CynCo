import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fisherExact, wilson, labelOf, rulesFired, readLedger, analyse,
  analyseDenials, invariantsFired, denialVerdict, DENIAL_MIN,
  signalQuartiles, signalsFired,
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
  const base = { outcome: 'landed', verified: true, mutationSweep: { killed: 3, total: 3, survived: [] } }

  it('landed + verified + swept clean is a success', () => {
    expect(labelOf(base)).toBe(true)
  })

  it('a surviving mutation the DoD claimed to own is a FAILURE, not a success', () => {
    // README: success requires "no survivor that a DoD item claimed to own".
    // This clause was missing from labelOf at first and it relabeled 19 of 75
    // real rows — a mission that left eight claimed rules unpinned was being
    // counted as evidence of what a successful mission looks like.
    const leaky = { ...base, mutationSweep: { killed: 2, total: 3, survived: ['W6'] } }
    expect(labelOf(leaky)).toBe(false)
  })

  it('counts every survivor, not just a lone one', () => {
    const leaky = { ...base, mutationSweep: { killed: 0, total: 8, survived: ['X1', 'X2', 'X3'] } }
    expect(labelOf(leaky)).toBe(false)
  })

  it('a DERIVED sweep survivor does not fail the mission, but does label it', () => {
    // scripts/cynco-mutation-sweep.py mutates whatever the diff added, so its
    // survivors are coverage findings rather than unmet DoD claims. A brief
    // that forbids touching the test file would otherwise fail by obeying.
    const derived = {
      ...base,
      mutationSweep: { kind: 'derived', killed: 0, total: 14, survived: ['gilded/ai.py:224:bool->Or'] },
    }
    expect(labelOf(derived)).toBe(true)
  })

  it('a derived sweep cannot rescue a mission that did not land', () => {
    const derived = {
      outcome: 'void-bad-brief', verified: true,
      mutationSweep: { kind: 'derived', killed: 14, total: 14, survived: [] },
    }
    expect(labelOf(derived)).toBe(false)
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

describe('invariantsFired', () => {
  it('names the invariants that denied at least once', () => {
    expect([...invariantsFired({ invariants: { denialsByInvariant: { 'edit-gap': 3, 'commit-gap': 0, revert: 1 } } })].sort()).toEqual(['edit-gap', 'revert'])
    expect(invariantsFired({ invariants: null }).size).toBe(0)
    expect(invariantsFired({}).size).toBe(0)
  })
})

describe('analyseDenials', () => {
  const summary = (denials, quiet) => ({ denials, quiet })
  const base = { 'commit-gap': { denials: 0, complied: 0, changed: 0 }, revert: { denials: 5, complied: 5, changed: 0 } }
  const quietBase = { 'commit-gap': { calls: 1000, complied: 10 }, revert: { calls: 1000, complied: 1000 } }

  it('is TOO FEW under the 30-denial floor and never invents a p-value there', () => {
    const r = analyseDenials(summary({ ...base, 'edit-gap': { denials: 12, complied: 10, changed: 11 } }, { ...quietBase, 'edit-gap': { calls: 1000, complied: 200 } }))
    const e = r.invariants.find(x => x.invariant === 'edit-gap')
    expect(e.verdict).toBe('TOO FEW'); expect(e.p).toBeNull(); expect(e.compliedRate).toBeCloseTo(10 / 12, 6)
    expect(DENIAL_MIN).toBe(30)
  })
  it('is EFFECTIVE when denials are followed by compliance far above the quiet rate', () => {
    const r = analyseDenials(summary({ ...base, 'edit-gap': { denials: 60, complied: 50, changed: 55 } }, { ...quietBase, 'edit-gap': { calls: 1000, complied: 200 } }))
    const e = r.invariants.find(x => x.invariant === 'edit-gap')
    expect(e.verdict).toBe('EFFECTIVE'); expect(e.baseRate).toBeCloseTo(0.2, 6); expect(e.pAdjusted).toBeLessThan(0.05); expect(e.ci[0]).toBeGreaterThan(0.2)
  })
  it('is INERT when denials are followed by compliance far below the quiet rate', () => {
    const r = analyseDenials(summary({ ...base, 'edit-gap': { denials: 80, complied: 2, changed: 3 } }, { ...quietBase, 'edit-gap': { calls: 1000, complied: 300 } }))
    const e = r.invariants.find(x => x.invariant === 'edit-gap')
    expect(e.verdict).toBe('INERT'); expect(e.ci[1]).toBeLessThan(0.3)
  })
  it('is NO EVIDENCE when the rates are indistinguishable', () => {
    const r = analyseDenials(summary({ ...base, 'edit-gap': { denials: 40, complied: 9, changed: 12 } }, { ...quietBase, 'edit-gap': { calls: 1000, complied: 220 } }))
    expect(r.invariants.find(x => x.invariant === 'edit-gap').verdict).toBe('NO EVIDENCE')
  })
  it('reports revert as IDENTITY regardless of numbers, and Holm-corrects across the caps only', () => {
    const r = analyseDenials(summary({ 'edit-gap': { denials: 80, complied: 2, changed: 3 }, 'commit-gap': { denials: 80, complied: 1, changed: 2 }, revert: { denials: 50, complied: 50, changed: 0 } },
      { 'edit-gap': { calls: 1000, complied: 300 }, 'commit-gap': { calls: 1000, complied: 100 }, revert: { calls: 1000, complied: 1000 } }))
    const rev = r.invariants.find(x => x.invariant === 'revert')
    expect(rev.verdict).toBe('IDENTITY'); expect(rev.p).toBeNull()
    const caps = r.invariants.filter(x => x.invariant !== 'revert')
    expect(caps.every(x => x.pAdjusted >= x.p)).toBe(true)
  })
  it('a missing summary block reads as zero denials', () => {
    const r = analyseDenials({ denials: {}, quiet: {} })
    expect(r.invariants.map(x => [x.invariant, x.denials, x.verdict])).toEqual([['edit-gap', 0, 'TOO FEW'], ['commit-gap', 0, 'TOO FEW'], ['revert', 0, 'IDENTITY']])
  })
})

describe('analyse with a custom firedOf', () => {
  it('treats invariants as rules at the mission level', () => {
    const labeled = (invariants, verified) => ({ outcome: 'landed', verified, mutationSweep: { kind: 'derived', survived: [] }, invariants, s5Decisions: [] })
    const rows = [
      labeled({ denialsByInvariant: { 'edit-gap': 2, 'commit-gap': 0, revert: 0 } }, false),
      labeled({ denialsByInvariant: { 'edit-gap': 0, 'commit-gap': 0, revert: 0 } }, true),
      labeled(null, true),
    ]
    const res = analyse(rows, { firedOf: invariantsFired })
    expect(res.rules.map(r => r.id)).toEqual(['edit-gap'])
    expect(res.rules[0]).toMatchObject({ firedTotal: 1, labeled: 1, failures: 1 })
    // default path unchanged: no S5 rules fired anywhere → no rules
    expect(analyse(rows).rules).toEqual([])
  })
})

// M8: the S5 path had no golden. Every other test here pins one number at a
// time, so a change to the table's SHAPE — a renamed field, a dropped
// pAdjusted, a reordered rules array — passes them all. This pins the whole
// object, byte for byte, and pins the default `firedOf` to `rulesFired` at the
// same time: the two calls must be the same call.
describe('analyse — the S5 golden table', () => {
  const m = (ruleIds, verified) => ({ outcome: 'landed', verified, mutationSweep: { kind: 'derived', survived: [] }, s5Decisions: ruleIds.length ? [{ ruleIds }] : [] })
  // Six labeled missions, two rules. `no-test-no-land` fires on 3 (2 failed),
  // `commit-before-edit` on 2 (0 failed), and one failed mission fires neither.
  const rows = [
    m(['no-test-no-land'], false),
    m(['no-test-no-land'], false),
    m(['no-test-no-land'], true),
    m(['commit-before-edit'], true),
    m(['commit-before-edit'], true),
    m([], false),
  ]
  const EXPECTED = {
    total: 6, labeled: 6, failures: 3, base: 0.5, rulesTested: 2,
    rules: [
      { id: 'no-test-no-land', firedTotal: 3, labeled: 3, failures: 2, precision: 0.6666666666666666,
        ci: [0.20765495512648788, 0.9385096847238393], lift: 0.16666666666666663,
        p: 0.9999999999999961, coverage: 0.5, pAdjusted: 0.9999999999999961 },
      { id: 'commit-before-edit', firedTotal: 2, labeled: 2, failures: 0, precision: 0,
        ci: [0, 0.6576280471103807], lift: -0.5,
        p: 0.39999999999999836, coverage: 0.3333333333333333, pAdjusted: 0.7999999999999967 },
    ],
  }

  it('produces the checked-in table, and the default firedOf IS rulesFired', () => {
    expect(JSON.stringify(analyse(rows))).toBe(JSON.stringify(analyse(rows, { firedOf: rulesFired })))
    expect(JSON.stringify(analyse(rows))).toBe(JSON.stringify(EXPECTED))
  })
})

// Task 4 (2a-iii): the Brain's telemetry (turns[].brain / row.brainStats,
// scripts/cynco-ledger.mjs) is a CANDIDATE signal, not yet a rule. This is
// step 2's own question — does it predict failure? — asked of two quartile
// cuts on the two continuous readings the brain produces: layer-convergence
// agreement (low = the probed layers disagreed; high = they agreed a lot) and
// tool-token entropy (high = the model was uncertain about which tool to
// call). Thresholds live ONLY here, never in the engine or the ledger.
describe('signalQuartiles', () => {
  const bs = (meanAgree, meanToolEntropy) => ({
    tier: 'live', turnsWithLens: 3, meanAgree, meanDepth: 0.5, meanToolEntropy,
  })
  const row = (id, meanAgree, meanToolEntropy, verified = true) => ({
    missionId: id, outcome: 'landed', verified, mutationSweep: { kind: 'derived', survived: [] },
    s5Decisions: [], brainStats: bs(meanAgree, meanToolEntropy),
  })

  // 8 labeled rows, agree spread 0.1..0.8 in steps of 0.1, entropy 0.2..0.9 in
  // steps of 0.1 — both already sorted, so the nearest-rank picks are easy to
  // hand-check: rank = ceil(p * n), 1-indexed into the sorted array.
  // agree:   [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] -> q1 rank ceil(2)=2 -> 0.2, q3 rank ceil(6)=6 -> 0.6
  // entropy: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] -> q1 -> 0.3, q3 -> 0.7
  const rows = [
    row('a', 0.1, 0.2), row('b', 0.2, 0.3), row('c', 0.3, 0.4), row('d', 0.4, 0.5),
    row('e', 0.5, 0.6), row('f', 0.6, 0.7), row('g', 0.7, 0.8), row('h', 0.8, 0.9),
  ]

  it('returns the nearest-rank 25th/75th percentile over labeled rows with brainStats', () => {
    expect(signalQuartiles(rows)).toEqual({ agree: [0.2, 0.6], entropy: [0.3, 0.7] })
  })

  it('excludes unlabeled rows and rows with no brainStats from the quartile computation', () => {
    const withNoise = [
      ...rows,
      { ...row('unlabeled', 0.01, 0.01), verified: null },       // unlabeled: must not pull the quartiles down
      { missionId: 'no-brain', outcome: 'landed', verified: true, mutationSweep: { kind: 'derived', survived: [] }, s5Decisions: [] }, // labeled, no brainStats
    ]
    expect(signalQuartiles(withNoise)).toEqual({ agree: [0.2, 0.6], entropy: [0.3, 0.7] })
  })
})

describe('signalsFired', () => {
  const q = { agree: [0.2, 0.6], entropy: [0.3, 0.7] }

  it('fires LC-low at/below q1 of agreement', () => {
    expect([...signalsFired({ brainStats: { meanAgree: 0.2, meanToolEntropy: 0.5 } }, q)]).toContain('LC-low')
    expect([...signalsFired({ brainStats: { meanAgree: 0.1, meanToolEntropy: 0.5 } }, q)]).toContain('LC-low')
    expect([...signalsFired({ brainStats: { meanAgree: 0.3, meanToolEntropy: 0.5 } }, q)]).not.toContain('LC-low')
  })

  it('fires LC-high at/above q3 of agreement', () => {
    expect([...signalsFired({ brainStats: { meanAgree: 0.6, meanToolEntropy: 0.5 } }, q)]).toContain('LC-high')
    expect([...signalsFired({ brainStats: { meanAgree: 0.9, meanToolEntropy: 0.5 } }, q)]).toContain('LC-high')
    expect([...signalsFired({ brainStats: { meanAgree: 0.5, meanToolEntropy: 0.5 } }, q)]).not.toContain('LC-high')
  })

  it('fires TE-high at/above q3 of entropy', () => {
    expect([...signalsFired({ brainStats: { meanAgree: 0.5, meanToolEntropy: 0.7 } }, q)]).toContain('TE-high')
    expect([...signalsFired({ brainStats: { meanAgree: 0.5, meanToolEntropy: 0.2 } }, q)]).not.toContain('TE-high')
  })

  it('a row with no brainStats fires nothing', () => {
    expect(signalsFired({}, q).size).toBe(0)
    expect(signalsFired({ brainStats: null }, q).size).toBe(0)
  })

  it('analyse wired to signalsFired lists exactly the three candidate ids', () => {
    const bs = (meanAgree, meanToolEntropy) => ({ meanAgree, meanDepth: 0.5, meanToolEntropy, tier: 'live', turnsWithLens: 1 })
    const rows = [
      { missionId: 'a', outcome: 'landed', verified: true, mutationSweep: { kind: 'derived', survived: [] }, s5Decisions: [], brainStats: bs(0.1, 0.2) },
      { missionId: 'b', outcome: 'landed', verified: false, mutationSweep: { kind: 'derived', survived: [] }, s5Decisions: [], brainStats: bs(0.9, 0.9) },
      { missionId: 'c', outcome: 'landed', verified: true, mutationSweep: { kind: 'derived', survived: [] }, s5Decisions: [], brainStats: bs(0.5, 0.5) },
    ]
    const quartiles = signalQuartiles(rows)
    const res = analyse(rows, { firedOf: r => signalsFired(r, quartiles) })
    expect(res.rules.map(r => r.id).sort()).toEqual(['LC-high', 'LC-low', 'TE-high'])
  })
})
