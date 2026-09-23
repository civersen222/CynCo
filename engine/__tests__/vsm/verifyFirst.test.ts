/**
 * The verify-first router, as a pure object.
 *
 * Phase 2b-ii gives the gate ladder a second verb. Until now the only thing the
 * mission invariants could do with a call was DENY it; a denial has exactly the
 * variety of the command it refuses (Ashby) but it says nothing about the state
 * of the tree the model is trying to act on. "Verify first" is the second verb:
 * run KEEP-GREEN, then answer — before a revert refusal (so the refusal is
 * informed) and after a low-confidence source edit (so the edit is measured).
 *
 * Everything here is about the parts that must hold whether or not a command
 * ever runs: the budget, the cache, the low-confidence rule, and the outcome
 * record. `verifyFirstWiring.test.ts` is the proof that the real loop calls it.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  VerifyFirstRouter,
  DEFAULT_VERIFY_BUDGET,
  DEFAULT_COOLDOWN_CALLS,
  ENTROPY_FLOOR,
  DIGEST_MIN_SAMPLES,
  ENTRY_WINDOW,
  type VerifyRun,
} from '../../vsm/verifyFirst.js'

function runner(result: Partial<VerifyRun> = {}) {
  return vi.fn(async (): Promise<VerifyRun> => ({ outcome: 'passed', ms: 12, tail: 'ok', ...result }))
}

describe('VerifyFirstRouter — budget', () => {
  it('spends one unit per real run and refuses past the budget without calling run', async () => {
    const run = runner()
    const r = new VerifyFirstRouter({ run, budget: 2, cooldownCalls: 0 })
    const a = await r.verify('/w', 1, 'revert', 0.2)
    const b = await r.verify('/w', 2, 'revert', 0.2)
    const c = await r.verify('/w', 3, 'revert', 0.2)
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['passed', 'passed', 'budget-exhausted'])
    expect(run).toHaveBeenCalledTimes(2)
    expect(c.ms).toBe(0)
    expect(c.tail).toBe('')
    expect(r.snapshot().used).toBe(2)
  })

  it('defaults to a budget of 6 and a 5-call cooldown', () => {
    const r = new VerifyFirstRouter({ run: runner() })
    expect(r.snapshot().budget).toBe(DEFAULT_VERIFY_BUDGET)
    expect(DEFAULT_VERIFY_BUDGET).toBe(6)
    expect(DEFAULT_COOLDOWN_CALLS).toBe(5)
  })

  it('a timeout and an unrunnable command still spend the budget and are recorded', async () => {
    const r1 = new VerifyFirstRouter({ run: runner({ outcome: 'timeout', ms: 300000, tail: '' }), budget: 6, cooldownCalls: 5 })
    const t = await r1.verify('/w', 1, 'revert', null)
    expect(t.outcome).toBe('timeout')
    expect(r1.snapshot().used).toBe(1)
    expect(r1.snapshot().byOutcome.timeout).toBe(1)

    const r2 = new VerifyFirstRouter({ run: runner({ outcome: 'unrunnable', ms: 4, tail: '' }), budget: 6, cooldownCalls: 5 })
    const u = await r2.verify('/w', 1, 'revert', null)
    expect(u.outcome).toBe('unrunnable')
    expect(r2.snapshot().used).toBe(1)
  })

  it('never caches an answer the command did not give', async () => {
    const run = runner({ outcome: 'timeout', ms: 1, tail: '' })
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    await r.verify('/w', 1, 'revert', null)
    const again = await r.verify('/w', 2, 'revert', null)
    expect(again.outcome).toBe('timeout')
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('VerifyFirstRouter — cache', () => {
  it('serves a result younger than the cooldown without running the command again', async () => {
    const run = runner({ outcome: 'passed', ms: 40, tail: 'green' })
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    await r.verify('/w', 10, 'revert', null)
    const cached = await r.verify('/w', 14, 'low-confidence-edit', 1.4)
    expect(cached.outcome).toBe('cached-passed')
    // The measurement is the one that ran; a cached entry quotes it rather than
    // inventing a fresh duration.
    expect(cached.ms).toBe(40)
    expect(cached.tail).toBe('green')
    expect(run).toHaveBeenCalledTimes(1)
    // A cached answer costs nothing, so it costs no budget either.
    expect(r.snapshot().used).toBe(1)
  })

  it('caches a red answer as cached-failed', async () => {
    const run = runner({ outcome: 'failed', ms: 9, tail: 'E   assert 1 == 2' })
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    await r.verify('/w', 1, 'revert', null)
    expect((await r.verify('/w', 2, 'revert', null)).outcome).toBe('cached-failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('expires the cache after cooldownCalls tool calls', async () => {
    const run = runner()
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    await r.verify('/w', 10, 'revert', null)
    expect((await r.verify('/w', 14, 'revert', null)).outcome).toBe('cached-passed')
    expect((await r.verify('/w', 15, 'revert', null)).outcome).toBe('passed')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a source edit invalidates the cache — the tree it described is gone', async () => {
    const run = runner()
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    await r.verify('/w', 1, 'revert', null)
    r.observeCall('inspect', 2)
    expect((await r.verify('/w', 3, 'revert', null)).outcome).toBe('cached-passed')
    r.observeCall('sourceEdit', 4)
    expect((await r.verify('/w', 5, 'revert', null)).outcome).toBe('passed')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('serves the cache even after the budget is spent — a cached answer costs nothing', async () => {
    const run = runner()
    const r = new VerifyFirstRouter({ run, budget: 1, cooldownCalls: 5 })
    await r.verify('/w', 1, 'revert', null)
    expect((await r.verify('/w', 2, 'revert', null)).outcome).toBe('cached-passed')
    expect((await r.verify('/w', 9, 'revert', null)).outcome).toBe('budget-exhausted')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('VerifyFirstRouter — isLowConfidence', () => {
  const r = new VerifyFirstRouter({ run: runner() })

  it('is false when there is no entropy reading at all', () => {
    expect(r.isLowConfidence(null, null)).toBe(false)
    expect(r.isLowConfidence(Number.NaN, null)).toBe(false)
  })

  it('under DIGEST_MIN_SAMPLES samples it is the flat floor, not a two-sample sigma', () => {
    expect(DIGEST_MIN_SAMPLES).toBe(8)
    expect(ENTROPY_FLOOR).toBe(1.0)
    expect(r.isLowConfidence(1.2, null)).toBe(true)
    expect(r.isLowConfidence(0.9, null)).toBe(false)
    // n present but below the floor: same rule, and NOT the digest's sigma.
    expect(r.isLowConfidence(1.2, { mean: 0.1, max: 0.2, spikeCount: 0, n: 3, sd: 0.01 })).toBe(true)
    expect(r.isLowConfidence(0.9, { mean: 0.1, max: 0.2, spikeCount: 0, n: 3, sd: 0.01 })).toBe(false)
  })

  it('at or above DIGEST_MIN_SAMPLES it is mean + 2 sigma, using the digest sigma when it carries one', () => {
    const d = { mean: 0.2, max: 2.0, spikeCount: 1, n: 10, sd: 0.3 }
    // threshold = 0.2 + 0.6 = 0.8
    expect(r.isLowConfidence(0.81, d)).toBe(true)
    expect(r.isLowConfidence(0.79, d)).toBe(false)
    // Below the flat floor in absolute terms, but a spike for THIS call: still
    // low confidence — the rule is relative to the call the token came from.
    expect(r.isLowConfidence(0.85, d)).toBe(true)
  })

  it('falls back to (max - mean) / 2 for sigma when the digest carries none', () => {
    const d = { mean: 0.2, max: 1.2, spikeCount: 1, n: 10 }
    // sigma = (1.2 - 0.2) / 2 = 0.5; threshold = 0.2 + 1.0 = 1.2
    expect(r.isLowConfidence(1.25, d)).toBe(true)
    expect(r.isLowConfidence(1.15, d)).toBe(false)
  })

  it('a perfectly calm call is never low confidence (strict >, sigma 0)', () => {
    const d = { mean: 0.0001, max: 0.0001, spikeCount: 0, n: 12, sd: 0 }
    expect(r.isLowConfidence(0.0001, d)).toBe(false)
  })
})

describe('VerifyFirstRouter — outcome record', () => {
  it('fills nextCallClass from the NEXT observed call, never the call that routed', async () => {
    const r = new VerifyFirstRouter({ run: runner(), budget: 6, cooldownCalls: 0 })
    await r.verify('/w', 7, 'revert', 0.3)
    // The routed call's own accounting must not close its own entry.
    r.observeCall('denied-or-error', 7)
    expect(r.snapshot().entries[0].nextCallClass).toBeNull()
    r.observeCall('sourceEdit', 8)
    expect(r.snapshot().entries[0].nextCallClass).toBe('sourceEdit')
    // Already closed: a later call must not overwrite it.
    r.observeCall('inspect', 9)
    expect(r.snapshot().entries[0].nextCallClass).toBe('sourceEdit')
  })

  it('closes the OLDEST open entry first', async () => {
    const r = new VerifyFirstRouter({ run: runner(), budget: 6, cooldownCalls: 0 })
    await r.verify('/w', 1, 'revert', null)
    await r.verify('/w', 2, 'low-confidence-edit', 2.0)
    r.observeCall('inspect', 3)
    const e = r.snapshot().entries
    expect(e[0].nextCallClass).toBe('inspect')
    expect(e[1].nextCallClass).toBeNull()
  })

  it('records kind, entropy, ms and tail on the entry', async () => {
    const r = new VerifyFirstRouter({ run: runner({ outcome: 'failed', ms: 1234, tail: 'FAILED tests/a.py::t' }), budget: 6, cooldownCalls: 0 })
    const entry = await r.verify('/w', 42, 'low-confidence-edit', 1.75)
    expect(entry).toMatchObject({
      callIndex: 42, kind: 'low-confidence-edit', entropy: 1.75,
      outcome: 'failed', ms: 1234, tail: 'FAILED tests/a.py::t', nextCallClass: null,
    })
  })

  it('windows entries to the last 20 while counting every route', async () => {
    const r = new VerifyFirstRouter({ run: runner(), budget: 3, cooldownCalls: 0 })
    for (let i = 1; i <= 25; i++) await r.verify('/w', i, i % 2 === 0 ? 'revert' : 'low-confidence-edit', null)
    const s = r.snapshot()
    expect(ENTRY_WINDOW).toBe(20)
    expect(s.entries).toHaveLength(20)
    expect(s.entries[0].callIndex).toBe(6)
    expect(s.entries[19].callIndex).toBe(25)
    expect(s.count).toBe(25)
    expect(s.byKind).toEqual({ revert: 12, 'low-confidence-edit': 13 })
    expect(s.byOutcome.passed).toBe(3)
    expect(s.byOutcome['budget-exhausted']).toBe(22)
    // Every outcome key is present, so a ledger row says "zero", not "absent".
    expect(Object.keys(s.byOutcome).sort()).toEqual(
      ['budget-exhausted', 'cached-failed', 'cached-passed', 'failed', 'passed', 'timeout', 'unrunnable'])
    expect(s.used).toBe(3)
  })

  it('snapshot entries are copies — a caller cannot rewrite the record', async () => {
    const r = new VerifyFirstRouter({ run: runner(), budget: 6, cooldownCalls: 0 })
    await r.verify('/w', 1, 'revert', null)
    const s = r.snapshot()
    s.entries[0].outcome = 'failed'
    s.byOutcome.passed = 99
    expect(r.snapshot().entries[0].outcome).toBe('passed')
    expect(r.snapshot().byOutcome.passed).toBe(1)
  })

  it('a run that throws is recorded as unrunnable rather than taking the turn down', async () => {
    const run = vi.fn(async (): Promise<VerifyRun> => { throw new Error('spawn ENOENT') })
    const r = new VerifyFirstRouter({ run, budget: 6, cooldownCalls: 5 })
    const e = await r.verify('/w', 1, 'revert', null)
    expect(e.outcome).toBe('unrunnable')
    expect(e.tail).toContain('spawn ENOENT')
  })
})
