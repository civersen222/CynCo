/**
 * ModelPicker — selects a model profile based on task complexity.
 *
 * Maps simple→fast, moderate→balanced, complex→powerful.
 * Falls back to the first available model if no tier match is found.
 */

import type { TaskComplexity, ModelProfile } from './types.js'

// ─── Complexity Classification ────────────────────────────────────

const SIMPLE_KEYWORDS = ['fix typo', 'rename', 'show', 'print', 'list', 'what is', 'explain briefly', 'hello']
const COMPLEX_KEYWORDS = ['refactor', 'architect', 'migrate', 'implement', 'design', 'optimize', 'rewrite', 'analyze']

/**
 * Classify task complexity from a message and recent tool call count.
 *
 * Rules (in priority order):
 * - Complex if message contains complex keywords, is long (>200 chars), or recentToolCount >= 3
 * - Simple if message is short (<60 chars), contains simple keywords, and recentToolCount === 0
 * - Moderate otherwise
 */
export function classifyComplexity(message: string, recentToolCount: number): TaskComplexity {
  const lower = message.toLowerCase()

  // Complex signals: keywords, length, or many tools
  const hasComplexKeyword = COMPLEX_KEYWORDS.some(kw => lower.includes(kw))
  if (hasComplexKeyword || message.length > 200 || recentToolCount >= 3) {
    return 'complex'
  }

  // Simple signals: short + simple keywords + no tools
  const hasSimpleKeyword = SIMPLE_KEYWORDS.some(kw => lower.includes(kw))
  if (message.length < 60 && hasSimpleKeyword && recentToolCount === 0) {
    return 'simple'
  }

  return 'moderate'
}

// ─── Model Selection ──────────────────────────────────────────────

/** Map complexity to the required tier. */
const COMPLEXITY_TO_TIER: Record<TaskComplexity, ModelProfile['tier']> = {
  simple: 'fast',
  moderate: 'balanced',
  complex: 'powerful',
}

/**
 * Pick the best model profile for a given complexity level.
 *
 * Returns the first profile matching the required tier, or the first profile
 * in the list as a fallback if none match.
 */
export function pickForComplexity(
  complexity: TaskComplexity,
  profiles: ModelProfile[],
): ModelProfile | undefined {
  if (profiles.length === 0) return undefined

  const targetTier = COMPLEXITY_TO_TIER[complexity]
  const match = profiles.find(p => p.tier === targetTier)

  // Fallback to first model if no tier match
  return match ?? profiles[0]
}
