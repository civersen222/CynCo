/**
 * RewardLabeler — computes scalar rewards from task outcome components.
 *
 * Implements an anti-reward-hacking gate: if the agent modified test files,
 * the reward is hard-set to -1.0 regardless of other components.
 *
 * Output: <baseDir>/<taskId>.reward.json
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { buildComponents } from './taskOutcome.js'
import type { TaskOutcomeInput } from './taskOutcome.js'

/**
 * Which semantics produced a reward record.
 *
 * Finding (z): this was the literal 2, written inline, through sixteen changes
 * to what the components mean between 2026-07-25 and 2026-07-27 — testsPass
 * scope, the tests-weakened veto, the auto-contract rule, the hygiene weights,
 * the engine-error carve-out. Every record on disk therefore claims 2 and no
 * two of them necessarily mean the same thing, while MIN_LABELER_VERSION reads
 * that field and lets all of them into the corpus. L4.2 sits there at 0.9736
 * for a run that deleted 32 test cases; the current labeler scores it -1.0.
 *
 * Bump this whenever the meaning of a component or a weight changes. The
 * fingerprint test in engine/__tests__/training/labelerIdentity.test.ts binds
 * this number to what the labeler actually says, so a silent change fails.
 */
export const LABELER_VERSION = 3

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
  // 0 = agent weakened tests = reward hacking. 'unknown' = the gate could not
  // run at all (no git repo, unresolvable base sha), which is disclosed in the
  // persisted record rather than papered over with a 1. A 1 here is a claim
  // that someone looked at the diff and found the tests intact.
  testsUnmodified: ComponentValue
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
 *
 * Outcome dominates hygiene, 3.0 of 3.6. Passing typecheck and building are
 * table stakes, not partial credit for working code: under an even split, a
 * task where every single test failed still scored 0.4 because the code
 * compiled. A failed task has to be able to look failed, or there are no DPO
 * negatives and the corpus is all-positive again for a subtler reason.
 */
const POSITIVE_WEIGHTS: { key: keyof RewardComponents; weight: number }[] = [
  { key: 'testsPass', weight: 2.0 },
  { key: 'taskCompleted', weight: 1.0 },
  { key: 'typecheckPass', weight: 0.3 },
  { key: 'buildPass', weight: 0.2 },
  { key: 'diffClean', weight: 0.1 },
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
 * Did anything about the OUTCOME of the task actually get measured?
 *
 * testsPass and taskCompleted are the only two components that say whether the
 * work worked. typecheckPass, buildPass and diffClean are hygiene: they are
 * measured constantly and say nothing about whether the assigned job was done.
 * diffClean in particular is measured on any git repo and scores 1 for an
 * empty dirty list, so a task where the agent did nothing at all would
 * otherwise produce a full-marks row on a denominator of 0.1.
 */
export function hasOutcomeEvidence(c: RewardComponents): boolean {
  for (const key of ['testsPass', 'taskCompleted'] as const) {
    const v = c[key]
    if (typeof v === 'number' && !Number.isNaN(v)) return true
  }
  return false
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
  outcome?: TaskOutcomeInput,
): TaskReward {
  const dir = baseDir ?? join(homedir(), '.cynco', 'rewards')
  mkdirSync(dir, { recursive: true })

  // The evidence, not just the verdict. Finding (z): buildComponents was called
  // with live in-memory state and the input dropped on the floor, so when a
  // labeler bug was found the only options were to keep numbers known to be
  // wrong or throw the row away. Sixteen labeler fixes in three days, and the
  // corpus reset to one usable row each time. Plain data, written beside the
  // reward, turns "discard" into "remeasure". See relabel.
  if (outcome !== undefined) {
    writeFileSync(join(dir, `${taskId}.outcome.json`), JSON.stringify(outcome, null, 2) + '\n', 'utf-8')
  }

  const reward = computeReward(components)

  const result: TaskReward = {
    taskId,
    turns,
    components,
    reward,
    labelerVersion: LABELER_VERSION,
    // Degenerate unless the OUTCOME was observed. A denominator of "something
    // was measured" is not enough: hygiene alone is not evidence that any work
    // happened, and a clean tree with no test run scored 1.0 on diffClean
    // alone — the saturation bug relocated from the clipping ceiling to the
    // denominator. Hygiene cannot stand in for outcome, so it cannot qualify
    // a row for the corpus on its own. See hasOutcomeEvidence.
    ...(hasOutcomeEvidence(components) ? {} : { degenerate: true }),
  }

  const filePath = join(dir, `${taskId}.reward.json`)
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n', 'utf-8')

  return result
}

// ─── relabel ──────────────────────────────────────────────────────

/**
 * Redo a task's labeling from the evidence it was originally measured from,
 * and overwrite the stored record.
 *
 * Null means the measurement cannot be redone — there is no persisted outcome,
 * or it is unreadable. Not a guess, and not a pass-through of the old numbers:
 * a record whose evidence is gone is a record nobody can vouch for, and saying
 * so is the whole point. Every row written before finding (z) is in exactly
 * that state, and the honest thing is for a relabel pass to leave them
 * conspicuously at their old version rather than restamp them as current.
 *
 * `turns` is read from the persisted input rather than the old record, so the
 * two cannot drift apart.
 */
export function relabel(taskId: string, baseDir?: string): TaskReward | null {
  const dir = baseDir ?? join(homedir(), '.cynco', 'rewards')
  const outcomePath = join(dir, `${taskId}.outcome.json`)
  if (!existsSync(outcomePath)) return null

  let outcome: TaskOutcomeInput
  try {
    outcome = JSON.parse(readFileSync(outcomePath, 'utf-8'))
  } catch {
    return null
  }

  return finalizeTask(taskId, outcome.turns, buildComponents(outcome), dir, outcome)
}
