// scripts/cynco-governance-posiwid.mjs — POSIWID turned on the governance layer.
//
// Stated purpose "regulate": a denial that changed the next call, or a
// recommendation that was consumed. Logging is given NO stated share, so a wave
// in which the layer mostly logged reads Contradicted by construction
// (posiwidDivergence's implicit `other` bucket). The first Contradicted wave is
// the day we stop calling governance a collector — and the day it is written
// down rather than said.
import { constraints } from '../engine/cybernetics-core/src/index.js'
import { denialRecords, complied } from './cynco-triples.mjs'

export const GOVERNANCE_PURPOSE = new constraints.PurposeModel([['denialsChanged', 0.5], ['recommendationsConsumed', 0.5]])
// driftThreshold 0.5, not the naive 0.1: `signalsLogged` carries a stated
// share of exactly 0 (it is not in GOVERNANCE_PURPOSE), so posiwidDivergence's
// implicit `other` bucket sees near-zero expected mass. KL(p||q) blows up on
// ANY nonzero logging share against a ~0 expectation — a wave that mostly
// regulated (12 changed, 10 consumed, only 3 logged of 25) already measures
// divergence ~0.467, well past a 0.1 floor. 0.1 would call every real wave
// Drifting the moment it logs anything at all, which is not what "drift" is
// supposed to mean here. 0.5 clears that reference wave while still well
// under a logging-dominated wave's divergence (~5.5+): Contradicted is
// decided separately (stated share <= 1%), so this only gates Drifting vs
// Consistent for waves that are not already Contradicted.
export const GOVERNANCE_DRIFT = { expectedDivergence: 0.1, driftThreshold: 0.5, minSupport: 20, cusumThreshold: 1.0, cusumSlack: 0.05 }

/** One wave's observed behaviour of the governance layer.
 *
 *  Two known limits of the routed-then-complied term, stated rather than hidden:
 *
 *  1. It reads `routing.entries`, which VerifyFirstRouter caps at the last 20
 *     routes. `routing.count` is uncapped, so in a long wave more routes happened
 *     than this can score. It therefore UNDERCOUNTS consumed recommendations on a
 *     heavily-routed wave — the conservative direction for a measurement whose
 *     whole point is to catch the layer merely logging. Denials have an aggregate
 *     fallback for exactly this (`nextCallClassByInvariant`); routing has none
 *     yet, and adding a `nextCallClassByKind` aggregate to the router snapshot is
 *     the fix if the cap ever bites.
 *  2. A `low-confidence-edit` route is scored with `edit-gap`'s DESIRED classes
 *     (`sourceEdit`/`commit`) because that route has no desired class of its own:
 *     it does not ask the model to do anything, it measures an edit that already
 *     happened. So "complied" here means "kept working on the code afterwards",
 *     NOT "obeyed the verify verdict" — the verify outcome (`passed`/`failed`)
 *     deliberately does not enter this count. Reading it as obedience would
 *     overstate what the routing evidence supports.
 */
export function governanceCounts({ row, wave, proposalsDecided = 0 }) {
  const denials = denialRecords(row ?? {}, { campaign: null, wave: null })
  const denialsChanged = denials.filter(d => d.changed).reduce((a, d) => a + d.count, 0)
  const s5 = row?.s5Decisions ?? []
  const routed = row?.routing?.entries ?? []
  const recommendationsConsumed =
    s5.filter(d => d.enforced === true).length +
    (wave?.s4?.followed === true ? 1 : 0) +
    (wave?.s4?.workOrder?.applied === true ? 1 : 0) +
    (proposalsDecided ?? 0) +
    routed.filter(r => r.nextCallClass && complied(r.kind === 'revert' ? 'revert' : 'edit-gap', r.nextCallClass)).length
  const signalsLogged =
    s5.filter(d => d.enforced !== true).length +
    (row?.controlSignals?.length ?? 0) +
    (row?.turns?.length ?? 0)
  return { denialsChanged, recommendationsConsumed, signalsLogged }
}

const toObserved = (c) => ({ counts: [['denialsChanged', c.denialsChanged], ['recommendationsConsumed', c.recommendationsConsumed], ['signalsLogged', c.signalsLogged]] })

/** Replay every wave's counts through a fresh PosiwidDrift: the onset is a
 *  function of the stored windows, so a runner restart cannot move it. */
export function governancePosiwid(windows) {
  const d = GOVERNANCE_DRIFT
  const drift = new constraints.PosiwidDrift(GOVERNANCE_PURPOSE, d.expectedDivergence, d.driftThreshold, d.minSupport, d.cusumThreshold, d.cusumSlack)
  let onset = null
  for (const w of windows ?? []) { const o = drift.observe(toObserved(w)); if (o !== null && o !== undefined) onset = o }
  const last = windows?.length ? constraints.posiwidDivergence(GOVERNANCE_PURPOSE, toObserved(windows[windows.length - 1]), d.driftThreshold, d.minSupport)
    : { verdict: 'Insufficient', divergence: 0, dominantObserved: 'other', support: 0 }
  // PosiwidDrift numbers windows from 0 (constraints/index.ts:262 `idx = this.windows++`).
  // Windows are NOT guaranteed to start at wave 1 or to be contiguous (a campaign
  // graded before Task 1 has no windows for its early waves; a throwing wave skips
  // the push at cynco-campaign.mjs:391), so read the wave off the stored window and
  // only fall back to the 1-based index when a window carries no `wave`.
  const onsetWave = onset === null || onset === undefined ? null : (windows[onset]?.wave ?? onset + 1)
  return { verdict: last.verdict, divergence: last.divergence, dominantObserved: last.dominantObserved, support: last.support, onsetWave, windows: windows?.length ?? 0 }
}
