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

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId

    // 3 units: S3 (operations), S4 (intelligence), context pressure
    // Damping = 0.8 (moderately stable), time constant = 5.0 (S2-level response)
    this.ashby = new homeostat.AshbyHomeostat(3, 0.8, 5.0)

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
    // Set current states
    this.ashby.setState(S3_UNIT, s3Pressure)
    this.ashby.setState(S4_UNIT, s4Pressure)
    this.ashby.setState(CONTEXT_UNIT, contextPressure)

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

    // ULTRASTABILITY: if not stable, randomize weights to search for new equilibrium
    if (!this.ashby.isStable(0.05)) {
      this.ashby.randomizeWeights(0.5)
      this.perturbationCount++
    }
  }

  /**
   * Is the homeostat currently stable?
   *
   * BEHAVIORAL EFFECT: When unstable, S5 should intervene.
   */
  isStable(): boolean {
    return this.ashby.isStable(0.05)
  }

  /**
   * Get the full metasystem state (S3/S4/S5).
   */
  getMetasystemState(): ReturnType<typeof homeostat.calculateMetasystem> {
    const s3 = this.ashby.states[S3_UNIT]
    const s4 = this.ashby.states[S4_UNIT]

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
   * Get the S3/S4 balance result.
   */
  getBalance(): ReturnType<typeof homeostat.calculateBalance> {
    return homeostat.calculateBalance(
      this.ashby.states[S3_UNIT],
      this.ashby.states[S4_UNIT],
    )
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
