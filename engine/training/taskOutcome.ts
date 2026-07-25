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
export type ContractFacts = { active: boolean; complete: boolean; failed: number }

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
 */
function assessTestsUnmodified(git: GitFacts | null): 0 | 1 {
  if (!git) return 1
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
  // Clamped: a parser reporting passed > total would otherwise hand Task 6's
  // weighted mean a component above its ceiling.
  const testsPass = lastTest ? Math.min(1, lastTest.passed / lastTest.total) : 'unknown'
  const greenRun = lastTest !== null && lastTest.passed >= lastTest.total

  let taskCompleted: RewardComponents['taskCompleted']
  if (input.contract && (input.contract.failed > 0 || (input.contract.active && !input.contract.complete))) {
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
