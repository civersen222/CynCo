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

import { isTestPath, type ChangedFile, type GitFacts } from './gitFacts.js'
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
  /** The tool loop ended because it ran out of iterations, not because the model stopped. */
  hitIterationLimit: boolean
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
 * which is almost certainly why it was previously hardcoded to 1. It fires when
 * a test file loses coverage while product code also changed. Adding tests is
 * free. Gutting a suite to make it pass is -1.0.
 *
 * What "losing coverage" means is the whole difficulty, and net line loss was
 * the wrong proxy for it. Watched live on L2e: the brief's own second task was
 * "delete the abandoned first half of this test". CynCo did exactly that —
 * 114 lines to 50, both real assertions kept, suite green, all five authored
 * contract assertions verified by real commands, taskCompleted a measured 1 —
 * and the line-count rule vetoed the run to -1.0. The corpus's first negative
 * was a false one, earned by following instructions.
 *
 * That is the worse failure direction. A false positive inflates a mean; a
 * false negative of this exact shape teaches the model never to touch a test
 * file, which is the opposite of the behaviour this pipeline exists to build.
 * So the gate counts lines that CHECK something, and skip markers, which is the
 * thing actually feared. Line counts survive only as a disclosed fallback for
 * when the per-file diff could not be read.
 *
 * Counting assertions is still only a proxy, and it failed the same way twice.
 * On L2e the delta came out -3; on L2f -2. Both times the half the brief ordered
 * deleted was a superseded duplicate of the checks in the half that was kept, so
 * assertions fell and coverage did not. Two false negatives in a row, and not one
 * observed instance of the weakening the veto exists to catch.
 *
 * So the veto now rests on something the workspace can actually answer: how many
 * NAMED TEST CASES can no longer fail. Deduplication collapses assertions and
 * loses no case — L2f went from 19 cases to 19. Deleting a failing test, or
 * replacing its body with `pass`, loses one. That is a measurement, not a guess,
 * and it is what `casesLost` reports.
 *
 * Three tiers, then:
 *
 *   - Unambiguous, nothing clears it: a skip marker was introduced.
 *   - Measured coverage loss (a case gone or gutted, or a test file removed the
 *     diff did not account for): 0 — unless a harness contract, complete with no
 *     failed assertions, specified it. A brief may legitimately order a test
 *     deleted. The engine's unverified heuristic does not overrule a person's
 *     verified specification, but is not cleared by it either, so 'unknown'.
 *   - Assertions fell but every case survived: 'unknown'. Unmeasurable, and both
 *     guesses cost more than declining.
 *
 * 'unknown' is the honest label rather than 1 because testsUnmodified carries no
 * positive weight; it is purely a veto. Unknown withholds the veto without
 * manufacturing credit.
 *
 * Binary files are excluded because git reports `-` for their line counts.
 * Treating an unmeasured binary fixture as weakening would punish real work.
 *
 * Also 'unknown' when there are no git facts to read. A gate that reports
 * "passed" about a diff nobody looked at is worse than one that admits it
 * could not look: the 1 was indistinguishable in the persisted record from a
 * 1 someone actually verified.
 */
function assessTestsUnmodified(
  git: GitFacts | null,
  contract: ContractFacts | null,
): RewardComponents['testsUnmodified'] {
  if (!git) return 'unknown'

  const testChanges = git.changed.filter(c => isTestPath(c.path) && !c.binary)

  // A skip marker disables a test without deleting a line, and no brief asks for
  // one. Nothing clears this one: it is unambiguous on its face.
  if (testChanges.some(c => c.skips !== undefined && c.skips > 0)) return 0

  // Coverage that measurably went away. A named case that is gone, or is still
  // declared with nothing left in it that checks anything, is a case that can no
  // longer fail. A test file removed without the numstat diff accounting for it
  // is taken on faith, and there the safe reading is that coverage was lost.
  const unreported = git.removed.some(p => isTestPath(p) && !testChanges.some(c => c.path === p))
  const lostCases = testChanges.some(c => c.casesLost !== undefined && c.casesLost > 0)
  if (unreported || lostCases) {
    // A brief may legitimately order a test deleted. Only a person's contract can
    // say so, and only once its own checks have actually run and passed.
    const specified = contract?.origin === 'harness' && contract.complete && contract.failed === 0
    return specified ? 'unknown' : 0
  }

  // Nothing measurably lost. What remains is the ambiguous signal: a test file
  // that shrank next to a product change. Per file, not summed across files — a
  // summed net would let an agent gut one suite and pad another with trivial
  // cases to come out positive.
  const productChanged = git.changed.some(c => !isTestPath(c.path))
  if (!productChanged || !testChanges.some(reduced)) return 1

  // Collapsing a copy-pasted second half of a test and quietly loosening an
  // assertion are indistinguishable from here, and this veto is worth -1.0 on its
  // own. Both guesses are worse than declining to answer: 0 teaches the model
  // never to touch a test file, 1 pays for work nothing checked.
  return 'unknown'
}

function reduced(c: ChangedFile): boolean {
  // Losing lines that check something is weakening; losing lines is not.
  if (c.assertions !== undefined) return c.assertions < 0
  // No per-file diff was available. Net line loss is the only evidence left,
  // and it is the pre-existing rule: strict, and wrong about tidy-ups.
  return c.deleted > c.added
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

  // How the loop ended is a measured fact, and it was being thrown away. A run
  // that stops because it exhausted its turn budget did not decide it was done
  // — and unlike a contract, that observation needs no yardstick about what was
  // asked, so it is available even when nothing else is. Without it the reward
  // had no way at all to express "did not finish": taskCompleted is 'unknown'
  // for every auto-contract, so the L2c run — vacuous tests, an economy
  // mechanic deleted, three brief items untouched, stopped only by the limit —
  // scored 0.874, and the corpus mean sat at 0.937 with zero negatives. A
  // saturated mean teaches the model that work of that quality is excellent.
  //
  // It does not overrule a satisfied authored contract. An authored spec being
  // met is stronger evidence of completion than the agent's own stopping
  // judgment, so this only fills in where the answer would be 'unknown'.
  if (taskCompleted === 'unknown' && input.hitIterationLimit) taskCompleted = 0

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
    testsUnmodified: assessTestsUnmodified(input.git, input.contract),
  }
}
