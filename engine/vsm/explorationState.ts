// engine/vsm/explorationState.ts
// P4.3 (STATE doc Phase 4(d)): re-reference S3 — classify the variety-high
// regime by where task error is heading. Thrashing (variety high ∧ error flat)
// vs healthy exploration (variety high ∧ error falling) vs floundering
// (variety high ∧ error rising). Measurement only — no S5 rule consumes this
// until it passes the Phase 3 gauntlet.
//
// Pure & stateless: every input is already sealed elsewhere in the governor.
//
// "variety high" gate: turnsObserved >= 4 (floor prevents early-session misfire
// — a single multi-tool turn inflates the ratio) AND
// varietyWindowed / min(turnsObserved, 10) >= 0.6 (window occupancy). Floor and
// threshold are tunable; the gauntlet validates them.

export type ExplorationState = 'healthy_exploration' | 'thrashing' | 'floundering' | null

export function classifyExploration(
  varietyWindowed: number,
  turnsObserved: number,
  errorTrend: 'rising' | 'falling' | 'flat' | null,
): ExplorationState {
  if (turnsObserved < 4) return null
  if (varietyWindowed / Math.min(turnsObserved, 10) < 0.6) return null
  switch (errorTrend) {
    case 'falling': return 'healthy_exploration'
    case 'flat':    return 'thrashing'
    case 'rising':  return 'floundering'
    default:        return null // no active contract → no error signal
  }
}
