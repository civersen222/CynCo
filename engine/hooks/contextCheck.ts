/**
 * Pre-turn context check for local models.
 *
 * Called at the top of localCallModel() before each model call.
 * Determines whether to proceed normally, externalize context (create handoff),
 * or trigger compaction.
 */

import type { LocalCodeConfig } from '../config.js'
import { checkBudget, type BudgetCheck } from '../engine/contextBudget.js'

export type ContextAction = 'proceed' | 'externalize' | 'compact'

export type ContextCheckResult = {
  action: ContextAction
  budget: BudgetCheck
}

export async function checkContextBeforeTurn(
  messages: { content?: unknown[] }[],
  config: LocalCodeConfig,
): Promise<ContextCheckResult> {
  const thresholds = config.contextManagement ?? { warningThreshold: 0.4, hardLimit: 0.8 }
  const contextLength = config.contextLength ?? 32768

  const budget = checkBudget(messages, {
    contextLength,
    warningThreshold: thresholds.warningThreshold,
    hardLimit: thresholds.hardLimit,
  })

  let action: ContextAction = 'proceed'

  if (budget.status === 'exceeded') {
    action = 'compact'
  } else if (budget.status === 'warning') {
    action = 'externalize'
  }

  return { action, budget }
}
