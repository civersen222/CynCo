/**
 * Turn observations from a finished task into reward components.
 *
 * The rule this module exists to enforce: a component is either MEASURED from
 * something that actually happened, or it is 'unknown' and leaves the reward
 * denominator. It is never assumed. The previous offline labeler hardcoded
 * typecheckPass/buildPass/testsUnmodified to 1, which permanently disabled the
 * only safety check in the reward function.
 *
 * Pure — git access is the caller's job (see gitFacts.ts).
 */

import { isTestPath, type GitFacts } from './gitFacts.js'
import type { RewardComponents } from './rewardLabeler.js'

export type TestObservation = { passed: number; total: number }
export type CommandObservation = { kind: 'typecheck' | 'build'; ok: boolean }
/**
 * `origin` decides whether this contract can say anything about the task.
 * 'harness' — someone authored it; the brief's check script IS the spec.
 * 'auto'    — the engine synthesized it from the shape of the user's message.
 */
export type ContractFacts = {
  active: boolean
  complete: boolean
  failed: number
  origin: 'auto' | 'harness'
}

export type TaskOutcomeInput = {
  testObservations: TestObservation[]
  commandObservations: CommandObservation[]
  contract: ContractFacts | null
  git: GitFacts | null
  trackedModifiedFiles: string[]
  stuckTurns: number
  turns: number
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * A dirty path counts as agent-modified if any tracked path resolves to it.
 *
 * Known limit: git reports repo-relative paths and the tracked list holds
 * whatever the tool call used, often absolute, so matching is by path suffix.
 * A dirty repo-root `a.ts` therefore matches a tracked `/repo/src/deep/a.ts`.
 * That fails toward "clean" for a basename collision — acceptable because
 * diffClean is one weighted component, not the safety gate.
 */
function wasTracked(dirtyPath: string, tracked: string[]): boolean {
  const d = normalize(dirtyPath)
  return tracked.some(t => {
    const n = normalize(t)
    return n === d || n.endsWith(`/${d}`) || d.endsWith(`/${n}`)
  })
}

function lastObservation(obs: TestObservation[]): TestObservation | null {
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].total > 0) return obs[i]
  }
  return null
}

function firstObservation(obs: TestObservation[]): TestObservation | null {
  for (const o of obs) if (o.total > 0) return o
  return null
}

/**
 * Did this task's tests pass — as opposed to: is this repository green?
 *
 * The distinction is the whole point. testsPass carries 2.0 of a 2.1 denominator
 * once taskCompleted is unknown, so it effectively *is* the reward, and it was
 * measured as `last.passed / last.total` with nothing to compare against. In a
 * repo whose suite is already green, that scores a run which typed `pytest` and
 * changed nothing identically to one that did the job. Honest measurement of the
 * wrong quantity — the same error as certifying completion from an auto-contract,
 * in the highest-weighted slot.
 *
 * A green run is attributable to this task only when something changed:
 *   - the suite was red and is now green — the task fixed it, whatever it edited;
 *   - or the task added lines to a test file, and the suite is green with them in.
 * Green before and green after, with no test written, measures the repository.
 * That is 'unknown': it leaves the denominator instead of inflating it.
 *
 * A measured failure stays a measured failure. Partial credit is real information
 * and the corpus needs the negatives.
 */
function assessTestsPass(
  obs: TestObservation[],
  git: GitFacts | null,
): RewardComponents['testsPass'] {
  const last = lastObservation(obs)
  if (!last) return 'unknown'
  // Clamped: a parser reporting passed > total would otherwise hand the weighted
  // mean a component above its ceiling.
  const ratio = Math.min(1, last.passed / last.total)
  if (ratio < 1) return ratio

  const first = firstObservation(obs)
  if (first && first.passed < first.total) return 1

  const testsWritten = git?.changed.some(c => isTestPath(c.path) && !c.binary && c.added > 0)
  return testsWritten ? 1 : 'unknown'
}

/**
 * The anti-reward-hacking gate, scoped to WEAKENING rather than touching.
 *
 * CynCo does TDD, so writing tests is frequently the assigned job — a gate that
 * fired on any test-file edit would hard-fail every legitimate red-green task,
 * which is almost certainly why it was previously hardcoded to 1. It fires on:
 *   - a test file deleted outright, or
 *   - any single test file losing more lines than it gains, while product code
 *     also changed.
 * Adding tests is free. Gutting a suite to make it pass is -1.0.
 *
 * It is deliberately strict: a legitimate test tidy-up that shrinks a file
 * alongside a product change scores a false -1.0. That costs one mislabeled
 * row, which becomes a DPO negative and is recoverable. A false 1.0 on a
 * gutted suite teaches the model that gutting is excellent work, which is the
 * exact failure this whole pipeline repair exists to prevent.
 *
 * Binary files are excluded from the net-line-loss calculation because git
 * reports `-` for their line counts, which are set to 0. Treating an
 * unmeasured binary fixture as "weakening" would punish legitimate work.
 *
 * Returns 'unknown' when there are no git facts to read. A gate that reports
 * "passed" about a diff nobody looked at is worse than one that admits it
 * could not look: the 1 was indistinguishable in the persisted record from a
 * 1 someone actually verified. computeReward only vetoes on a measured 0, so
 * 'unknown' does not fail the task — it discloses that the check did not run.
 */
function assessTestsUnmodified(git: GitFacts | null): RewardComponents['testsUnmodified'] {
  if (!git) return 'unknown'
  if (git.removed.some(isTestPath)) return 0

  const testChanges = git.changed.filter(c => isTestPath(c.path) && !c.binary)
  if (testChanges.length === 0) return 1

  const productChanged = git.changed.some(c => !isTestPath(c.path))
  if (!productChanged) return 1

  // Per file, not summed across files. A summed net would let an agent delete
  // 200 lines from one suite and pad another with 250 trivial cases to come out
  // positive — the evasion is one extra file away.
  return testChanges.some(c => c.deleted > c.added) ? 0 : 1
}

export function buildComponents(input: TaskOutcomeInput): RewardComponents {
  const lastTest = lastObservation(input.testObservations)
  const testsPass = assessTestsPass(input.testObservations, input.git)
  const greenRun = lastTest !== null && lastTest.passed >= lastTest.total

  let taskCompleted: RewardComponents['taskCompleted']
  // An auto-contract asserts file mechanics — X was modified, changes were
  // committed — because that is all the engine can mine out of a message. It
  // cannot encode what was asked for, so satisfying it is not evidence the task
  // was done. On the L2b run one certified taskCompleted=1 for a run that wrote
  // none of the tests the brief demanded and committed against an explicit
  // instruction not to. Unknown is the honest answer; only an authored contract
  // is a specification.
  if (input.contract?.origin === 'auto') {
    taskCompleted = 'unknown'
  } else if (input.contract && (input.contract.failed > 0 || (input.contract.active && !input.contract.complete))) {
    // An active contract with unmet assertions is 0 even when tests are green:
    // passing tests the contract did not ask for is not the assigned job.
    taskCompleted = 0
  } else if (input.contract?.complete) {
    // Contract assertions are agent-attested, so completion needs corroboration
    // from a real test run before it counts as 1 (decision D3).
    taskCompleted = lastTest === null ? 'unknown' : greenRun ? 1 : 0
  } else {
    taskCompleted = 'unknown'
  }

  const typecheck = input.commandObservations.filter(o => o.kind === 'typecheck')
  const build = input.commandObservations.filter(o => o.kind === 'build')

  let diffClean: RewardComponents['diffClean'] = 'unknown'
  if (input.git) {
    diffClean = input.git.dirty.every(p => wasTracked(p, input.trackedModifiedFiles)) ? 1 : 0
  }

  return {
    testsPass,
    typecheckPass: typecheck.length === 0 ? 'unknown' : typecheck.every(o => o.ok) ? 1 : 0,
    buildPass: build.length === 0 ? 'unknown' : build.every(o => o.ok) ? 1 : 0,
    diffClean,
    taskCompleted,
    stuckTurns: input.stuckTurns,
    iterFraction: input.turns / 500,
    userSatisfaction: 0,
    testsUnmodified: assessTestsUnmodified(input.git),
  }
}
