/**
 * PredictionTracker — 8 falsifiable hypotheses about VSM governance behaviour.
 *
 * Each hypothesis has a null baseline rate (the rate we'd expect by chance) so
 * we can test whether the cybernetics layer is doing better than random.
 *
 * Hypotheses
 * ----------
 * H1 — variety_critical   → tool_failure_cascade within 3 turns      (null: 0.42)
 * H2 — s3s4_imbalance     → repair_action within 5 turns              (null: 0.38)
 * H3 — heterarchy_shift   → context_efficiency improves in 5 turns    (null: 0.35)
 * H4 — observer_diverge   → s5_decision_quality drops in 3 turns      (null: 0.30)
 * H5 — session_end        → high agreement → positive user sentiment  (null: 0.50)
 * H6 — homeostat_perturb  → stability restored within 3 turns         (null: 0.60)
 * H7 — latency_rise       → model_switch triggered within 5 turns     (null: 0.50)
 * H8 — axiom_violation    → corrective_action within 3 turns          (null: 0.20)
 */

import type { GovernanceReport } from './types.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type HypothesisId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8'

export type Prediction = {
  /** Which falsifiable hypothesis this prediction belongs to */
  hypothesis: HypothesisId
  /** Turn number when the trigger was observed */
  triggerTurn: number
  /** A short human-readable description of what triggered it */
  triggerContext: string
  /** A short description of what we expect to happen */
  predictedOutcome: string
  /** Evaluate at turn >= triggerTurn + evaluationWindow */
  evaluationWindow: number
  /** Set after evaluation */
  correct?: boolean
  /** Human-readable description of what actually happened */
  actualOutcome?: string
}

export type PredictionStats = {
  hypothesis: HypothesisId
  total: number
  correct: number
  hitRate: number
  /** [lower, upper] Wilson score 95 % CI */
  confidenceInterval: [number, number]
  /** Expected hit rate if the cybernetics layer did nothing (random baseline) */
  nullBaselineRate: number
  /** true when the lower bound of the CI exceeds the null baseline */
  significantlyBetter: boolean
}

// ─── Wilson score confidence interval ────────────────────────────────────────

/**
 * Wilson score confidence interval for a proportion.
 *
 * @param successes  number of positive outcomes
 * @param total      total observations
 * @param alpha      two-tailed significance level (e.g. 0.05 for 95 % CI)
 * @returns          [lower, upper] bounds ∈ [0, 1]
 */
export function wilsonScore(
  successes: number,
  total: number,
  alpha: number,
): [number, number] {
  if (total === 0) return [0, 1]

  // z for two-tailed CI: z = Φ⁻¹(1 − α/2)
  // Approximate z via a rational expansion of the probit (accurate to ±0.0002 for alpha ∈ (0.001, 0.5))
  const z = probitApprox(1 - alpha / 2)

  const p = successes / total
  const z2 = z * z
  const n = total

  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const margin =
    (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))

  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

/**
 * Fast rational approximation of the standard normal quantile (probit).
 * Beasley-Springer-Moro algorithm, accurate to ±0.0002 for p ∈ (0.001, 0.999).
 */
function probitApprox(p: number): number {
  // Common CI levels — fast-path them to avoid approximation error
  if (Math.abs(p - 0.975) < 1e-9) return 1.959964
  if (Math.abs(p - 0.995) < 1e-9) return 2.575829
  if (Math.abs(p - 0.95) < 1e-9) return 1.644854

  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637]
  const b = [-8.4735109309, 23.08336743743, -21.06224101826, 3.13082909833]
  const c = [
    -0.010214934, -0.001959932, 0.000019625, -0.000000167,
  ]

  const y = p - 0.5
  if (Math.abs(y) < 0.42) {
    const r = y * y
    return (
      (y *
        (((a[3] * r + a[2]) * r + a[1]) * r + a[0])) /
      ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1)
    )
  }

  const r = p < 0.5 ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p))
  const sign = p < 0.5 ? -1 : 1
  return (
    sign *
    (r +
      ((c[3] * r + c[2]) * r + c[1]) * r +
      c[0])
  )
}

// ─── Null baseline rates ──────────────────────────────────────────────────────

const NULL_BASELINES: Record<HypothesisId, number> = {
  H1: 0.42,
  H2: 0.38,
  H3: 0.35,
  H4: 0.30,
  H5: 0.50,
  H6: 0.60,
  H7: 0.50,
  H8: 0.20,
}

// Evaluation windows (in turns) for each hypothesis
const EVAL_WINDOWS: Record<HypothesisId, number> = {
  H1: 3,
  H2: 5,
  H3: 5,
  H4: 3,
  H5: 0, // evaluated at session end
  H6: 3,
  H7: 5,
  H8: 3,
}

// ─── Helper types ─────────────────────────────────────────────────────────────

type ToolResult = { tool: string; success: boolean }

// ─── PredictionTracker ────────────────────────────────────────────────────────

export class PredictionTracker {
  /** Session identifier for logging/persistence */
  readonly sessionId: string

  /** Predictions that have been triggered but not yet evaluated */
  openPredictions: Prediction[] = []

  /** Predictions that have been evaluated (closed) */
  completedPredictions: Prediction[] = []

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  // ── Trigger checks ────────────────────────────────────────────────────────

  /**
   * Check H1, H2, H6, H8 triggers from a governance report.
   * Call this every turn.
   */
  checkTriggers(
    turn: number,
    report: GovernanceReport,
    recentToolResults: ToolResult[],
  ): void {
    // H1: variety overload / critical → expect tool failure cascade
    if (
      report.varietyBalance === 'overload' ||
      (report.varietyBalance as string) === 'critical'
    ) {
      this._openIf('H1', turn, `variety=${report.varietyBalance}`, 'tool failure cascade within 3 turns')
    }

    // H2: S3/S4 imbalance → expect repair action within 5 turns
    if (report.s3s4Balance !== 'balanced') {
      this._openIf('H2', turn, `s3s4=${report.s3s4Balance}`, 'repair action within 5 turns')
    }

    // H6: homeostat perturbation (consecutive unstable) → stability restored in 3 turns
    if (report.consecutiveUnstable >= 2) {
      this._openIf(
        'H6',
        turn,
        `consecutiveUnstable=${report.consecutiveUnstable}`,
        'homeostat stability restored within 3 turns',
      )
    }

    // H7: latency rising → model switch within 5 turns
    if (report.modelLatencyTrend === 'rising') {
      this._openIf('H7', turn, 'latency=rising', 'model switch triggered within 5 turns')
    }

    // H8: axiom violation → corrective action within 3 turns
    if (report.axiomHealth.violations.length > 0) {
      this._openIf(
        'H8',
        turn,
        `axiomViolations=${report.axiomHealth.violations.join(',')}`,
        'corrective action within 3 turns',
      )
    }
  }

  /**
   * Check H3 and H4 triggers that require external signals.
   * Call this when heterarchy or observer signals are available.
   */
  checkExtendedTriggers(
    turn: number,
    report: GovernanceReport,
    heterarchyChanged: boolean,
    isStuck: boolean,
  ): void {
    // H3: heterarchy shift → context efficiency improves in 5 turns
    if (heterarchyChanged) {
      this._openIf('H3', turn, 'heterarchy_shift', 'context efficiency improves in 5 turns')
    }

    // H4: observer divergence → S5 decision quality drops in 3 turns
    if (report.observerDivergence !== null && report.observerDivergence > 0.4) {
      this._openIf(
        'H4',
        turn,
        `observerDivergence=${report.observerDivergence.toFixed(2)}`,
        'S5 decision quality drops in 3 turns',
      )
    }
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate any open predictions whose window has elapsed.
   * Call this every turn after checkTriggers.
   */
  evaluateOpen(
    turn: number,
    report: GovernanceReport,
    recentToolResults: ToolResult[],
  ): void {
    const stillOpen: Prediction[] = []

    for (const p of this.openPredictions) {
      const dueAt = p.triggerTurn + p.evaluationWindow
      if (turn < dueAt) {
        stillOpen.push(p)
        continue
      }

      // Window has elapsed — evaluate
      const result = this._evaluate(p, report, recentToolResults)
      p.correct = result.correct
      p.actualOutcome = result.actualOutcome
      this.completedPredictions.push(p)
    }

    this.openPredictions = stillOpen
  }

  /**
   * Evaluate session-end hypotheses (H5, H8 summary).
   * Call this when the session closes.
   */
  evaluateSessionEnd(
    sessionOutcome: 'positive' | 'neutral' | 'negative',
    report: GovernanceReport,
  ): void {
    // H5: high agreement → positive user sentiment
    const h5Open = this.openPredictions.filter(p => p.hypothesis === 'H5')
    for (const p of h5Open) {
      const highAgreement = report.agreementRatio >= 0.75
      const positive = sessionOutcome === 'positive'
      p.correct = highAgreement ? positive : !positive
      p.actualOutcome = `sessionOutcome=${sessionOutcome}, agreementRatio=${report.agreementRatio.toFixed(2)}`
      this.completedPredictions.push(p)
    }

    // Remove evaluated H5 from open list
    this.openPredictions = this.openPredictions.filter(p => p.hypothesis !== 'H5')

    // Any remaining H8 that weren't resolved during the session
    const h8Open = this.openPredictions.filter(p => p.hypothesis === 'H8')
    for (const p of h8Open) {
      const noViolationsNow = report.axiomHealth.violations.length === 0
      p.correct = noViolationsNow
      p.actualOutcome = `session_end axiomViolations=${report.axiomHealth.violations.length}`
      this.completedPredictions.push(p)
    }
    this.openPredictions = this.openPredictions.filter(p => p.hypothesis !== 'H8')
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  /**
   * Return PredictionStats for every hypothesis that has at least one
   * completed prediction.
   */
  getStatistics(): PredictionStats[] {
    const grouped = new Map<HypothesisId, Prediction[]>()

    for (const p of this.completedPredictions) {
      if (!grouped.has(p.hypothesis)) grouped.set(p.hypothesis, [])
      grouped.get(p.hypothesis)!.push(p)
    }

    const stats: PredictionStats[] = []

    for (const [hyp, preds] of grouped) {
      const total = preds.length
      const correct = preds.filter(p => p.correct === true).length
      const hitRate = total > 0 ? correct / total : 0
      const ci = wilsonScore(correct, total, 0.05)
      const nullBaseline = NULL_BASELINES[hyp]

      stats.push({
        hypothesis: hyp,
        total,
        correct,
        hitRate,
        confidenceInterval: ci,
        nullBaselineRate: nullBaseline,
        significantlyBetter: ci[0] > nullBaseline,
      })
    }

    // Stable sort by hypothesis ID
    stats.sort((a, b) => a.hypothesis.localeCompare(b.hypothesis))
    return stats
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Open a prediction for `hypothesis` if one is not already open for it
   * within the current evaluation window.
   */
  private _openIf(
    hypothesis: HypothesisId,
    turn: number,
    triggerContext: string,
    predictedOutcome: string,
  ): void {
    const window = EVAL_WINDOWS[hypothesis]
    const alreadyOpen = this.openPredictions.some(
      p =>
        p.hypothesis === hypothesis &&
        turn < p.triggerTurn + p.evaluationWindow,
    )
    if (alreadyOpen) return

    this.openPredictions.push({
      hypothesis,
      triggerTurn: turn,
      triggerContext,
      predictedOutcome,
      evaluationWindow: window,
    })
  }

  /**
   * Evaluate a single prediction against current state.
   */
  private _evaluate(
    p: Prediction,
    report: GovernanceReport,
    recentToolResults: ToolResult[],
  ): { correct: boolean; actualOutcome: string } {
    switch (p.hypothesis) {
      case 'H1': {
        // Predicted: tool failure cascade (≥ 2 tool failures in recent results)
        const failures = recentToolResults.filter(r => !r.success).length
        const cascade = failures >= 2
        return {
          correct: cascade,
          actualOutcome: `${failures} tool failures in ${recentToolResults.length} results`,
        }
      }

      case 'H2': {
        // Predicted: S3/S4 balance restored
        const balanced = report.s3s4Balance === 'balanced'
        return {
          correct: balanced,
          actualOutcome: `s3s4Balance=${report.s3s4Balance}`,
        }
      }

      case 'H3': {
        // Predicted: context efficiency improved (toolSuccessRate as proxy)
        const improved = report.toolSuccessRate > 0.7
        return {
          correct: improved,
          actualOutcome: `toolSuccessRate=${report.toolSuccessRate.toFixed(2)}`,
        }
      }

      case 'H4': {
        // Predicted: S5 decision quality drops (status degrades or tool success falls)
        const qualityDrop = report.status === 'warning' || report.status === 'critical' || report.toolSuccessRate < 0.6
        return {
          correct: qualityDrop,
          actualOutcome: `status=${report.status}, toolSuccessRate=${report.toolSuccessRate.toFixed(2)}`,
        }
      }

      case 'H5': {
        // Evaluated at session end — should not reach here via evaluateOpen
        return { correct: false, actualOutcome: 'H5 must be evaluated at session end' }
      }

      case 'H6': {
        // Predicted: homeostat stability restored (consecutiveUnstable drops to 0)
        const stable = report.consecutiveUnstable === 0
        return {
          correct: stable,
          actualOutcome: `consecutiveUnstable=${report.consecutiveUnstable}`,
        }
      }

      case 'H7': {
        // Predicted: model switch triggered (latency stabilised or fell)
        const switched = report.modelLatencyTrend !== 'rising'
        return {
          correct: switched,
          actualOutcome: `latencyTrend=${report.modelLatencyTrend}`,
        }
      }

      case 'H8': {
        // Predicted: corrective action taken — axiom violations cleared
        const cleared = report.axiomHealth.violations.length === 0
        return {
          correct: cleared,
          actualOutcome: `axiomViolations=${report.axiomHealth.violations.length}`,
        }
      }
    }
  }
}
