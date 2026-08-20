/**
 * commitPressure.ts — a notice for a run that is working and not saving.
 *
 * Measured on CivKings 11k4/11L/11M/11N: mission 11N produced 2 commits in 1805
 * tool calls; 11k4, 11L and 11M produced zero. Eight consecutive missions ended
 * with an uncommitted tree, one of them holding the correct fix in
 * `tick_loyalty` when the loop closed on it.
 *
 * This deliberately does NOT measure editing. Delivery verbs run at 4.9-8.3% of
 * calls with a median inter-verb gap of 0 — the wave edits in healthy bursts. An
 * edit-gap signal fires on ordinary work and stays silent through the real
 * failure. Committing is the thing that is not happening.
 *
 * Stateless by the same argument as iterationBudget.ts: a pure function of the
 * call count means it cannot desynchronise from the loop it is warning.
 *
 * One caution on the evidence above, since F89 was caused by a threshold set
 * against a base nobody had measured: the four runs it rests on all predate the
 * F92 fix (14467c6), which found that 76-90% of compaction summaries were empty.
 * Those runs may have been failing to commit because they could not remember
 * they had been asked to, so the zero-commit *rate* is not safely attributable
 * to pacing. What is not in doubt is the fact this notice reports — that a given
 * run has gone N calls without a commit — because that is measured at the moment
 * it is spoken, in the same window the model reads it.
 */

/**
 * Calls-without-commit at which the first notice fires, and the period after.
 *
 * Base, per the F89 rule (print the base beside the requirement): the p90 gap
 * between source edits, measured over 11k4/11L/11M/11N, is 69/46/44/44 calls,
 * with maxima of 124/202/252/144. 150 is more than twice the highest p90 and
 * above three of the four observed maxima, so it cannot fire on the burst-shaped
 * cadence those runs actually exhibited while working. Replaying the same four
 * call sequences against a calls-since-commit counter, 11N's longest silent
 * stretch was 417 calls — so on the real data this fires, repeatedly, and only
 * where it should.
 */
export const COMMIT_PRESSURE_PERIOD = 150

/**
 * Calls-to-first-source-mutation on the two healthy long missions in the log:
 * 22 on 11O (2490 calls total) and 12 on 11N (1783). Both were briefed to
 * measure before changing anything and both still touched a source file inside
 * the first two dozen calls — the measuring and the changing interleave.
 *
 * Quoted into the clean-tree notice so the model can place itself against a
 * real number rather than a scold, and recorded here so the threshold that
 * speaks it is not mistaken for a guess (F89).
 */
const FIRST_MUTATION_11O = 22
const FIRST_MUTATION_11N = 12

/**
 * The notice to inject when `callsSinceCommit` calls have happened with no new
 * HEAD, or null. Fires on exact multiples of the period so it appears once per
 * threshold rather than on every subsequent call.
 *
 * `treeIsClean` is what `git status --porcelain` says about tracked files, or
 * null when it could not be read. It selects between the two DIFFERENT failures
 * this counter cannot tell apart on its own:
 *
 *   dirty — work has been drafted and not saved. The original failure: eight
 *           consecutive missions ended with an uncommitted tree.
 *   clean — nothing has been drafted at all. Stage 11I's second attempt spent
 *           300 calls and two hours on Read/Grep/Bash and changed no source
 *           file. Both notices fired; both told it to commit work it did not
 *           have, so both were no-ops at the moment they were most needed.
 *
 * Unknown falls back to the unsaved-work wording on purpose. Guessing "clean"
 * would tell a run that DOES hold unsaved work to stop drafting, which is F107
 * — a backstop firing on the healthy case — in a new costume.
 */
export function commitPressureNotice(
  callsSinceCommit: number,
  treeIsClean: boolean | null = null,
): string | null {
  if (callsSinceCommit <= 0) return null
  if (callsSinceCommit % COMMIT_PRESSURE_PERIOD !== 0) return null

  const nth = callsSinceCommit / COMMIT_PRESSURE_PERIOD

  if (treeIsClean === true) {
    const head =
      `[System] You have made ${callsSinceCommit} tool calls and have not changed a ` +
      `single source file. \`git status\` reports no modified tracked file, so there is ` +
      `no draft here to lose — there is no draft at all. Reading is not the deliverable.`

    const base =
      ` For scale: the last two missions of this kind made their first source change at ` +
      `call ${FIRST_MUTATION_11N} and call ${FIRST_MUTATION_11O}, and both had been told ` +
      `to measure before changing anything. Measuring and changing interleave; they are ` +
      `not two phases.`

    if (nth === 1) {
      return head + base +
        ` Make the smallest change you can that would move the number you are measuring, ` +
        `then measure again. A wrong change you can measure teaches you more than another ` +
        `file read, and you can revert it.`
    }

    return head + base +
      ` This is the second time you have been told. A run that ends here delivers nothing ` +
      `at all — not partial work, nothing — and this is how the previous attempt at this ` +
      `task ended. Stop investigating. Edit one file now, on your current best ` +
      `understanding even if it is incomplete, and commit it.`
  }

  const head =
    `[System] You have made ${callsSinceCommit} tool calls since the last commit. ` +
    `Nothing you have done in those calls exists anywhere but this machine's working tree, ` +
    `and the loop can stop between any two calls without a final message.`

  if (nth === 1) {
    return head +
      ` If you have changed a source file and it is even partly right, commit it now. ` +
      `You can correct it in a later commit; you cannot recover it if the loop ends first.`
  }

  return head +
    ` This is the second time you have been told. On the eight previous runs of this kind ` +
    `the work was drafted and then lost exactly here. Stop what you are doing, run ` +
    `\`git status\` and \`git diff --stat\`, and commit whatever is in the tree before ` +
    `continuing — including work you consider unfinished.`
}

/**
 * The threshold that `callsSinceCommit` has reached and that has not been
 * notified yet, or 0 for nothing to say. The return value is always an exact
 * multiple of the period, so it can be handed straight to `commitPressureNotice`.
 *
 * This exists because the two clocks run at different rates. `iterationBudget.ts`
 * can match on an exact index because its iteration counter steps by exactly one
 * per loop pass. This counter steps once per TOOL CALL and is read once per
 * iteration, and this model issues parallel tool batches — 1805 calls across
 * ~900 turns in 11N, so it steps by two or more. Matching on `=== 150` would
 * step straight over the threshold about half the time, and a notice that never
 * fires reads in the ledger as a healthy run rather than a broken instrument.
 */
export function commitPressureDue(callsSinceCommit: number, lastNotifiedAt: number): number {
  if (!Number.isFinite(callsSinceCommit) || callsSinceCommit < COMMIT_PRESSURE_PERIOD) return 0
  const crossed = Math.floor(callsSinceCommit / COMMIT_PRESSURE_PERIOD) * COMMIT_PRESSURE_PERIOD
  return crossed > lastNotifiedAt ? crossed : 0
}
