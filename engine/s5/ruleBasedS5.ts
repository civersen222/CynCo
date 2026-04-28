import type { S5Input, S5Decision, S5Interface } from './types.js'

const MINIMAL_TOOLS = ['Read']
const NO_BASH_TOOLS = ['Read', 'Glob', 'Grep', 'Git', 'Write', 'Edit']

export class RuleBasedS5 implements S5Interface {
  readonly name = 'RuleBasedS5'

  async decide(input: S5Input): Promise<S5Decision> {
    const reasons: string[] = []
    let tools: string[] | null = null
    let contextAction: S5Decision['contextAction'] = 'none'
    let priority: S5Decision['priority'] = 'balanced'
    let revert = false

    // ─── Context pressure rules ────────────────────────────────
    if (input.contextUsagePercent >= 0.9) {
      contextAction = 'warn'
      reasons.push(`context at ${Math.round(input.contextUsagePercent * 100)}% — warning threshold exceeded`)
    } else if (input.contextUsagePercent >= 0.75) {
      contextAction = 'compact'
      reasons.push(`context at ${Math.round(input.contextUsagePercent * 100)}% — compaction recommended`)
    }

    // ─── S3/S4 balance rules ───────────────────────────────────
    if (input.s3s4Balance === 's4_dominant') {
      priority = 's3'
      reasons.push('S4 dominant — boosting S3 operational priority')
    } else if (input.s3s4Balance === 's3_dominant') {
      priority = 's4'
      reasons.push('S3 dominant — boosting S4 intelligence priority')
    } else if (input.s3s4Balance === 'critical') {
      priority = 'balanced'
      reasons.push('S3/S4 balance critical — enforcing balanced mode')
    }

    // ─── Governance status rules ───────────────────────────────
    if (input.governanceStatus === 'halted') {
      tools = MINIMAL_TOOLS
      reasons.push('governance halted — restricting to Read only')
    }
    // Note: 'critical' status injects governance SIGNALS into the system prompt
    // (variety warnings, stuck detection, etc.) but does NOT restrict tools.
    // The model needs all tools to recover from critical states.

    // ─── Recent failure rules ──────────────────────────────────
    const recentFailures = input.recentToolResults.filter(r => !r.success).length
    if (recentFailures >= 3 && tools === null) {
      tools = NO_BASH_TOOLS
      reasons.push(`${recentFailures} recent tool failures — restricting Bash access`)
    }

    // ─── Revert rules ────────────────────────────────────────
    if (input.snapshotAvailable && input.governanceStatus === 'critical' &&
        input.governance && input.governance.stuckTurns >= 5 && input.governance.toolSuccessRate < 0.7) {
      revert = true
      reasons.push('critical + stuck + low tool success — recommending workspace revert to last good state')
    }

    // ─── Default reasoning if no rules fired ─────────────────
    if (reasons.length === 0) {
      reasons.push('all systems nominal — no intervention required')
    }

    return {
      workflow: null,
      advancePhase: null,
      model: null,
      tools,
      contextAction,
      spawnAgent: null,
      priority,
      reasoning: reasons.join('; '),
      revert,
    }
  }
}
