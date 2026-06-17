/**
 * ModelPicker — classifies task complexity from a message.
 */

import type { TaskComplexity } from './types.js'

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
