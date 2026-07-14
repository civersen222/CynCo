// Task Homeostat core (STATE-AND-VISION Phase 4b/4c; prior art in VI.3).
//
// taskError: fraction of unmet (pending|failed) assertions on the global
// contract, over the countable (non-skipped) assertions. Computed here, by
// the governor, from contract state — NEVER by asking the executing model
// for a mid-run self-estimate (RePro: online progress prompting is
// counterproductive; VI.3 hard rule (a)).
//
// errorTrend: CUSUM alarm state over the taskError series (deviation from an
// EMA baseline). CUSUM-on-task-error is the novel piece of the thesis —
// the per-turn series lands in the ledger so Phase 3 can measure whether it
// out-discriminates the activity signals.
//
// null semantics: no active contract / nothing countable → taskError null,
// errorTrend null, and the CUSUM is NOT fed — absence of a contract is not
// zero error.

import { metrics } from '../cybernetics-core/src/index.js'
import { globalContract } from '../tools/contract.js'
import type { ContractSnapshot } from '../tools/contract.js'

const CUSUM_THRESHOLD = 0.5
const CUSUM_SLACK = 0.05
const EMA_ALPHA = 0.3

export type TaskErrorSnapshot = {
  /** Unmet-assertion fraction in [0,1], or null when nothing is countable. */
  taskError: number | null
  /** CUSUM alarm state over the series; null when taskError is null. */
  errorTrend: 'rising' | 'falling' | 'flat' | null
}

export class TaskModel {
  private readonly getContract: () => ContractSnapshot
  private readonly cusum: InstanceType<typeof metrics.CusumDetector>
  private ema: number | null = null
  private last: TaskErrorSnapshot = { taskError: null, errorTrend: null }

  constructor(getContract: () => ContractSnapshot = () => globalContract.snapshot()) {
    this.getContract = getContract
    this.cusum = new metrics.CusumDetector(CUSUM_THRESHOLD, CUSUM_SLACK)
  }

  /** Seal the turn: read the contract, compute error, feed the CUSUM. */
  onTurnComplete(): void {
    const error = this.computeError(this.getContract())
    if (error === null) {
      this.last = { taskError: null, errorTrend: null }
      return
    }
    if (this.ema === null) this.ema = error // seed: first deviation is 0
    const alarm = this.cusum.update(error - this.ema)
    const errorTrend = alarm
      ? (this.cusum.upper() >= this.cusum.lower() ? 'rising' as const : 'falling' as const)
      : 'flat' as const
    this.ema = this.ema + EMA_ALPHA * (error - this.ema)
    this.last = { taskError: error, errorTrend }
  }

  /** Last sealed values — what the report/ledger/S5 see for this turn. */
  snapshot(): TaskErrorSnapshot {
    return { ...this.last }
  }

  private computeError(contract: ContractSnapshot): number | null {
    if (!contract.active) return null
    const countable = contract.assertions.filter(a => a.status !== 'skipped')
    if (countable.length === 0) return null
    const unmet = countable.filter(a => a.status === 'pending' || a.status === 'failed').length
    return unmet / countable.length
  }
}
