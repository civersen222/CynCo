import { constraints } from '../cybernetics-core/src/index.js'

const SESSION_PURPOSE = new constraints.PurposeModel([
  ['tool_success', 0.85],
  ['tool_error', 0.1],
  ['idle', 0.05],
])

export interface SessionRecord {
  toolsUsed: string[]
  toolErrors: number
  toolSuccesses: number
  userMessagesHandled: number
  governanceSignalsInjected: number
  killSwitchTriggered: boolean
  parametersModified: string[]
  metaBoundsWidened: boolean
}

export type InvariantClass = 'tool_safety' | 'user_authority' | 'measurement_integrity'

export interface GuardResult {
  passed: boolean
  violations: InvariantClass[]
  posiwidPass: boolean
  details: string[]
}

export class IdentityGuard {
  evaluate(record: SessionRecord): GuardResult {
    const violations: InvariantClass[] = []
    const details: string[] = []
    if (record.metaBoundsWidened) {
      violations.push('measurement_integrity')
      details.push('Meta-bounds were widened — system cannot modify its own viability definition beyond meta-bounds')
    }
    const posiwidPass = this.posiwidCheck(record)
    if (!posiwidPass) details.push('POSIWID: observed behavior diverges from stated purpose')
    return { passed: violations.length === 0, violations, posiwidPass, details }
  }

  private posiwidCheck(record: SessionRecord): boolean {
    const idle = record.toolsUsed.length === 0 ? Math.max(record.userMessagesHandled - 1, 0) * 10 : 0
    const report = constraints.posiwidDivergence(
      SESSION_PURPOSE,
      { counts: [['tool_success', record.toolSuccesses], ['tool_error', record.toolErrors], ['idle', idle]] },
      0.5, 6,
    )
    if (report.verdict === 'Insufficient') return true
    // A `Contradicted` verdict always fails. Beyond that, two checks are explicit
    // because the divergence verdict alone does not catch them:
    //
    //  - Idle dominance (no tools used across multiple messages): idle's 0.05 stated
    //    share is above the 0.01 contradiction floor, so such a session only reads as
    //    `Drifting`. Dominance (>50% of observed mass) is the right test here — any
    //    idle-dominant session is the failure this guard exists to catch.
    //  - The legacy "80% errors" rule. Error dominance is NOT that rule: dominance is
    //    >50%, so a 4-error/2-success session (67% errors) would newly fail where it
    //    passed before. The old threshold is therefore written out literally below
    //    rather than approximated by `dominantObserved === 'tool_error'`.
    if (report.verdict === 'Contradicted') return false
    if (report.dominantObserved === 'idle') return false
    const toolCalls = record.toolErrors + record.toolSuccesses
    if (toolCalls > 5 && record.toolErrors / toolCalls > 0.8) return false
    return true
  }
}
