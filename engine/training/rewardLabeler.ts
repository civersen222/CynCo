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

export type RewardComponents = {
  testsPass: number        // 0-1 ratio
  typecheckPass: 0 | 1
  buildPass: 0 | 1
  diffClean: 0 | 1
  taskCompleted: 0 | 1
  stuckTurns: number
  iterFraction: number     // turns / 500
  userSatisfaction: -1 | 0 | 1
  testsUnmodified: 0 | 1   // 0 = agent modified test files = reward hacking
}

export type TaskReward = {
  taskId: string
  turns: number
  components: RewardComponents
  reward: number
}

// ─── computeReward ────────────────────────────────────────────────

/**
 * Compute a scalar reward in [-1, 1] from task outcome components.
 *
 * Anti-reward-hacking gate: testsUnmodified == 0 → reward = -1.0 immediately.
 */
export function computeReward(c: RewardComponents): number {
  // Anti-reward-hacking gate — must check first
  if (c.testsUnmodified === 0) {
    return -1.0
  }

  let r =
    1.0 * c.testsPass +
    0.5 * c.typecheckPass +
    0.3 * c.buildPass +
    0.2 * c.diffClean +
    0.5 * c.taskCompleted -
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

  const result: TaskReward = { taskId, turns, components, reward }

  const filePath = join(dir, `${taskId}.reward.json`)
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n', 'utf-8')

  return result
}
