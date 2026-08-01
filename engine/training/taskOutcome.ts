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
import { assertionCheck } from '../tools/contractVerify.js'
import type { ContractSnapshot } from '../tools/contract.js'
import type { RewardComponents } from './rewardLabeler.js'

/**
 * `command` is what produced this reading. Optional because records written
 * before it was carried have none, and because nothing may depend on it being
 * there — see assessTestsPass, where its absence restores the older rule
 * exactly.
 */
export type TestObservation = { passed: number; total: number; command?: string }
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
  /**
   * Texts of the assertions the repository CONFIRMED, so a consumer can ask what
   * this contract actually established rather than only how many of its claims
   * held. "Complete with no failures" is a fact about the claims that were made;
   * it says nothing about a subject nobody made a claim on.
   */
  passedAssertions: string[]
}

/**
 * What can honestly be said about the contract this task ran under, or null
 * when it ran under none.
 *
 * Keyed on whether the contract HAS assertions, never on whether it is still
 * active. `resolveUnverified` — the mechanism whose entire purpose is that an
 * unverified run must never report success (contract.ts:182) — forces every
 * pending assertion to failed and then DEACTIVATES the contract so the next
 * task cannot inherit it. Reading `isActive()` here threw the forced failures
 * away along with it, and the two states that collapsed together are the two
 * furthest apart in this file: a task that had no specification, honestly
 * 'unknown', and a task that had one and never satisfied it, a measured 0.
 *
 * The conflation paid, which is why it survived. 'unknown' leaves the reward
 * denominator and 0 does not, so the run that verified nothing scored ABOVE the
 * run that failed openly: Gilded Wave 9d, 115 turns, one assertion never met,
 * reward 0.927. `active` is returned as it truly is — the field was always
 * there for exactly this, and a resolved contract is not an absent one.
 *
 * `failed` is counted off the same array that yields `passedAssertions`, so the
 * two can never disagree about the snapshot they describe.
 */
export function contractFactsFrom(snapshot: ContractSnapshot): ContractFacts | null {
  if (snapshot.assertions.length === 0) return null
  return {
    active: snapshot.active,
    complete: snapshot.complete,
    failed: snapshot.assertions.filter(a => a.status === 'failed').length,
    origin: snapshot.origin,
    passedAssertions: snapshot.assertions.filter(a => a.status === 'passed').map(a => a.text),
  }
}

export type TaskOutcomeInput = {
  testObservations: TestObservation[]
  commandObservations: CommandObservation[]
  contract: ContractFacts | null
  git: GitFacts | null
  trackedModifiedFiles: string[]
  /**
   * The paths already dirty when the task STARTED, or null when that was never
   * measured. Untidiness the task inherited is not untidiness the task caused.
   */
  baselineDirty: string[] | null
  stuckTurns: number
  turns: number
  /** The tool loop ended because it ran out of iterations, not because the model stopped. */
  hitIterationLimit: boolean
  /**
   * The tool loop was aborted by an engine-side failure — a provider error, a
   * context overflow, a crash — rather than by the model or the turn budget.
   *
   * This is not a measurement of the model, and nothing derived from "the run
   * stopped here" may be charged to it. Finding (m): the L3-3.3b run's request
   * exceeded the context llama-server had opened, the loop died mid-way through
   * recording 34 satisfied assertions, and the unresolved contract scored the
   * task incomplete — 0.662 for work that passed 30 of 30 harness checks and
   * took the suite from 429 to 432.
   */
  endedInEngineError: boolean
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
/**
 * Whether two readings came from the same invocation.
 *
 * Whitespace-normalized exact match, and nothing cleverer. `pytest gilded/tests
 * -q` and `pytest gilded/tests -q 2>&1 | tail -5` do cover the same tests and
 * this will not say so — which costs a run the credit it earned, and is the
 * cheap direction to be wrong in. Loosening the match is guessing about scope,
 * and guessing about scope is the defect this whole guard exists to stop.
 */
function sameCommand(a: TestObservation, b: TestObservation): boolean {
  if (!a.command || !b.command) return false
  return a.command.trim() === b.command.trim()
}

/**
 * Did the final reading cover less than the task itself had already run?
 *
 * Exported to nobody, but shared: two components read these observations, and
 * when only one of them applied this rule the other paid for the run it
 * disqualified. Scope is compared by what was RUN, so two readings from the
 * same command cover the same tests however many cases each collected.
 */
function narrowerThanAnEarlierRun(obs: TestObservation[], last: TestObservation): boolean {
  const widest = obs
    .filter(o => !sameCommand(o, last))
    .reduce((m, o) => Math.max(m, o.total), 0)
  return last.total < widest
}

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

  // A green run may only certify a suite it actually covered.
  //
  // Measured on L3-3.3: the engine recorded two observations in 426 turns —
  // turn 37 at total=11 failing=10 (its own new tests, an honest TDD red), then
  // turn 39 at total=1 failing=0 (one test, run alone). Both branches below read
  // that pair as the suite going red to green, so the run scored testsPass 1 —
  // the heaviest weight there is — while the repository stood at 10 failed / 422
  // passed and every one of those failures was a test this run had written.
  //
  // Narrower and green afterwards is not evidence about the
  // suite; it is evidence about those tests. That leaves the denominator rather
  // than inflating it, and the earlier red is not resurrected as the verdict
  // either — it is stale, and what happened after it genuinely was not measured.
  //
  // Finding (cc): compared by totals alone, that rule also fires on runs that
  // never narrowed anything. task-df75bf1b ended 552/552 green having collected
  // 562 earlier; task-aac2741c ended 576/576 green having collected 577, and
  // scored 0.9192 for it. Both ran the whole suite at both ends. What moved was
  // how many cases the same command collected, because the task itself was
  // adding tests — a total is a property of the run, not of the suite.
  //
  // So scope is compared by what was RUN wherever the workspace recorded it.
  // Two readings from the same command cover the same body of tests however
  // many cases each collected, and the later one is the verdict. Where no
  // command was recorded the comparison is unchanged, because a fix to a guard
  // may only ever add information to it.
  if (narrowerThanAnEarlierRun(obs, last)) return 'unknown'

  const first = firstObservation(obs)
  if (first && first.passed < first.total) return 1

  // A line added to a test file is not a test. Finding (q), Gilded L4.1: adding
  // a tab changed the tab tuple, which forced a one-line rewrite of the single
  // assertion that pins it — +1/-1, no new case, the suite 451 before and 451
  // after. Bookkeeping the product change made mandatory, and `added > 0` read
  // it as "the task wrote tests", which is worth 2.0 of a 2.1 denominator once
  // taskCompleted is unknown. That run died on a context overflow without
  // committing and was labelled 0.980, the highest reward in the corpus.
  //
  // A named case that exists now and did not before is a measurement of coverage
  // rather than a proxy for it, and casesLost already had to compute it.
  const testsWritten = git?.changed.some(
    c => isTestPath(c.path) && !c.binary && (c.casesAdded ?? 0) > 0)
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
/**
 * Whether two spellings name the same file.
 *
 * Git reports repo-relative paths with forward slashes; a contract is authored
 * by hand and routinely carries an absolute one
 * (`C:/Users/civer/civkings/gilded/tests/test_ui_broadsheet.py`). Matching on a
 * separator-normalized suffix at a `/` boundary relates the two without
 * pretending to resolve either against a filesystem that may have moved on.
 * The boundary matters: without it `test_ui.py` would be authorized by an
 * assertion about `latest_ui.py`.
 */
function samePath(a: string, b: string): boolean {
  const x = a.replace(/\\/g, '/')
  const y = b.replace(/\\/g, '/')
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

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
  const unreportedRemovals = git.removed.filter(p => isTestPath(p) && !testChanges.some(c => c.path === p))
  const lostIn = testChanges.filter(c => c.casesLost !== undefined && c.casesLost > 0).map(c => c.path)
  if (unreportedRemovals.length > 0 || lostIn.length > 0) {
    // A brief may legitimately order a test deleted, and only a person's contract
    // can say so — but it has to actually SAY so, about the file in question.
    //
    // Finding (w): this used to clear on `origin === 'harness' && complete &&
    // failed === 0`, which is a fact about whichever claims the contract happened
    // to make. Gilded L4.2's contract made twenty-five, every one of them about
    // the product; the run deleted 32 test cases (28 added, net 4 lost), all 25
    // assertions confirmed, and this returned 'unknown' — reward 0.9736 for
    // gutting the suite. A contract silent on test survival is not evidence about
    // test survival, and treating it as evidence is the same scope error as
    // certifying a 432-test suite from a 1-test run (b2bf909).
    //
    // So each losing path must be named by an assertion the repository confirmed:
    // a census floor for a file that lost cases, an absence claim for one that was
    // removed outright. Silence vetoes.
    //
    // This is stricter than the rule 7e82b09 and 7ca162a settled on, deliberately.
    // That rule withheld the veto because the signal was a PROXY (line counts, then
    // assertion counts) that could not tell tidying from weakening, and no channel
    // existed to authorize a legitimate shrink. Both premises have changed:
    // `casesLost` measures cases that can no longer fail, netting renames, and
    // `testCensusAssertion` is an executable way to authorize a loss. A veto on a
    // measurement with an authorization channel is a different object from a veto
    // on a proxy without one. A false negative here is recoverable — quarantine
    // and relabel, done twice. An undetected deletion is not: it enters the corpus
    // and teaches the deletion.
    const authorized = (paths: string[], kind: 'test_census' | 'file_absent') =>
      paths.every(p =>
        (contract?.passedAssertions ?? []).some(text => {
          const check = assertionCheck(text)
          return check?.kind === kind && samePath(check.path, p)
        }))

    const specified =
      contract?.origin === 'harness' &&
      contract.complete &&
      contract.failed === 0 &&
      authorized(lostIn, 'test_census') &&
      authorized(unreportedRemovals, 'file_absent')
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
  // The scope rule assessTestsPass applies, applied here too. It was not, and
  // taskCompleted is worth 1.0: a run could end on `pytest tests/test_one.py`,
  // satisfy an authored contract, and be paid for a suite standing red — with
  // testsPass reading 'unknown' on the very same observations. Two components
  // reading one set of facts may not disagree about what those facts cover.
  //
  // A narrow final run leaves `corroboration` null rather than false, because
  // it is an absent corroboration and not a failed one. A red run that WAS
  // broad enough still corroborates nothing, and that is a measured 0.
  const corroboration = lastTest !== null && !narrowerThanAnEarlierRun(input.testObservations, lastTest)
    ? lastTest
    : null
  const greenRun = corroboration !== null && corroboration.passed >= corroboration.total

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
  } else if (input.contract !== null && input.contract.failed > 0) {
    // The model's own reading of its own work. A crash does not un-fail it.
    taskCompleted = 0
  } else if (input.contract?.active && !input.contract.complete && input.endedInEngineError) {
    // "Unmet" answers two different questions and only one of them is about the
    // model. An assertion the model had every chance to satisfy and did not is a
    // measurement of the model; an assertion left unresolved because the engine
    // cut the run off mid-sentence is a measurement of the engine. Finding (m):
    // charging the second to the model scored the best run in the corpus 0.662.
    taskCompleted = 'unknown'
  } else if (input.contract && (input.contract.failed > 0 || (input.contract.active && !input.contract.complete))) {
    // An active contract with unmet assertions is 0 even when tests are green:
    // passing tests the contract did not ask for is not the assigned job.
    taskCompleted = 0
  } else if (input.contract?.complete) {
    // Contract assertions are agent-attested, so completion needs corroboration
    // from a real test run before it counts as 1 (decision D3).
    taskCompleted = corroboration === null ? 'unknown' : greenRun ? 1 : 0
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
  //
  // It is also not available when the engine killed the run. Exhausting the turn
  // budget is a measurement of the model; being cut off is not, and the two must
  // not be allowed to look alike just because both end with the loop stopping.
  if (taskCompleted === 'unknown' && input.hitIterationLimit && !input.endedInEngineError) {
    taskCompleted = 0
  }

  const typecheck = input.commandObservations.filter(o => o.kind === 'typecheck')
  const build = input.commandObservations.filter(o => o.kind === 'build')

  // Did THIS task leave the tree untidy? The question used to be "is the tree
  // untidy", which is a different question in any repo that was already dirty
  // when the task began — and scores the agent for someone else's leftovers.
  // Measured live: a run that added one file, committed it, and left nothing
  // behind scored diffClean 0 because of three unrelated untracked files that
  // predated it by days.
  //
  // A path the agent DID touch counts against it, inherited or not. The
  // exclusion is for work that was not this task's — not for work this task did
  // and failed to commit. Having authored the mess is the reason to charge for
  // it, and reading it as an excuse is how task-25d8015a scored diffClean 1
  // while ten scratch files it had created itself sat uncommitted in the tree.
  //
  // Array.isArray, not `!== null`: an absent field is `undefined`, which would
  // pass a null check and then behave as an empty baseline — silently reasserting
  // "the tree started clean", the assumption this exists to remove.
  let diffClean: RewardComponents['diffClean'] = 'unknown'
  if (input.git && Array.isArray(input.baselineDirty)) {
    const inherited = new Set(input.baselineDirty)
    const charged = input.git.dirty.filter(
      p => !inherited.has(p) || wasTracked(p, input.trackedModifiedFiles),
    )
    diffClean = charged.length === 0 ? 1 : 0
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
