import { randomUUID } from 'crypto'
import type { S5Input, S5Decision, S5Interface, S5Rule } from './types.js'

// ─── Constants ───────────────────────────────────────────────

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Ls']

export const ALL_TOOL_NAMES = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write',
  'Bash', 'Git', 'WebFetch', 'WebSearch', 'ImageView', 'NotebookEdit',
  'MultiEdit', 'ApplyPatch', 'Ls', 'CodeIndex', 'SaveLearning',
  'SubAgent', 'CollectAgent', 'IndexResearch',
]

// ─── Helpers ─────────────────────────────────────────────────

function excludeTools(exclude: string[]): string[] {
  return ALL_TOOL_NAMES.filter(t => !exclude.includes(t))
}

function getFailingTools(results: { tool: string; success: boolean }[], threshold: number): string[] {
  const counts = new Map<string, number>()
  for (const r of results) {
    if (!r.success) {
      counts.set(r.tool, (counts.get(r.tool) || 0) + 1)
    }
  }
  const failing: string[] = []
  for (const [tool, count] of counts) {
    if (count >= threshold) failing.push(tool)
  }
  return failing
}

function getTopToolsBySuccess(results: { tool: string; success: boolean }[], n: number): string[] {
  const successCounts = new Map<string, number>()
  const totalCounts = new Map<string, number>()
  for (const r of results) {
    totalCounts.set(r.tool, (totalCounts.get(r.tool) || 0) + 1)
    if (r.success) {
      successCounts.set(r.tool, (successCounts.get(r.tool) || 0) + 1)
    }
  }
  const tools = [...totalCounts.keys()]
  tools.sort((a, b) => {
    const rateA = (successCounts.get(a) || 0) / (totalCounts.get(a) || 1)
    const rateB = (successCounts.get(b) || 0) / (totalCounts.get(b) || 1)
    return rateB - rateA
  })
  return tools.slice(0, n)
}

// ─── Critical Rules (C1–C6) ─────────────────────────────────

const C1: S5Rule = {
  id: 'C1',
  tier: 'critical',
  name: 'Kill switch — governance halted',
  evaluate(input) {
    if (input.governanceStatus === 'halted') {
      return {
        tools: [...READ_ONLY_TOOLS],
        reasoning: 'governance halted — restricting to read-only tools',
      }
    }
    return null
  },
}

const C2: S5Rule = {
  id: 'C2',
  tier: 'critical',
  name: 'Consecutive failures — exclude failing tool',
  evaluate(input) {
    const failing = getFailingTools(input.recentToolResults, 3)
    if (failing.length > 0) {
      return {
        tools: excludeTools(failing),
        reasoning: `3+ failures in ${failing.join(', ')} — excluding`,
      }
    }
    return null
  },
}

const C3: S5Rule = {
  id: 'C3',
  tier: 'critical',
  name: 'Context overflow — force compact',
  evaluate(input) {
    if (input.contextUsagePercent >= 0.90) {
      return {
        contextAction: 'compact',
        reasoning: `context at ${Math.round(input.contextUsagePercent * 100)}% — compaction required`,
      }
    }
    return null
  },
}

const C4: S5Rule = {
  id: 'C4',
  tier: 'critical',
  name: 'Doom loop — identical consecutive failing calls',
  evaluate(input) {
    const results = input.recentToolResults
    if (results.length < 3) return null
    // Check the last 3 results for identical consecutive failing tool calls
    const last3 = results.slice(-3)
    const allSameTool = last3.every(r => r.tool === last3[0].tool)
    const allFailing = last3.every(r => !r.success)
    if (allSameTool && allFailing) {
      const doomTool = last3[0].tool
      return {
        tools: excludeTools([doomTool]),
        reasoning: `doom loop detected: 3 consecutive failing ${doomTool} calls — excluding`,
      }
    }
    return null
  },
}

const C5: S5Rule = {
  id: 'C5',
  tier: 'critical',
  name: 'GPU exhaustion — block agent spawns',
  evaluate(input) {
    // GPU exhaustion detected via performance health critical + high productivity ratio
    // indicating the system is under heavy load
    if (input.performanceHealth === 'critical' && input.productivityRatio < 0.3) {
      return {
        tools: excludeTools(['SubAgent', 'CollectAgent']),
        spawnAgent: null,
        reasoning: 'GPU exhaustion detected — blocking agent spawns',
      }
    }
    return null
  },
}

const C6: S5Rule = {
  id: 'C6',
  tier: 'critical',
  name: 'Variety critical — restrict to top-5 tools by success',
  evaluate(input) {
    if (input.varietyBalance === 'critical') {
      const topTools = getTopToolsBySuccess(input.recentToolResults, 5)
      // If no tool results, fall back to read-only
      const tools = topTools.length > 0 ? topTools : [...READ_ONLY_TOOLS]
      return {
        tools,
        reasoning: `variety balance critical — restricting to top ${tools.length} tools by success rate`,
      }
    }
    return null
  },
}

// ─── Warning Rules (W1–W7) ──────────────────────────────────

const W1: S5Rule = {
  id: 'W1',
  tier: 'warning',
  name: 'Context pressure — warn',
  evaluate(input) {
    if (input.contextUsagePercent >= 0.75 && input.contextUsagePercent < 0.90) {
      return {
        contextAction: 'warn',
        reasoning: `context at ${Math.round(input.contextUsagePercent * 100)}% — warning threshold`,
      }
    }
    return null
  },
}

const W2: S5Rule = {
  id: 'W2',
  tier: 'warning',
  name: 'Model switch — rising latency with alternatives',
  evaluate(input) {
    if (input.modelLatencyTrend === 'rising' && input.turnCount >= 5 && input.availableModels.length >= 2) {
      // Suggest switching to an alternative model (second in list)
      const altModel = input.availableModels[1]
      return {
        model: altModel,
        reasoning: `rising latency at turn ${input.turnCount} with ${input.availableModels.length} models available — suggesting switch to ${altModel}`,
      }
    }
    return null
  },
}

const W3: S5Rule = {
  id: 'W3',
  tier: 'warning',
  name: 'Revert recommendation — stuck with low success',
  evaluate(input) {
    const gov = input.governance as Record<string, unknown> | undefined
    const stuckTurns = (gov?.stuckTurns as number) ?? 0
    const toolSuccessRate = (gov?.toolSuccessRate as number) ?? 1.0
    if (stuckTurns >= 5 && toolSuccessRate < 0.5) {
      return {
        revert: true,
        reasoning: `stuck for ${stuckTurns} turns with ${Math.round(toolSuccessRate * 100)}% tool success — recommending revert`,
      }
    }
    return null
  },
}

const W4: S5Rule = {
  id: 'W4',
  tier: 'warning',
  name: 'Drift detected + degrading — compact + exclude failing',
  evaluate(input) {
    if (input.driftDetected && input.driftDirection === 'degrading') {
      const failing = getFailingTools(input.recentToolResults, 2)
      const result: Partial<S5Decision> = {
        contextAction: 'compact',
        reasoning: `drift detected and degrading — compacting context${failing.length > 0 ? ` + excluding ${failing.join(', ')}` : ''}`,
      }
      if (failing.length > 0) {
        result.tools = excludeTools(failing)
      }
      return result
    }
    return null
  },
}

const W5: S5Rule = {
  id: 'W5',
  tier: 'warning',
  name: 'Homeostatic instability — rebalance priority',
  evaluate(input) {
    if (input.homeostatStable === false && input.homeostatConsecutiveUnstable >= 3) {
      if (input.s3s4Balance === 's3_dominant') {
        return {
          priority: 's4',
          reasoning: `homeostat unstable ${input.homeostatConsecutiveUnstable}x, S3 dominant — boosting S4 priority`,
        }
      }
      if (input.s3s4Balance === 's4_dominant') {
        return {
          priority: 's3',
          reasoning: `homeostat unstable ${input.homeostatConsecutiveUnstable}x, S4 dominant — boosting S3 priority`,
        }
      }
      return {
        priority: 'balanced',
        reasoning: `homeostat unstable ${input.homeostatConsecutiveUnstable}x — enforcing balanced priority`,
      }
    }
    return null
  },
}

const W6: S5Rule = {
  id: 'W6',
  tier: 'warning',
  name: 'S3/S4 imbalance — boost opposite priority',
  evaluate(input) {
    if (input.turnCount >= 5) {
      if (input.s3s4Balance === 's4_dominant') {
        return {
          priority: 's3',
          reasoning: `S4 dominant for ${input.turnCount}+ turns — boosting S3 operational priority`,
        }
      }
      if (input.s3s4Balance === 's3_dominant') {
        return {
          priority: 's4',
          reasoning: `S3 dominant for ${input.turnCount}+ turns — boosting S4 intelligence priority`,
        }
      }
    }
    return null
  },
}

const W7: S5Rule = {
  id: 'W7',
  tier: 'warning',
  name: 'Tool mode mismatch — surface recommendation',
  evaluate(input) {
    if (input.recommendedToolMode && input.recommendedToolMode !== 'full' && input.turnCount >= 3) {
      return {
        reasoning: `tool mode ${input.recommendedToolMode} recommended for ${input.turnCount}+ turns — surfacing to user`,
      }
    }
    return null
  },
}

// ─── Info Rules (I1–I5) ─────────────────────────────────────

const I1: S5Rule = {
  id: 'I1',
  tier: 'info',
  name: 'Variety shift — journal',
  evaluate(input) {
    if (input.varietyBalance && input.varietyBalance !== 'balanced') {
      const ratio = input.varietyRatio ?? 0
      return {
        reasoning: `variety balance: ${input.varietyBalance} (ratio ${ratio.toFixed(2)})`,
      }
    }
    return null
  },
}

const I2: S5Rule = {
  id: 'I2',
  tier: 'info',
  name: 'Homeostatic adjustment — journal',
  evaluate(input) {
    if (input.homeostatStable === false && input.homeostatConsecutiveUnstable > 0 && input.homeostatConsecutiveUnstable < 3) {
      return {
        reasoning: `homeostat unstable (${input.homeostatConsecutiveUnstable}x consecutive) — monitoring`,
      }
    }
    return null
  },
}

const I3: S5Rule = {
  id: 'I3',
  tier: 'info',
  name: 'Performance update — journal',
  evaluate(input) {
    if (input.performanceHealth && input.performanceHealth !== 'healthy') {
      const ratio = input.productivityRatio ?? 0
      return {
        reasoning: `performance health: ${input.performanceHealth} (productivity ratio ${ratio.toFixed(2)})`,
      }
    }
    return null
  },
}

const I4: S5Rule = {
  id: 'I4',
  tier: 'info',
  name: 'Heterarchy change — journal',
  evaluate(input) {
    if (input.heterarchyAuthority && input.heterarchyAuthority !== 's5') {
      return {
        reasoning: `heterarchy authority shifted to ${input.heterarchyAuthority}`,
      }
    }
    return null
  },
}

const I5: S5Rule = {
  id: 'I5',
  tier: 'info',
  name: 'Coupling drift — journal',
  evaluate(input) {
    if (input.driftDetected && input.driftDirection !== 'degrading') {
      return {
        reasoning: `drift detected — direction: ${input.driftDirection ?? 'unknown'}`,
      }
    }
    return null
  },
}

// ─── All rules in evaluation order ──────────────────────────

export const ALL_RULES: S5Rule[] = [
  // Critical (auto-enforce)
  C1, C2, C3, C4, C5, C6,
  // Warning (surface to TUI)
  W1, W2, W3, W4, W5, W6, W7,
  // Info (journal only)
  I1, I2, I3, I4, I5,
]

// ─── Decision combination ───────────────────────────────────

const CONTEXT_ACTION_STRENGTH: Record<string, number> = {
  none: 0,
  warn: 1,
  compact: 2,
}

export function combineDecisions(decisions: Partial<S5Decision>[]): Partial<S5Decision> {
  if (decisions.length === 0) return {}

  let combinedTools: string[] | null = null
  let contextAction: S5Decision['contextAction'] = 'none'
  let priority: S5Decision['priority'] = 'balanced'
  let model: string | null = null
  let revert = false
  let spawnAgent: S5Decision['spawnAgent'] = null
  const allReasons: string[] = []

  for (const d of decisions) {
    // Tools: intersect (most restrictive wins)
    if (d.tools) {
      if (combinedTools === null) {
        combinedTools = [...d.tools]
      } else {
        const dSet = new Set(d.tools)
        combinedTools = combinedTools.filter(t => dSet.has(t))
      }
    }

    // Context action: strongest wins
    if (d.contextAction) {
      const currentStrength = CONTEXT_ACTION_STRENGTH[contextAction] ?? 0
      const newStrength = CONTEXT_ACTION_STRENGTH[d.contextAction] ?? 0
      if (newStrength > currentStrength) {
        contextAction = d.contextAction
      }
    }

    // Priority: first non-balanced wins
    if (d.priority && d.priority !== 'balanced' && priority === 'balanced') {
      priority = d.priority
    }

    // Model: first non-null wins
    if (d.model && !model) {
      model = d.model
    }

    // Revert: any true wins
    if (d.revert) {
      revert = true
    }

    // SpawnAgent: first non-null wins (but null from C5 blocks it)
    if (d.spawnAgent !== undefined) {
      spawnAgent = d.spawnAgent
    }

    // Reasoning: collect all
    if (d.reasoning) {
      allReasons.push(d.reasoning)
    }
  }

  return {
    tools: combinedTools,
    contextAction,
    priority,
    model,
    revert,
    spawnAgent,
    reasoning: allReasons.join('; '),
  }
}

// ─── RuleBasedS5 ────────────────────────────────────────────

export class RuleBasedS5 implements S5Interface {
  readonly name = 'RuleBasedS5'

  async decide(input: S5Input): Promise<S5Decision> {
    const firedDecisions: Partial<S5Decision>[] = []
    const ruleIds: string[] = []

    // Evaluate all rules by tier order (critical first, then warning, then info)
    for (const rule of ALL_RULES) {
      const result = rule.evaluate(input)
      if (result !== null) {
        firedDecisions.push(result)
        ruleIds.push(rule.id)
      }
    }

    // Combine all fired decisions
    const combined = combineDecisions(firedDecisions)

    // Default reasoning if no rules fired
    const reasoning = combined.reasoning && combined.reasoning.length > 0
      ? combined.reasoning
      : 'all systems nominal — no intervention required'

    return {
      workflow: null,
      advancePhase: null,
      model: combined.model ?? null,
      tools: combined.tools ?? null,
      contextAction: combined.contextAction ?? 'none',
      spawnAgent: combined.spawnAgent ?? null,
      priority: combined.priority ?? 'balanced',
      reasoning,
      revert: combined.revert ?? false,
      decisionId: randomUUID(),
      ruleIds,
    }
  }
}
