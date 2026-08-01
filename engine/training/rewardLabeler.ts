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
import { buildComponents } from './taskOutcome.js'
import type { TaskOutcomeInput } from './taskOutcome.js'
import { cyncoHome } from '../paths.js'

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
export const LABELER_VERSION = 4

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
  /**
   * A person's judgement that this row's label does not describe its trajectory,
   * and the reason they gave. Distinct from `degenerate`, which is DERIVED from
   * the components on every labeling and so cannot hold a judgement: a hand-set
   * `degenerate` is silently undone by the next relabel pass.
   *
   * The measurement is left exactly as taken. What quarantine changes is whether
   * the row is offered as training data — see `isUsable`.
   */
  quarantined?: { reason: string; at: string }
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
  const dir = baseDir ?? join(cyncoHome(), 'rewards')
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
    //
    // Degenerate too when the engine killed the run. buildComponents already
    // withholds taskCompleted for that case, and that turned out not to be
    // enough: with completion unknown, a test run observed BEFORE the crash was
    // the only outcome component left, and task-25d8015a scored 0.9882 — the
    // best row in the corpus — for a run that never reached an ending. A
    // truncated run has no ending to grade. `=== true` because an absent
    // outcome is not a report of "no crash".
    ...(hasOutcomeEvidence(components) && outcome?.endedInEngineError !== true
      ? {}
      : { degenerate: true }),
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
  const dir = baseDir ?? join(cyncoHome(), 'rewards')
  const outcomePath = join(dir, `${taskId}.outcome.json`)
  if (!existsSync(outcomePath)) return null

  let outcome: TaskOutcomeInput
  try {
    outcome = JSON.parse(readFileSync(outcomePath, 'utf-8'))
  } catch {
    return null
  }

  // Read before the rewrite. A quarantine is a judgement about the trajectory,
  // not about the labeler, so a labeler fix is no reason to revisit it — and
  // dropping it here would put an excluded row back in the corpus on the next
  // remeasurement with nobody watching, which is the whole reason it is a field
  // and not a hand-edit.
  const held = readReward(taskId, dir)?.quarantined
  const relabeled = finalizeTask(taskId, outcome.turns, buildComponents(outcome), dir, outcome)
  return held ? applyQuarantine(taskId, held, dir) : relabeled
}

/** The stored record for a task, or null when there is none to read. */
function readReward(taskId: string, dir: string): TaskReward | null {
  const p = join(dir, `${taskId}.reward.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TaskReward
  } catch {
    return null
  }
}

function applyQuarantine(taskId: string, q: { reason: string; at: string }, dir: string): TaskReward {
  const record = readReward(taskId, dir)
  if (!record) throw new Error(`no reward record for ${taskId}`)
  const next: TaskReward = { ...record, quarantined: q }
  writeFileSync(join(dir, `${taskId}.reward.json`), JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return next
}

/**
 * Take a row out of the corpus, on the record, without touching its numbers.
 *
 * Rewriting the reward would be inventing a measurement nobody took. The label
 * stays as measured; the row simply stops being offered as something to learn
 * from. The reason is required because an exclusion nobody can account for is
 * indistinguishable from data that went missing.
 *
 * First reason and first time win, so re-running a quarantine pass does not
 * rewrite the history of when a row left the corpus.
 */
export function quarantine(taskId: string, reason: string, baseDir?: string): TaskReward {
  const dir = baseDir ?? join(cyncoHome(), 'rewards')
  const record = readReward(taskId, dir)
  if (!record) throw new Error(`no reward record for ${taskId} — nothing to quarantine`)
  if (reason.trim() === '') throw new Error('a quarantine needs a reason')
  if (record.quarantined) return record
  return applyQuarantine(taskId, { reason: reason.trim(), at: new Date().toISOString() }, dir)
}

/** Excluded from the corpus by a person, whatever its measurement says. */
export function isQuarantined(reward: TaskReward): boolean {
  return reward.quarantined !== undefined
}
