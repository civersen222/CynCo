/**
 * The gate that decides whether a session's learnings enter the durable
 * playbook.
 *
 * It exists because the previous gate was default-pass and its documentation
 * was false. `main.ts` derived an outcome of 'viable' unless the session had
 * stalled five turns or dropped below a 50% tool success rate, and promoted on
 * 'viable'. An ordinary session that accomplished nothing at all — no contract,
 * no test run, no commit — cleared both thresholds and wrote every learning it
 * had produced into long-term memory. The README and the code comment both
 * called that outcome "ledger-verified"; nothing read a ledger, and the
 * continuity ledger (`memory/ledger.ts`) carries no verification evidence to
 * read — its entries are `{date, focus, handoff?}`.
 *
 * So this asks for positive evidence instead of the absence of a red flag. The
 * evidence is the session's contracts: a contract names what the task must
 * satisfy, and its assertions are resolved one by one, with the ones that speak
 * about files and commits checked against the repository rather than taken on
 * the model's word (`tools/contractVerify.ts`).
 *
 * What that evidence is worth depends on the contract's origin, and the gate
 * does not pretend otherwise. A 'harness' contract was written by a person and
 * its command assertions are executed. An 'auto' contract was inferred by the
 * engine from the request, and assertions it cannot check are passed on the
 * model's report. Requiring a complete contract is therefore a floor, not a
 * proof — but it is a floor the do-nothing session does not clear.
 */

import type { SessionOutcome } from './learningStore.js'

/** What became of one contract, reduced to the counts the gate reasons about. */
export type ContractVerdict = {
  origin: 'auto' | 'harness'
  assertions: number
  passed: number
  failed: number
  pending: number
}

/** Reduce a contract (or its snapshot) to a verdict. */
export function verdictOf(contract: {
  getOrigin?: () => 'auto' | 'harness'
  origin?: 'auto' | 'harness'
  assertions: { status: string }[]
}): ContractVerdict {
  const a = contract.assertions
  return {
    origin: contract.getOrigin?.() ?? contract.origin ?? 'auto',
    assertions: a.length,
    passed: a.filter(x => x.status === 'passed').length,
    failed: a.filter(x => x.status === 'failed').length,
    pending: a.filter(x => x.status === 'pending').length,
  }
}

/**
 * Every contract this session has finished with.
 *
 * A session runs many tasks and each one replaces the contract, but promotion
 * is all-or-nothing for the whole session's learnings. Reading only the live
 * contract at shutdown would let a final trivial task launder the learnings of
 * three failed ones, so `ContractState.create` files the outgoing verdict here
 * before overwriting itself, and the gate reads all of them.
 */
class SessionContractLedger {
  private verdicts: ContractVerdict[] = []

  record(v: ContractVerdict): void {
    this.verdicts.push(v)
  }

  all(): ContractVerdict[] {
    return this.verdicts.map(v => ({ ...v }))
  }

  reset(): void {
    this.verdicts = []
  }
}

export const sessionContracts = new SessionContractLedger()

export type PromotionEvidence = {
  outcome: SessionOutcome
  contracts: ContractVerdict[]
}

/**
 * `promote` is the answer; `reason` is what the answer was based on, and is
 * logged either way. A refusal that cannot say what was missing is
 * indistinguishable from a bug.
 */
export type PromotionDecision = {
  promote: boolean
  reason: string
}

export function promotionDecision(evidence: PromotionEvidence): PromotionDecision {
  const { outcome, contracts } = evidence

  // The old thresholds still apply — they are cheap and they catch the session
  // that visibly came apart. They are no longer sufficient on their own.
  if (outcome !== 'viable') {
    return { promote: false, reason: `session outcome is '${outcome}'` }
  }

  if (contracts.length === 0) {
    return {
      promote: false,
      reason: 'no contract was created this session, so nothing states what the work had to satisfy',
    }
  }

  const unresolved = contracts.filter(c => c.failed > 0 || c.pending > 0)
  if (unresolved.length > 0) {
    const failed = unresolved.reduce((n, c) => n + c.failed, 0)
    const pending = unresolved.reduce((n, c) => n + c.pending, 0)
    return {
      promote: false,
      reason:
        `${unresolved.length} of ${contracts.length} contract(s) ended unresolved ` +
        `(${failed} failed, ${pending} never verified)`,
    }
  }

  // Every assertion skipped is a complete contract that verified nothing:
  // `isComplete()` counts 'skipped' as resolved, which is right for letting the
  // model finish and wrong for calling the result evidence.
  const passed = contracts.reduce((n, c) => n + c.passed, 0)
  if (passed === 0) {
    return {
      promote: false,
      reason: `every assertion across ${contracts.length} contract(s) was skipped — nothing was verified`,
    }
  }

  const harness = contracts.filter(c => c.origin === 'harness').length
  return {
    promote: true,
    reason:
      `${contracts.length} contract(s) resolved, ${passed} assertion(s) passed ` +
      `(${harness} contract(s) written by a person, ${contracts.length - harness} inferred by the engine)`,
  }
}
