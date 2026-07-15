// engine/vsm/regulatorFidelity.ts
// P4.3 (STATE doc Phase 4(e)): regulator fidelity per session — did the
// contract assertions predict the actual work? Answered via a composite struct
// (not an opaque score) so falsification analysis can see WHY a session scored
// low. Session-scoped; measurement only — never plumbed to S5Input (S5 is
// per-turn; fidelity is only known at session end).
//
// Components:
//   hadContract          — was a contract ever active this session
//   resolutionRate       — (passed+failed)/countable of the FINAL contract;
//                          null when countable (total - skipped) is 0
//   finalTaskError       — the governor's last sealed taskError (passed in;
//                          the tracker never re-reads the contract for error)
//   contractReplacements — title rollovers across the session (P4.2 mid-session
//                          contract replacement). active→inactive→active with a
//                          new title counts once.

import type { ContractSnapshot } from '../tools/contract.js'

export type RegulatorFidelity = {
  hadContract: boolean
  resolutionRate: number | null
  finalTaskError: number | null
  contractReplacements: number
}

export class RegulatorFidelityTracker {
  private hadContract = false
  private replacements = 0
  private lastActiveTitle: string | null = null
  private finalSnapshot: ContractSnapshot | null = null

  /** Called each turn seal in the governor's always-track zone. */
  observe(snapshot: ContractSnapshot): void {
    if (snapshot.active) {
      this.hadContract = true
      this.finalSnapshot = snapshot
      if (this.lastActiveTitle !== null && snapshot.title !== this.lastActiveTitle) {
        this.replacements++
      }
      this.lastActiveTitle = snapshot.title
    }
    // inactive turns keep lastActiveTitle so a later active turn with a NEW
    // title (rollover through inactive) still registers as one replacement.
  }

  /** Session-end fidelity; null when no contract was ever active. */
  getFidelity(finalTaskError: number | null): RegulatorFidelity | null {
    if (!this.hadContract || this.finalSnapshot === null) return null
    const assertions = this.finalSnapshot.assertions
    const countable = assertions.filter(a => a.status !== 'skipped').length
    const resolved = assertions.filter(a => a.status === 'passed' || a.status === 'failed').length
    return {
      hadContract: true,
      resolutionRate: countable === 0 ? null : resolved / countable,
      finalTaskError,
      contractReplacements: this.replacements,
    }
  }
}
