/**
 * The lifetime of S5's pre-loop tool restriction.
 *
 * S5 decides once per user message, from a governance report assembled before
 * iteration 1 has run. That decision used to be applied by assigning the
 * filtered array back to the tool set handed to the model loop, which meant it
 * held for the entire task with nothing able to widen it again. Finding (j): a
 * reading taken before the task started could leave the model unable to write a
 * file for seventy turns.
 *
 * Every other narrowing in the loop — demoted tools, the tool gate, the live
 * stuck re-evaluation, the contract floor — is recomputed per iteration. This
 * one is now scoped the same way, to the single iteration its evidence
 * describes. From iteration 2 the task has produced observations of its own,
 * and the live re-evaluation re-imposes a restriction on those if the crisis is
 * real. A pre-task reading has no standing over a turn that has since happened.
 */

export type PreLoopRestriction = { tools: string[]; reasoning: string }

/**
 * Narrow `offered` by `restriction`, but only on the iteration the restriction
 * was decided for, and never to nothing.
 *
 * Returns the original array by identity when nothing was narrowed, so callers
 * can log an intervention only when one actually occurred.
 */
export function applyPreLoopRestriction<T extends { name: string }>(
  offered: T[],
  restriction: PreLoopRestriction | null,
  iterationIndex: number,
): { tools: T[]; applied: boolean } {
  if (restriction === null) return { tools: offered, applied: false }
  if (iterationIndex > 0) return { tools: offered, applied: false }

  const allowed = new Set(restriction.tools)
  const filtered = offered.filter(t => allowed.has(t.name))
  // An empty set leaves the model unable to act at all, including unable to
  // recover from whatever prompted the restriction.
  if (filtered.length === 0) return { tools: offered, applied: false }
  if (filtered.length === offered.length) return { tools: offered, applied: false }
  return { tools: filtered, applied: true }
}
