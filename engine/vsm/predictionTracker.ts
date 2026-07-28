/**
 * PredictionTracker — 8 falsifiable hypotheses about VSM governance behaviour.
 *
 * Each hypothesis has a null baseline rate (the rate we'd expect by chance) so
 * we can test whether the cybernetics layer is doing better than random.
 *
 * Hypotheses
 * ----------
 * H1 — Stuck Escape        → stuck + tools restricted → Edit/Write within 3 turns  (null: 0.40)
 * H2 — Nudge Response      → nudge injected → tool type changes next call          (null: 0.50)
 * H3 — Contract Completion → contract created → all assertions pass in 20 iters    (null: 0.50)
 * H4 — Read-to-Edit        → 3+ consecutive reads same file → Edit within 2 turns  (null: 0.30)
 * H5 — Thinking Efficiency → >100 thinking tokens → next tool is action tool       (null: 0.30)
 * H6 — Temperature Effect  → temperature lowered → different tool than last 3       (null: 0.33)
 * H7 — S4 Reflection ROI   → S4 reflection ran → behavior changes in 3 turns       (null: 0.50)
 * H8 — Session Improvement → session edits/min > rolling average                   (null: 0.50)
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

// NOTE: mirrored structurally by PredictionSnapshot.stats in vsm/types.ts
// (types.ts cannot import this file — cycle). Keep the shapes in sync.
export type PredictionStats = {
  hypothesis: HypothesisId
  total: number
  correct: number
  hitRate: number
  /** [lower, upper] Wilson score 95 % CI */
  confidenceInterval: [number, number]
  /** Expected hit rate if the cybernetics layer did nothing. */
  nullBaselineRate: number
  /**
   * Where `nullBaselineRate` came from.
   *
   * 'measured' — the hypothesis's own success predicate, evaluated on the same
   *              tool stream at points where it was NOT triggered. That is what
   *              a null baseline is, and it is the only version of this number
   *              that means anything.
   * 'assumed'  — the hand-written constant in HYPOTHESES. A guess. It was the
   *              only source until 2026-07-28, which made `significantlyBetter`
   *              a comparison against a number nobody had measured.
   */
  nullBaselineSource: 'measured' | 'assumed'
  /** How many untriggered points the measured baseline rests on. 0 when assumed. */
  nullBaselineSamples: number
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

// ─── Hypothesis metadata ─────────────────────────────────────────────────────

/**
 * Hypotheses whose success predicate is a pure function of the recent tool
 * stream, and can therefore be evaluated at an untriggered point to measure
 * what the outcome rate is when governance did nothing.
 *
 * H3 is excluded: its predicate reads the GovernanceReport, whose state at an
 * arbitrary past point is not recoverable. H8 is excluded: it is evaluated once,
 * at session end, so there are no untriggered points within a session.
 */
const TOOL_STREAM_HYPOTHESES = ['H1', 'H2', 'H4', 'H5', 'H6', 'H7'] as const

/**
 * Untriggered observations required before a measured baseline replaces the
 * assumed constant. Below this the measured rate is noisier than the guess it
 * would replace; 20 puts the Wilson half-width around ±0.20 at p=0.5.
 */
const MIN_BASELINE_SAMPLES = 20

/** Hypothesis metadata — names, ASSUMED null baselines, evaluation windows.
 *
 *  These constants were never measured. They are the fallback used until the
 *  session has accumulated MIN_BASELINE_SAMPLES untriggered observations of the
 *  hypothesis's own predicate, and `PredictionStats.nullBaselineSource` says
 *  which of the two a given row used. */
export const HYPOTHESES: Record<HypothesisId, { name: string; nullBaseline: number; evalWindow: number }> = {
  H1: { name: 'Stuck Escape',        nullBaseline: 0.40, evalWindow: 3 },
  H2: { name: 'Nudge Response',      nullBaseline: 0.50, evalWindow: 1 },
  H3: { name: 'Contract Completion', nullBaseline: 0.50, evalWindow: 20 },
  H4: { name: 'Read-to-Edit',        nullBaseline: 0.30, evalWindow: 2 },
  H5: { name: 'Thinking Efficiency', nullBaseline: 0.30, evalWindow: 1 },
  H6: { name: 'Temperature Effect',  nullBaseline: 0.33, evalWindow: 1 },
  H7: { name: 'S4 Reflection ROI',   nullBaseline: 0.50, evalWindow: 3 },
  H8: { name: 'Session Improvement', nullBaseline: 0.50, evalWindow: 0 },
}

// ─── PredictionTracker ────────────────────────────────────────────────────────

export class PredictionTracker {
  /** Session identifier for logging/persistence */
  readonly sessionId: string

  /** Predictions that have been triggered but not yet evaluated */
  openPredictions: Prediction[] = []

  /** Predictions that have been evaluated (closed) */
  completedPredictions: Prediction[] = []

  /** Rolling tool-name window the baseline sampler evaluates predicates against.
   *  Six is the widest slice any predicate takes (H7's `slice(-6, -3)`). */
  private _baselineWindow: string[] = []

  /** Untriggered observations per hypothesis: [successes, total]. */
  private _baseline = new Map<HypothesisId, [number, number]>()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  // ── Null baseline measurement ─────────────────────────────────────────────

  /**
   * Observe one tool call and score every tool-stream hypothesis that is NOT
   * currently triggered.
   *
   * This is the measured null baseline: the hypothesis's own success predicate,
   * asked at a moment when governance did nothing to provoke it. Points where a
   * prediction is open are skipped — counting those would fold the effect being
   * tested into the baseline it is tested against, which is the one way to make
   * this number worse than the guess it replaces.
   */
  observeToolCall(toolName: string): void {
    this._baselineWindow.push(toolName)
    if (this._baselineWindow.length > 6) this._baselineWindow = this._baselineWindow.slice(-6)

    const triggered = new Set(this.openPredictions.map(p => p.hypothesis))
    for (const hyp of TOOL_STREAM_HYPOTHESES) {
      if (triggered.has(hyp)) continue
      const result = evaluateToolPredicate(hyp, this._baselineWindow)
      if (!result) continue
      const [ok, n] = this._baseline.get(hyp) ?? [0, 0]
      this._baseline.set(hyp, [ok + (result.correct ? 1 : 0), n + 1])
    }
  }

  /**
   * The null baseline actually used for a hypothesis, and where it came from.
   * Falls back to the assumed constant below MIN_BASELINE_SAMPLES.
   */
  getNullBaseline(hyp: HypothesisId): { rate: number; source: 'measured' | 'assumed'; samples: number } {
    const [ok, n] = this._baseline.get(hyp) ?? [0, 0]
    if (n >= MIN_BASELINE_SAMPLES) return { rate: ok / n, source: 'measured', samples: n }
    return { rate: HYPOTHESES[hyp].nullBaseline, source: 'assumed', samples: 0 }
  }

  // ── Trigger checks ────────────────────────────────────────────────────────

  /**
   * Check H1, H2, H6 triggers from observable turn-level signals.
   * Call this every turn.
   */
  checkTriggers(
    turn: number,
    context: {
      stuckTurns: number,
      toolsRestricted: boolean,
      nudgeInjected: boolean,
      temperatureLowered: boolean,
      recentTools: string[],
    },
  ): void {
    if (context.stuckTurns >= 5 && context.toolsRestricted) {
      this._openIf('H1', turn, `stuck=${context.stuckTurns},restricted=true`, 'Edit/Write within 3 turns')
    }
    if (context.nudgeInjected) {
      this._openIf('H2', turn, 'nudge_injected', 'tool type changes on next call')
    }
    if (context.temperatureLowered) {
      this._openIf('H6', turn, 'temperature_lowered', 'different tool than last 3 calls')
    }
  }

  /**
   * Check H3, H4, H5, H7 triggers that require external signals.
   * Call this every turn with extended context.
   */
  checkExtendedTriggers(
    turn: number,
    context: {
      contractCreated: boolean,
      consecutiveReadsSameFile: number,
      thinkingTokensLastTurn: number,
      s4ReflectionRan: boolean,
    },
  ): void {
    if (context.contractCreated) {
      this._openIf('H3', turn, 'contract_created', 'all assertions pass within 20 iterations')
    }
    if (context.consecutiveReadsSameFile >= 3) {
      this._openIf('H4', turn, `consecutive_reads=${context.consecutiveReadsSameFile}`, 'Edit follows within 2 turns')
    }
    if (context.thinkingTokensLastTurn > 100) {
      this._openIf('H5', turn, `thinking_tokens=${context.thinkingTokensLastTurn}`, 'next tool is action tool (Edit/Write/Bash)')
    }
    if (context.s4ReflectionRan) {
      this._openIf('H7', turn, 's4_reflection_ran', 'model behavior changes within 3 turns')
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
    recentTools: string[],
  ): void {
    const stillOpen: Prediction[] = []

    for (const p of this.openPredictions) {
      const dueAt = p.triggerTurn + p.evaluationWindow
      if (turn < dueAt) {
        stillOpen.push(p)
        continue
      }

      // Window has elapsed — evaluate
      const result = this._evaluate(p, report, recentTools)
      p.correct = result.correct
      p.actualOutcome = result.actualOutcome
      this.completedPredictions.push(p)
    }

    this.openPredictions = stillOpen
  }

  /**
   * Evaluate session-end hypothesis (H8: session improvement).
   * Call this when the session closes.
   */
  evaluateSessionEnd(
    editsPerMinute: number,
    rollingAvgEditsPerMinute: number,
  ): void {
    const h8Open = this.openPredictions.filter(p => p.hypothesis === 'H8')
    for (const p of h8Open) {
      const improved = editsPerMinute > rollingAvgEditsPerMinute
      p.correct = improved
      p.actualOutcome = `current=${editsPerMinute.toFixed(1)}/min, avg=${rollingAvgEditsPerMinute.toFixed(1)}/min`
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
      const nullBaseline = this.getNullBaseline(hyp)

      stats.push({
        hypothesis: hyp,
        total,
        correct,
        hitRate,
        confidenceInterval: ci,
        nullBaselineRate: nullBaseline.rate,
        nullBaselineSource: nullBaseline.source,
        nullBaselineSamples: nullBaseline.samples,
        significantlyBetter: ci[0] > nullBaseline.rate,
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
    const window = HYPOTHESES[hypothesis].evalWindow
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
    recentTools: string[],
  ): { correct: boolean; actualOutcome: string } {
    const toolOnly = evaluateToolPredicate(p.hypothesis, recentTools)
    if (toolOnly) return toolOnly

    switch (p.hypothesis) {
      case 'H3': {
        const completed = report.stuckTurns === 0 && report.toolSuccessRate > 0.7
        return { correct: completed, actualOutcome: `stuck=${report.stuckTurns}, successRate=${report.toolSuccessRate.toFixed(2)}` }
      }
      case 'H8': {
        return { correct: false, actualOutcome: 'H8 evaluated at session end' }
      }
      default: {
        // Unreachable: evaluateToolPredicate covers every other id. Kept so a
        // newly added hypothesis fails loudly here instead of returning
        // `undefined` and being recorded as a wrong prediction.
        throw new Error(`no evaluator for hypothesis ${p.hypothesis}`)
      }
    }
  }
}

/**
 * The success predicate for every hypothesis that depends only on the recent
 * tool stream. Returns null for the two that do not (H3 reads the governance
 * report, H8 is session-scoped).
 *
 * Extracted from `_evaluate` so the identical predicate can be run at points
 * where the hypothesis was NOT triggered. That is what makes a measured null
 * baseline possible: the same question, asked when governance did nothing.
 */
export function evaluateToolPredicate(
  hypothesis: HypothesisId,
  recentTools: string[],
): { correct: boolean; actualOutcome: string } | null {
  const ACTION_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Bash', 'ApplyPatch']
  const lastN = (n: number) => recentTools.slice(-n)

  switch (hypothesis) {
    case 'H1': {
      const hasAction = recentTools.some(t => ACTION_TOOLS.includes(t))
      return { correct: hasAction, actualOutcome: `action_tools_used=${hasAction}, recent=[${lastN(3).join(',')}]` }
    }
    case 'H2': {
      const beforeNudge = recentTools.slice(-4, -1)
      const afterNudge = recentTools.slice(-1)[0]
      const changed = afterNudge ? !beforeNudge.includes(afterNudge) : false
      return { correct: changed, actualOutcome: `before=[${beforeNudge.join(',')}] after=${afterNudge || 'none'}` }
    }
    case 'H4': {
      const hasEdit = recentTools.slice(-2).some(t => t === 'Edit' || t === 'Write' || t === 'MultiEdit')
      return { correct: hasEdit, actualOutcome: `recent=[${lastN(2).join(',')}]` }
    }
    case 'H5': {
      const nextTool = recentTools[recentTools.length - 1]
      const isAction = nextTool ? ACTION_TOOLS.includes(nextTool) : false
      return { correct: isAction, actualOutcome: `next_tool=${nextTool || 'none'}` }
    }
    case 'H6': {
      const last3 = recentTools.slice(-4, -1)
      const current = recentTools[recentTools.length - 1]
      const different = current ? !last3.includes(current) : false
      return { correct: different, actualOutcome: `last3=[${last3.join(',')}] current=${current || 'none'}` }
    }
    case 'H7': {
      const before = new Set(recentTools.slice(-6, -3))
      const after = new Set(recentTools.slice(-3))
      const changed = ![...after].every(t => before.has(t))
      return { correct: changed, actualOutcome: `before=[${[...before].join(',')}] after=[${[...after].join(',')}]` }
    }
    // H3 reads the governance report and H8 is scored once at session end.
    // Neither is a function of the tool stream, so neither can be sampled at an
    // untriggered point, and both keep their assumed baseline.
    default:
      return null
  }
}
