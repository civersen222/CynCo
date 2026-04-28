/**
 * Context budget enforcement for local models.
 *
 * Local models have much smaller context windows than Claude (4k-32k vs 200k).
 * If messages exceed ~40% of context, model quality degrades. This module:
 *
 *   1. Estimates current context usage (rough char/4 heuristic)
 *   2. Signals when compaction is needed
 *   3. Provides a budget check that callModel can use before each request
 */

// ─── Types ─────────────────────────────────────────────────────

export type BudgetConfig = {
  contextLength: number    // Total context window size in tokens
  warningThreshold: number // Fraction (0-1) to warn (default 0.4)
  hardLimit: number        // Fraction (0-1) that's the absolute max (default 0.8)
}

export type BudgetCheck = {
  estimatedTokens: number
  contextLength: number
  utilization: number      // 0-1 fraction
  status: 'ok' | 'warning' | 'exceeded'
  shouldCompact: boolean
}

// ─── Defaults ──────────────────────────────────────────────────

export const DEFAULT_BUDGET: BudgetConfig = {
  contextLength: 32768,
  warningThreshold: 0.4,
  hardLimit: 0.8,
}

// ─── Token Estimation ──────────────────────────────────────────

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is intentionally simple -- better to over-estimate than under.
 */
export function estimateTokens(messages: { content?: unknown[] }[]): number {
  let chars = 0
  for (const msg of messages) {
    if (!msg.content) continue
    for (const block of msg.content) {
      if (typeof block === 'string') {
        chars += block.length
      } else if (block && typeof block === 'object' && 'text' in block) {
        chars += String((block as any).text).length
      } else if (block && typeof block === 'object' && 'input' in block) {
        chars += JSON.stringify((block as any).input).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

// ─── Budget Check ──────────────────────────────────────────────

export function checkBudget(
  messages: { content?: unknown[] }[],
  config: Partial<BudgetConfig> = {},
): BudgetCheck {
  const budget = { ...DEFAULT_BUDGET, ...config }
  const estimatedTokens = estimateTokens(messages)
  const utilization = estimatedTokens / budget.contextLength

  let status: BudgetCheck['status'] = 'ok'
  if (utilization >= budget.hardLimit) {
    status = 'exceeded'
  } else if (utilization >= budget.warningThreshold) {
    status = 'warning'
  }

  return {
    estimatedTokens,
    contextLength: budget.contextLength,
    utilization,
    status,
    shouldCompact: status === 'warning' || status === 'exceeded',
  }
}
