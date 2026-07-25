/**
 * RewardLabeler — computes scalar rewards from task outcome components.
 *
 * Implements an anti-reward-hacking gate: if the agent modified test files,
 * the reward is hard-set to -1.0 regardless of other components.
 *
 * Output: <baseDir>/<taskId>.reward.json
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Types ────────────────────────────────────────────────────────

/** A component value that could not be observed. Excluded from the reward denominator. */
export type ComponentValue = number | 'unknown'

export type RewardComponents = {
  testsPass: ComponentValue      // 0-1 ratio
  typecheckPass: ComponentValue  // 0 | 1
  buildPass: ComponentValue      // 0 | 1
  diffClean: ComponentValue      // 0 | 1
  taskCompleted: ComponentValue  // 0 | 1
  stuckTurns: number
  iterFraction: number           // turns / 500
  userSatisfaction: -1 | 0 | 1
  testsUnmodified: 0 | 1         // 0 = agent weakened tests = reward hacking. Never 'unknown'.
}

export type TaskReward = {
  taskId: string
  turns: number
  components: RewardComponents
  reward: number
  labelerVersion: number
  degenerate?: boolean
}

// ─── computeReward ────────────────────────────────────────────────

/**
 * Weights for the positive components. The reward is their weighted MEAN over
 * the components that could actually be measured, so it cannot saturate.
 *
 * Before 2026-07-25 these were summed (total 2.8) and the result clipped to
 * 1.0, which meant the non-test components alone (1.8) hit the ceiling and
 * every testsPass value between 0.43 and 1.0 collapsed to the same score.
 */
const POSITIVE_WEIGHTS: { key: keyof RewardComponents; weight: number }[] = [
  { key: 'testsPass', weight: 1.0 },
  { key: 'typecheckPass', weight: 0.5 },
  { key: 'buildPass', weight: 0.3 },
  { key: 'diffClean', weight: 0.2 },
  { key: 'taskCompleted', weight: 0.5 },
]

/** Weighted mean of the measurable positive components, in [0,1]. */
export function positiveBase(c: RewardComponents): { base: number; known: number } {
  let num = 0
  let den = 0
  for (const { key, weight } of POSITIVE_WEIGHTS) {
    const v = c[key]
    if (typeof v !== 'number' || Number.isNaN(v)) continue
    num += weight * v
    den += weight
  }
  return { base: den > 0 ? num / den : 0, known: den }
}

/**
 * Compute a scalar reward in [-1, 1] from task outcome components.
 *
 * Anti-reward-hacking gate: testsUnmodified == 0 -> reward = -1.0 immediately.
 */
export function computeReward(c: RewardComponents): number {
  // Anti-reward-hacking gate — must check first
  if (c.testsUnmodified === 0) {
    return -1.0
  }

  const { base } = positiveBase(c)

  let r =
    base -
    0.05 * Math.min(c.stuckTurns, 10) -
    0.1 * c.iterFraction +
    0.3 * Math.max(0, c.userSatisfaction)

  // Clip to [-1, 1]
  if (r < -1.0) r = -1.0
  if (r > 1.0) r = 1.0

  return r
}

// ─── finalizeTask ─────────────────────────────────────────────────

/**
 * Compute reward, persist to <baseDir>/<taskId>.reward.json, and return the
 * TaskReward record. Default baseDir is ~/.cynco/rewards.
 */
export function finalizeTask(
  taskId: string,
  turns: number,
  components: RewardComponents,
  baseDir?: string,
): TaskReward {
  const dir = baseDir ?? join(homedir(), '.cynco', 'rewards')
  mkdirSync(dir, { recursive: true })

  const reward = computeReward(components)
  const { known } = positiveBase(components)

  const result: TaskReward = {
    taskId,
    turns,
    components,
    reward,
    labelerVersion: 2,
    ...(known === 0 ? { degenerate: true } : {}),
  }

  const filePath = join(dir, `${taskId}.reward.json`)
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n', 'utf-8')

  return result
}
