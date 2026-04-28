/**
 * Cascade pattern enforcement for agent escalation.
 *
 * Default to single agent; only escalate to multi-agent on demonstrated
 * failure. This is critical for local models where coordination overhead
 * is punishing.
 *
 * Rules:
 * - simple tasks: never cascade
 * - moderate tasks: cascade after 2 failed attempts
 * - complex tasks: cascade after 1 failed attempt
 */

export type CascadeDecision = {
  shouldEscalate: boolean
  reason: string
}

export type CascadeContext = {
  previousAttempts: number
  lastError?: string
  taskComplexity: 'simple' | 'moderate' | 'complex'
}

/** Threshold of failed attempts before cascade is permitted, by complexity. */
const CASCADE_THRESHOLDS: Record<CascadeContext['taskComplexity'], number | null> = {
  simple: null,     // never cascade
  moderate: 2,      // cascade after 2 failed attempts
  complex: 1,       // cascade after 1 failed attempt
}

export function shouldCascade(context: CascadeContext): CascadeDecision {
  const { previousAttempts, lastError, taskComplexity } = context
  const threshold = CASCADE_THRESHOLDS[taskComplexity]

  // Simple tasks: never cascade regardless of attempts
  if (threshold === null) {
    return {
      shouldEscalate: false,
      reason: `Simple tasks do not cascade; single-agent execution preferred`,
    }
  }

  // Not enough attempts yet
  if (previousAttempts < threshold) {
    return {
      shouldEscalate: false,
      reason: `${taskComplexity} task has ${previousAttempts}/${threshold} attempts before cascade`,
    }
  }

  // Threshold met or exceeded: escalate
  const errorContext = lastError ? ` (last error: ${lastError})` : ''
  return {
    shouldEscalate: true,
    reason: `${taskComplexity} task failed ${previousAttempts} time(s), exceeding threshold of ${threshold}${errorContext}`,
  }
}
