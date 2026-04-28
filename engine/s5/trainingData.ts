import type { DecisionRecord } from '../decisions/logger.js'

export type TrainingExample = {
  input: string
  output: string
}

/**
 * Format a DecisionRecord's state into a human-readable prompt string
 * that represents the model's "input view" of the situation.
 */
function formatInput(record: DecisionRecord): string {
  const toolResults = record.toolsCalled
    .map((tool, i) => `${tool}:${record.toolResults[i] ?? 'unknown'}`)
    .join(', ')

  const lines = [
    `User: ${record.userMessageSummary}`,
    `Workflow: ${record.activeWorkflow ?? 'none'}`,
    `Context: ${Math.round(record.contextUsagePercent * 100)}%`,
    `Tools called: ${toolResults || 'none'}`,
    `Model: ${record.modelUsed}`,
    `Latency: ${record.latencyMs}ms`,
    `Tokens: ${record.tokenCount}`,
    `Stop: ${record.stopReason}`,
  ]

  if (record.userSatisfaction) {
    lines.push(`Satisfaction: ${record.userSatisfaction}`)
  }

  return lines.join('\n')
}

/**
 * Derive a decision JSON from a DecisionRecord.
 * Maps the historical record fields to what an S5 model should output.
 */
function deriveDecision(record: DecisionRecord): object {
  const failures = record.toolResults.filter(r => r === 'failure' || r === 'denied').length
  const total = record.toolResults.length

  let contextAction: 'none' | 'compact' | 'warn' = 'none'
  if (record.contextUsagePercent >= 0.9) contextAction = 'warn'
  else if (record.contextUsagePercent >= 0.75) contextAction = 'compact'

  const toolSuccessRate = total > 0 ? (total - failures) / total : 1.0
  let tools: string[] | null = null
  if (toolSuccessRate < 0.5 && total >= 3) {
    tools = ['Read', 'Glob', 'Grep', 'Git', 'Write', 'Edit']
  }

  return {
    workflow: record.activeWorkflow,
    advancePhase: null,
    model: null,
    tools,
    contextAction,
    spawnAgent: null,
    priority: 'balanced',
    reasoning: `Derived from historical record: stop=${record.stopReason}, latency=${record.latencyMs}ms, satisfaction=${record.userSatisfaction ?? 'unknown'}`,
  }
}

export function buildExamples(records: DecisionRecord[]): TrainingExample[] {
  return records.map(record => ({
    input: formatInput(record),
    output: JSON.stringify(deriveDecision(record)),
  }))
}

export function toJsonl(records: DecisionRecord[]): string {
  const examples = buildExamples(records)
  return examples.map(ex => JSON.stringify(ex)).join('\n')
}
