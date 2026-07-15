// engine/vsm/progressModel.ts
// P4.3 (STATE doc Phase 4(b), VI.3 signal 5): length-normalized progress —
// failed trajectories run 14–112% longer across three independent studies.
// Per-turn instrumentation: newly-passed DoD assertions per 1k output tokens,
// grounded in the same contract taskError reads (never a model self-estimate).
//
// null semantics: no active contract, or a zero-token turn → null (nothing
// to normalize by; absence of a contract is not zero progress).
//
// Baseline reset: P4.2 rolls contracts over mid-session by design, so a
// title change or a passed-count drop means "new task" — the previous
// passed-count baseline is discarded.

import { globalContract } from '../tools/contract.js'
import type { ContractSnapshot } from '../tools/contract.js'

export type ProgressSnapshot = {
  /** Newly-passed assertions per 1k totalTokens for the last sealed turn;
   *  null when no active contract or no tokens. */
  progressRate: number | null
}

export class ProgressModel {
  private readonly getContract: () => ContractSnapshot
  private lastPassed: number | null = null
  private lastTitle: string | null = null
  private last: ProgressSnapshot = { progressRate: null }

  constructor(getContract: () => ContractSnapshot = () => globalContract.snapshot()) {
    this.getContract = getContract
  }

  /** Seal the turn: diff passed-count against the baseline, normalize by tokens. */
  onTurnComplete(totalTokens: number): void {
    const contract = this.getContract()
    if (!contract.active) {
      this.last = { progressRate: null }
      this.lastPassed = null
      this.lastTitle = null
      return
    }
    const passed = contract.assertions.filter(a => a.status === 'passed').length
    const replaced =
      this.lastTitle !== null && contract.title !== this.lastTitle ||
      this.lastPassed !== null && passed < this.lastPassed
    const baseline = replaced || this.lastPassed === null ? 0 : this.lastPassed
    this.lastPassed = passed
    this.lastTitle = contract.title
    if (totalTokens <= 0) {
      this.last = { progressRate: null }
      return
    }
    const delta = Math.max(0, passed - baseline)
    this.last = { progressRate: (delta / totalTokens) * 1000 }
  }

  /** Last sealed value — what the report/ledger/S5 see for this turn. */
  snapshot(): ProgressSnapshot {
    return { ...this.last }
  }
}
