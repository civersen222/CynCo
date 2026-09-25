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

/**
 * The stuck-loop live re-evaluation's restriction (stuck ≥ 5), and whether it
 * may be applied at all.
 *
 * F157: this site used to narrow the offered tools on any `decision.tools`
 * without consulting `LOCALCODE_S5_ENFORCE`, so a capped headless mission (F7)
 * still had C7 narrow its tools — and, emitting no `s5.decision` frame, the
 * ledger recorded nothing. `enforced` is `isEnforced(isS5EnforcementEnabled(),
 * authority)`, the same predicate every other S5 apply site uses.
 *
 *   - `none`     — the decision restricts nothing;
 *   - `withheld` — it would restrict, but is not enforced (capped or advisory);
 *   - `empty`    — enforced, but the restriction would remove every tool;
 *   - `applied`  — enforced and narrowed.
 */
export function applyStuckReevalRestriction<T extends { name: string }>(
  offered: T[],
  restriction: string[] | null | undefined,
  enforced: boolean,
): { tools: T[]; outcome: 'none' | 'withheld' | 'empty' | 'applied' } {
  if (!restriction) return { tools: offered, outcome: 'none' }
  if (!enforced) return { tools: offered, outcome: 'withheld' }
  const allowed = new Set(restriction)
  const filtered = offered.filter(t => allowed.has(t.name))
  if (filtered.length === 0) return { tools: offered, outcome: 'empty' }
  return { tools: filtered, outcome: 'applied' }
}
