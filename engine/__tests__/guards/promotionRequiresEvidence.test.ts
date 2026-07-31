/**
 * The AWM promotion gate must ask for evidence, not for the absence of a
 * disaster.
 *
 * Before this guard, `main.ts` derived a session outcome of 'viable' unless the
 * session had stalled five turns or dropped below a 50% tool success rate, and
 * `promoteSessionLearnings` promoted on 'viable'. A session that opened no
 * contract, ran no test and made no commit cleared both thresholds, so every
 * learning it had invented went into the durable playbook and was recalled into
 * later sessions as though it had been earned. The README and the code comment
 * both described that as "ledger-verified"; nothing consulted a ledger, and the
 * continuity ledger has no verification field to consult — `LedgerEntry` is
 * `{date, focus, handoff?}`.
 *
 * Four things are checked here:
 *   1. the decision function refuses without positive evidence,
 *   2. a failed contract is not evidence (the audit's named case),
 *   3. `ContractState.create` files the outgoing contract's verdict, so a
 *      session's earlier failures are still visible at shutdown, and
 *   4. `main.ts` still routes promotion through the decision, and the README no
 *      longer claims the verification it does not perform.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  promotionDecision,
  sessionContracts,
  verdictOf,
  type ContractVerdict,
} from '../../memory/promotionGate.js'
import { globalContract } from '../../tools/contract.js'
import { LearningStore, promoteSessionLearnings } from '../../memory/learningStore.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf-8')

/** A contract that resolved cleanly: n assertions, all passed. */
function clean(n = 2, origin: 'auto' | 'harness' = 'auto'): ContractVerdict {
  return { origin, assertions: n, passed: n, failed: 0, pending: 0 }
}

describe('AWM promotion requires positive evidence', () => {
  beforeEach(() => {
    sessionContracts.reset()
    globalContract.clear()
  })

  it('refuses a session that opened no contract at all', () => {
    const d = promotionDecision({ outcome: 'viable', contracts: [] })
    expect(
      d.promote,
      'a session that stated no criteria and verified nothing promoted its learnings ' +
        'into long-term memory purely because it had not visibly fallen over',
    ).toBe(false)
    expect(d.reason).toContain('no contract')
  })

  it('refuses a session whose contract failed', () => {
    const d = promotionDecision({
      outcome: 'viable',
      contracts: [{ origin: 'harness', assertions: 3, passed: 2, failed: 1, pending: 0 }],
    })
    expect(d.promote).toBe(false)
    expect(d.reason).toContain('1 failed')
  })

  it('refuses a session whose contract was never verified', () => {
    // `resolveUnverified` turns pending into failed when the enforcement budget
    // runs out, but a session can also end mid-task with assertions still
    // pending. Unverified is not passed.
    const d = promotionDecision({
      outcome: 'viable',
      contracts: [{ origin: 'auto', assertions: 2, passed: 1, failed: 0, pending: 1 }],
    })
    expect(d.promote).toBe(false)
    expect(d.reason).toContain('1 never verified')
  })

  it('refuses a complete contract whose every assertion was skipped', () => {
    // `isComplete()` counts 'skipped' as resolved — correct for letting the
    // model stop, wrong for calling the result evidence. Nothing was checked.
    const d = promotionDecision({
      outcome: 'viable',
      contracts: [{ origin: 'auto', assertions: 4, passed: 0, failed: 0, pending: 0 }],
    })
    expect(d.promote).toBe(false)
    expect(d.reason).toContain('skipped')
  })

  it('refuses on a non-viable or marginal outcome even with a clean contract', () => {
    expect(promotionDecision({ outcome: 'non-viable', contracts: [clean()] }).promote).toBe(false)
    expect(promotionDecision({ outcome: 'marginal', contracts: [clean()] }).promote).toBe(false)
  })

  it('promotes when the session resolved its contracts with passed assertions', () => {
    // The gate must not be unconditionally closed: a guard that refuses
    // everything would pass every test above and break the feature.
    const d = promotionDecision({ outcome: 'viable', contracts: [clean(3, 'harness'), clean(2)] })
    expect(d.promote).toBe(true)
    expect(d.reason).toContain('5 assertion(s) passed')
  })

  it('one failed contract poisons the session even when the last one is clean', () => {
    const d = promotionDecision({
      outcome: 'viable',
      contracts: [{ origin: 'auto', assertions: 2, passed: 0, failed: 2, pending: 0 }, clean()],
    })
    expect(
      d.promote,
      'promotion is decided once for the whole session, so a trivial final task must not ' +
        'launder the learnings of the failed tasks before it',
    ).toBe(false)
  })

  it('creating a new contract files the outgoing one, so earlier tasks stay visible', () => {
    globalContract.create('task one', '', ['a', 'b'])
    globalContract.assertPass(0)
    globalContract.assertFail(1, 'could not')
    expect(sessionContracts.all()).toHaveLength(0)

    globalContract.create('task two', '', ['c'])
    const filed = sessionContracts.all()
    expect(filed).toHaveLength(1)
    expect(filed[0]).toEqual({ origin: 'auto', assertions: 2, passed: 1, failed: 1, pending: 0 })

    // And the live contract is read separately, so shutdown sees both.
    const all = [...filed, verdictOf(globalContract.snapshot())]
    expect(all).toHaveLength(2)
    expect(promotionDecision({ outcome: 'viable', contracts: all }).promote).toBe(false)
  })

  it('a contract resolved as unverified is still filed', () => {
    // `resolveUnverified` sets active=false. Filing only active contracts would
    // drop exactly the case that matters most: the task whose enforcement
    // budget ran out with the work never verified.
    globalContract.create('ran out of rounds', '', ['a'])
    globalContract.resolveUnverified()
    expect(globalContract.isActive()).toBe(false)

    globalContract.create('next task', '', ['b'])
    expect(sessionContracts.all()).toEqual([
      { origin: 'auto', assertions: 1, passed: 0, failed: 1, pending: 0 },
    ])
  })

  it('a skipped assertion is counted as skipped, not as passed', () => {
    // The counting is where "nothing was verified" is decided. If verdictOf
    // folded 'skipped' into 'passed', a contract the model skipped its way out
    // of would read as a fully verified one and the skip clause above would
    // never fire.
    globalContract.create('skipped its way out', '', ['a', 'b'])
    globalContract.assertSkip(0, 'not applicable')
    globalContract.assertSkip(1, 'not applicable')
    expect(globalContract.isComplete(), 'a wholly skipped contract is still "complete"').toBe(true)

    const v = verdictOf(globalContract.snapshot())
    expect(v).toEqual({ origin: 'auto', assertions: 2, passed: 0, failed: 0, pending: 0 })
    expect(promotionDecision({ outcome: 'viable', contracts: [v] }).promote).toBe(false)
  })

  it('the store promotes nothing when the decision says no', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'invented', sessionId: 's' })
    const d = promotionDecision({ outcome: 'viable', contracts: [] })
    expect(promoteSessionLearnings(store, 's', d)).toBe(0)
    expect(store.allIncludingInvalidated()[0]!.promoted).toBe(0)
    store.close()
  })
})

describe('AWM promotion stays wired and honestly described', () => {
  it('main.ts routes promotion through the decision, not through the outcome', () => {
    const main = read('engine/main.ts')
    expect(main).toContain('promotionDecision({ outcome, contracts })')
    expect(main).toContain('promoteSessionLearnings(store, sid, decision)')
    // The pre-fix call, which promoted on the default-pass outcome alone.
    expect(main).not.toContain('promoteSessionLearnings(store, sid, outcome)')
  })

  it('main.ts reads the filed contracts as well as the live one', () => {
    const main = read('engine/main.ts')
    expect(main).toContain('sessionContracts.all()')
    expect(main).toContain('verdictOf(live)')
  })

  it('nothing claims the promotion is "ledger-verified"', () => {
    // The claim named a mechanism that does not exist. `memory/ledger.ts` holds
    // {date, focus, handoff?} and no verification evidence of any kind.
    for (const f of ['README.md', 'engine/main.ts', 'engine/memory/learningStore.ts']) {
      expect(read(f), `${f} still calls the promotion ledger-verified`).not.toContain('ledger-verified')
    }
  })

  it('the ledger really does carry no verification evidence', () => {
    // If someone extends LedgerEntry with a verification field later, the
    // audit's option (a) becomes available and this guard should be revisited
    // rather than silently kept.
    const types = read('engine/memory/types.ts')
    const entry = types.slice(types.indexOf('export type LedgerEntry'))
    const body = entry.slice(0, entry.indexOf('}'))
    expect(body).toContain('date')
    expect(body).toContain('focus')
    expect(body).not.toMatch(/verif|contract|assert/i)
  })
})
