/**
 * Homeostat Integration — Ashby's ultrastable system for S3/S4/context balance.
 *
 * Replaces hand-rolled HomeostasisMonitor with the library's real classes:
 * - AshbyHomeostat: 3-variable coupled differential equation system
 * - TrendTracker: rolling-window trend detection
 * - calculateBalance: real S3/S4 ratio with epsilon
 * - calculateMetasystem: full 3-4-5 metasystem with S5 arbitration
 *
 * Behavioral effects:
 * - When homeostat is UNSTABLE, randomizeWeights() searches for new equilibrium
 *   (Ashby's ultrastability — random parameter perturbation)
 * - MetasystemState.s5Favor tells S5 which direction to push
 * - TrendTracker detects rising/falling patterns in key metrics
 * - Unstable homeostat triggers S5 advisor to intervene
 */

import {
  homeostat,
  HomeostatBalance,
  TrendDirection,
} from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events, NodeId } from '../cybernetics-core/src/index.js'

// Homeostat unit indices
const S3_UNIT = 0
const S4_UNIT = 1
const CONTEXT_UNIT = 2

/**
 * F165: how far (in pressure units, 0..1) a pressure may sit from its own
 * running level and still count as settled. 0.2 is one quantum of S3 pressure
 * (one tool call = 1/5): a band narrower than the signal's own step can never
 * be met by a turn that calls one tool more or fewer than usual.
 *
 * A FIXED band, not one scaled by the metric's recent variance (spec ruling 4
 * asked for variance scaling; tried and measured): scaled by its own spread
 * (deviation / max(std, 0.1), settled within 2), a pressure that swings
 * between extremes every turn makes the swing its own normal — after 30 turns
 * of alternating extremes (freshTaskGovernance.test.ts) the streak read 0, and
 * the C9 wave 2 stream failed signalsVersion2.test.ts's streak assertions. An
 * oscillation is the instability a homeostat exists to see.
 */
export const STABILITY_BAND = 0.2

/**
 * The unit's reading for this turn: its deviation from the mean of the values
 * the tracker held BEFORE this turn (the set point). 0 on the first turn —
 * there is no running level yet, so the observation is its own set point.
 */
function deviation(tracker: InstanceType<typeof homeostat.TrendTracker>, observed: number): number {
  const prior = tracker.values()
  if (prior.length === 0) return 0
  return observed - prior.reduce((s, v) => s + v, 0) / prior.length
}

export class HomeostatIntegration {
  /** 3-variable Ashby homeostat: S3, S4, context pressure */
  readonly ashby: InstanceType<typeof homeostat.AshbyHomeostat>
  /** Trend trackers for key metrics */
  readonly s3Trend: InstanceType<typeof homeostat.TrendTracker>
  readonly s4Trend: InstanceType<typeof homeostat.TrendTracker>
  readonly contextTrend: InstanceType<typeof homeostat.TrendTracker>
  readonly latencyTrend: InstanceType<typeof homeostat.TrendTracker>

  private nodeId: InstanceType<typeof NodeId>
  private lastBalance: InstanceType<typeof HomeostatBalance> | null = null
  private perturbationCount = 0
  /** The pressures last observed (levels, not deviations). */
  private lastPressures: { s3: number; s4: number } = { s3: 0, s4: 0 }
  /** F165: the last turn's stability verdict, taken before ultrastability. */
  private stableAtLastUpdate = true

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId

    // 3 units: S3 (operations), S4 (intelligence), context pressure
    // Damping = 0.8 (moderately stable)
    // Use Beer's time constant for S3 level (inside-and-now)
    const s3TimeConstant = homeostat.timeConstantForLevel(3)
    this.ashby = new homeostat.AshbyHomeostat(3, 0.8, s3TimeConstant)

    // Initial coupling: S3 and S4 are weakly coupled, context affects both
    this.ashby.setWeight(S3_UNIT, S4_UNIT, -0.3) // S4 inhibits S3 (intelligence reduces operational urgency)
    this.ashby.setWeight(S4_UNIT, S3_UNIT, -0.3) // S3 inhibits S4 (operations reduce exploration time)
    this.ashby.setWeight(S3_UNIT, CONTEXT_UNIT, 0.2) // High context pressure increases S3 urgency
    this.ashby.setWeight(S4_UNIT, CONTEXT_UNIT, -0.2) // High context pressure reduces S4 exploration

    // Trend trackers (20-sample rolling window)
    this.s3Trend = new homeostat.TrendTracker(20)
    this.s4Trend = new homeostat.TrendTracker(20)
    this.contextTrend = new homeostat.TrendTracker(20)
    this.latencyTrend = new homeostat.TrendTracker(20)
  }

  /**
   * Update the homeostat with current system metrics.
   * Call on every turn.
   *
   * @param s3Pressure - operational pressure (0-1): tool calls, failures, urgency
   * @param s4Pressure - intelligence pressure (0-1): task complexity, thinking tokens
   * @param contextPressure - context window utilization (0-1)
   * @param latencyMs - model response latency
   */
  update(s3Pressure: number, s4Pressure: number, contextPressure: number, latencyMs: number): void {
    // F165: the units hold each pressure's DEVIATION from its own running level
    // (the mean of the trailing window, taken before this turn is pushed), not
    // the raw level. The coupled equation
    // dx/dt = (A - hI)x / tau has its only equilibrium at x = 0, and isStable
    // asks whether the drive there is ~0. Fed raw levels, that asked "is every
    // pressure ~0" — unreachable in a mission, where S3 never drops below its
    // 0.1 floor, S4 sits at 0.3-0.8 and context only grows. C9 wave 1 read
    // unstable on all 394 turns; on the C9 wave 2 stream the smallest net drive
    // over 57 turns was 0.215 against a 0.05 bar. In deviation space x = 0 is
    // "the pressures are where they have been": the equilibrium a homeostat
    // regulates toward.
    this.ashby.setState(S3_UNIT, deviation(this.s3Trend, s3Pressure))
    this.ashby.setState(S4_UNIT, deviation(this.s4Trend, s4Pressure))
    this.ashby.setState(CONTEXT_UNIT, deviation(this.contextTrend, contextPressure))
    this.lastPressures = { s3: s3Pressure, s4: s4Pressure }

    // Step the coupled differential equation
    this.ashby.step(1.0) // dt = 1 turn

    // Track trends
    this.s3Trend.push(s3Pressure)
    this.s4Trend.push(s4Pressure)
    this.contextTrend.push(contextPressure)
    this.latencyTrend.push(latencyMs)

    // Calculate balance
    const balance = homeostat.calculateBalance(s3Pressure, s4Pressure)
    this.lastBalance = balance.balance

    // Emit event
    getEventBus().emit(events.DomainEvent.homeostatUpdated(
      this.nodeId,
      balance.balance,
      balance.ratio,
    ))

    // ULTRASTABILITY: if not stable, randomize weights to search for new equilibrium.
    // The turn's verdict is taken BEFORE the randomization and held: asked
    // again after it, the same states under new weights could answer the other
    // way, and the perturbation count and the instability streak would then
    // disagree about the same turn.
    this.stableAtLastUpdate = this.ashby.isStable(this.stabilityTolerance())
    if (!this.stableAtLastUpdate) {
      this.ashby.randomizeWeights(0.5)
      this.perturbationCount++
    }
  }

  /**
   * The derivative bound isStable passes to the core. The core divides the net
   * drive (sum a_ik x_k - h x_i) by tau, so the bound is scaled by tau too; the
   * drive bound itself is h * STABILITY_BAND — an uncoupled unit is settled
   * while its deviation is within the band. (The pre-F165 bar, a drive of 0.05
   * on raw levels, was a pressure of 0.0625: a third of one tool call.)
   */
  private stabilityTolerance(): number {
    return (this.ashby.damping * STABILITY_BAND) / this.ashby.timeConstant
  }

  /**
   * Did the last measured turn read stable — were the pressures near their
   * own running levels? True before any turn (nothing has been perturbed).
   *
   * BEHAVIORAL EFFECT: When unstable, S5 should intervene.
   */
  isStable(): boolean {
    return this.stableAtLastUpdate
  }

  /**
   * Get the full metasystem state (S3/S4/S5).
   */
  getMetasystemState(): ReturnType<typeof homeostat.calculateMetasystem> {
    // Levels, not the units' states: since F165 the units hold deviations.
    const s3 = this.lastPressures.s3
    const s4 = this.lastPressures.s4

    // S5 engagement: higher when system is unstable or perturbation count is high
    const s5Engagement = this.isStable() ? 0.3 : 0.8

    // S5 favor: lean toward whichever system needs support
    let s5Favor: InstanceType<typeof homeostat.S5Favor>
    if (s3 > s4 + 0.2) {
      s5Favor = homeostat.S5Favor.S4Intelligence // operations overloaded, need more intelligence
    } else if (s4 > s3 + 0.2) {
      s5Favor = homeostat.S5Favor.S3Operations // too much thinking, need more doing
    } else {
      s5Favor = homeostat.S5Favor.Neither
    }

    return homeostat.calculateMetasystem(s3, s4, s5Engagement, s5Favor)
  }

  /**
   * The balance classified from the pressures last measured, or null if no turn
   * has been measured yet.
   *
   * This is the reading to report. getBalance() below recomputes from the ashby
   * unit states, which have been stepped through the coupled equation and, when
   * the system is unstable, had their weights randomized — appropriate for
   * asking whether the system is settling, wrong for saying what the S3/S4
   * balance IS. lastBalance is the classification of the numbers that were
   * actually observed.
   *
   * Null rather than a default: before the first turn there are no pressures,
   * and "no reading" is not the same as "balanced" even where they act alike.
   */
  getLastBalance(): InstanceType<typeof HomeostatBalance> | null {
    return this.lastBalance
  }

  /**
   * Get the S3/S4 balance result from the pressures last observed.
   *
   * Before F165 this read the ashby unit states after one Euler step (a shift
   * of at most ~0.02 on the C9 wave 2 stream). Since F165 the units hold
   * deviations from each pressure's running level, which are not pressures, so
   * the balance is computed from the observed levels.
   */
  getBalance(): ReturnType<typeof homeostat.calculateBalance> {
    return homeostat.calculateBalance(this.lastPressures.s3, this.lastPressures.s4)
  }

  /**
   * Get trend directions for all tracked metrics.
   */
  getTrends(): {
    s3: TrendDirection
    s4: TrendDirection
    context: TrendDirection
    latency: TrendDirection
  } {
    return {
      s3: this.s3Trend.direction(),
      s4: this.s4Trend.direction(),
      context: this.contextTrend.direction(),
      latency: this.latencyTrend.direction(),
    }
  }

  /**
   * How many times has ultrastability perturbed the weights?
   */
  getPerturbationCount(): number {
    return this.perturbationCount
  }
}
