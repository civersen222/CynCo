/**
 * Iteration-budget notices for the main model loop.
 *
 * Real incident (CivKings stage 11K/11L, 2026-08-17/18): two consecutive
 * six-hour missions ran 1024 and 1036 tool calls, produced a correct and
 * complete diagnosis of the defect they were sent to fix, and were then cut off
 * by `[loop] Max iterations reached` with an uncommitted tree. Neither run was
 * stuck — governance read `healthy`/`warning` with `stuckTurns=0` throughout, so
 * none of the stuck-loop tiers fired. They simply spent the whole budget
 * measuring, because nothing in the loop ever told them a budget existed.
 *
 * The model can pace itself, but only if it can see the clock. These notices are
 * that clock: one at 70% consumed and one at 90%, each naming the exact
 * iterations remaining and what happens at zero.
 *
 * Deliberately stateless — the notice is a pure function of the iteration index,
 * so it fires exactly once per threshold with no flags to get out of sync.
 */

/** Fractions of the budget at which a notice fires, low to high. */
const THRESHOLDS = [0.7, 0.9] as const

/**
 * The notice to inject before model call `iteration` (0-based), or null.
 *
 * Fires on exactly one iteration per threshold. A budget small enough that two
 * thresholds land on the same index yields one notice, not two.
 */
export function iterationBudgetNotice(iteration: number, maxIterations: number): string | null {
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) return null

  const marks = THRESHOLDS.map(f => Math.floor(maxIterations * f))
  const hit = marks.indexOf(iteration)
  if (hit === -1) return null

  const used = iteration
  const remaining = maxIterations - iteration
  const last = hit === marks.length - 1

  const head =
    `[System] Iteration budget: you have used ${used} of ${maxIterations} model calls. ` +
    `${remaining} remain. When they run out the loop stops mid-task — no summary, ` +
    `no final message, and anything not written to disk and committed is lost.`

  const tail = last
    ? ` This is the last warning you will get. Stop investigating now. Land the ` +
      `smallest correct version of the change you have evidence for, verify it, and ` +
      `commit it. A partial change that is committed beats a complete understanding ` +
      `that is not.`
    : ` If you are still gathering information, stop and make the change you already ` +
      `have evidence for. Commit as soon as something works rather than at the end — ` +
      `a commit is the only thing that survives this loop ending.`

  return head + tail
}
