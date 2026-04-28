/**
 * Difficulty classification and confidence scoring for the vibe loop.
 */

import type { ConfidenceDimension, ConfidenceState, DifficultyLevel } from './types.js'
import { CONFIDENCE_THRESHOLDS } from './types.js'

/** Fixed confidence increment per answer, by difficulty. */
export const INCREMENTS_PER_ANSWER: Record<DifficultyLevel, number> = {
  trivial: 30,
  simple: 20,
  medium: 15,
  complex: 10,
  massive: 8,
}

const COMPLEXITY_KEYWORDS = [
  'multiplayer', 'real-time', 'realtime', 'matchmaking', 'leaderboard',
  'authentication', 'oauth', 'database', 'migration', 'api',
  'websocket', 'streaming', 'encryption', 'permissions', 'roles',
  'cache', 'queue', 'scheduler', 'pipeline', 'workflow',
  'system', 'dashboard', 'analytics',
]

const MASSIVE_SIGNALS = [
  'like uber', 'like airbnb', 'like twitter', 'like instagram',
  'like tiktok', 'like spotify', 'like netflix', 'like amazon',
  'payments', 'notifications', 'maps', 'driver matching',
  'ratings', 'subscriptions', 'marketplace', 'social network',
]

const TRIVIAL_KEYWORDS = [
  'change', 'color', 'text', 'button', 'rename', 'typo', 'label',
  'font', 'size', 'margin', 'padding', 'border', 'icon',
]

/**
 * Classify task difficulty from a natural-language description.
 */
export function classifyDifficulty(description: string): DifficultyLevel {
  const lower = description.toLowerCase()
  const words = lower.split(/\s+/).filter(w => w.length > 0)
  const wordCount = words.length

  const complexCount = COMPLEXITY_KEYWORDS.filter(kw => lower.includes(kw)).length
  const massiveCount = MASSIVE_SIGNALS.filter(sig => lower.includes(sig)).length
  const hasTrivialKeyword = TRIVIAL_KEYWORDS.some(kw => lower.includes(kw))

  // Massive: 2+ massive signals, or 3+ complex keywords with 30+ words
  if (massiveCount >= 2 || (complexCount >= 3 && wordCount >= 30)) {
    return 'massive'
  }

  // Complex: 25+ words or 2+ complexity keywords
  if (wordCount >= 25 || complexCount >= 2) {
    return 'complex'
  }

  // Medium: 12+ words or 1 complexity keyword
  if (wordCount >= 12 || complexCount >= 1) {
    return 'medium'
  }

  // Trivial: 8 or fewer words with a trivial keyword
  if (wordCount <= 8 && hasTrivialKeyword) {
    return 'trivial'
  }

  // Simple: everything else
  return 'simple'
}

/**
 * Tracks confidence across 4 dimensions and compares against a difficulty threshold.
 */
export class ConfidenceScorer {
  private scores: ConfidenceState = {
    purpose: 0,
    mechanics: 0,
    integration: 0,
    ambiguity: 0,
  }
  private reasons: Record<ConfidenceDimension, string> = {
    purpose: '',
    mechanics: '',
    integration: '',
    ambiguity: '',
  }
  private threshold: number
  private incrementAmount: number

  constructor(difficulty: DifficultyLevel) {
    this.threshold = CONFIDENCE_THRESHOLDS[difficulty]
    this.incrementAmount = INCREMENTS_PER_ANSWER[difficulty]
  }

  update(dimension: ConfidenceDimension, value: number, reason: string): void {
    this.scores[dimension] = Math.max(0, Math.min(100, value))
    this.reasons[dimension] = reason
  }

  /** Accumulate confidence — adds a fixed increment to the dimension. */
  increment(dimension: ConfidenceDimension, reason: string): void {
    this.scores[dimension] = Math.min(100, this.scores[dimension] + this.incrementAmount)
    this.reasons[dimension] = reason
    // Every answer also reduces ambiguity (every answer reduces unknowns)
    if (dimension !== 'ambiguity') {
      this.scores.ambiguity = Math.min(100, this.scores.ambiguity + Math.floor(this.incrementAmount / 2))
    }
  }

  get(dimension: ConfidenceDimension): number {
    return this.scores[dimension]
  }

  overall(): number {
    return Math.min(
      this.scores.purpose,
      this.scores.mechanics,
      this.scores.integration,
      this.scores.ambiguity,
    )
  }

  isReady(): boolean {
    return this.overall() >= this.threshold
  }

  status(): { overall: number; lowest: ConfidenceDimension; reason: string; ready: boolean } {
    const dimensions: ConfidenceDimension[] = ['purpose', 'mechanics', 'integration', 'ambiguity']
    let lowest: ConfidenceDimension = 'purpose'
    let lowestVal = this.scores.purpose

    for (const dim of dimensions) {
      if (this.scores[dim] < lowestVal) {
        lowestVal = this.scores[dim]
        lowest = dim
      }
    }

    return {
      overall: this.overall(),
      lowest,
      reason: this.reasons[lowest],
      ready: this.isReady(),
    }
  }

  getState(): ConfidenceState {
    return { ...this.scores }
  }
}
