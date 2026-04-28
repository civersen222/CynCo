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
    if (record.toolsUsed.length === 0 && record.userMessagesHandled > 1) return false
    const total = record.toolErrors + record.toolSuccesses
    if (total > 5 && record.toolErrors / total > 0.8) return false
    return true
  }
}
