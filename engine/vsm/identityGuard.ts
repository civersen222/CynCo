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
    // An error-dominant session is `Drifting` under a 0.1 stated share, not `Contradicted`
    // (its stated share is above the 0.01 contradiction floor), so the dominant check is
    // explicit rather than relying on the verdict alone — this preserves the old "80% errors"
    // behaviour. The same reasoning applies to an idle-dominant session (no tools used across
    // multiple messages): its 0.05 stated share also keeps the verdict at `Drifting`, so the
    // dominant check is extended to `idle` too, preserving the old "no tools, multi-message"
    // failure this guard is meant to catch.
    if (report.verdict === 'Contradicted') return false
    return report.dominantObserved !== 'tool_error' && report.dominantObserved !== 'idle'
  }
}
