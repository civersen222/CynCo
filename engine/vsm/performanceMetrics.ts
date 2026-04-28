/**
 * Performance Metrics Integration — Beer's Achievement + CUSUM drift detection.
 *
 * Behavioral effects:
 * - Productivity drop below threshold → triggers S3 advisor
 * - High latency (unused capacity) → triggers S4 advisor to find new approaches
 * - CUSUM drift detection → triggers immediate S3* audit cycle
 * - performanceHealth maps to Red/Amber/Green for TUI display
 */

import { metrics } from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events, NodeId, TrendDirection } from '../cybernetics-core/src/index.js'

export class PerformanceMetricsIntegration {
  /** CUSUM detector for tool failure rate drift */
  readonly failureCusum: InstanceType<typeof metrics.CusumDetector>

  private nodeId: InstanceType<typeof NodeId>
  private tasksCompleted = 0
  private tasksAttempted = 0
  private estimatedCapacity = 10 // based on model tier + context remaining
  private _driftDetected = false

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId
    // CUSUM: threshold=3.0 (3 sigma), slack=0.5
    this.failureCusum = new metrics.CusumDetector(3.0, 0.5)
  }

  /**
   * Record a task attempt. Call when user sends a message.
   */
  recordTaskAttempt(): void {
    this.tasksAttempted++
  }

  /**
   * Record a task completion. Call when model returns end_turn after tool use.
   */
  recordTaskCompletion(): void {
    this.tasksCompleted++
  }

  /**
   * Update estimated capacity based on model tier and remaining context.
   */
  updateCapacity(modelTier: string, contextRemaining: number): void {
    // Simple heuristic: advanced models with more context can handle more tasks
    const tierMultiplier = modelTier === 'advanced' ? 1.5 : modelTier === 'standard' ? 1.0 : 0.5
    this.estimatedCapacity = Math.max(1, Math.ceil(contextRemaining * 20 * tierMultiplier))
  }

  /**
   * Feed a failure rate deviation to the CUSUM detector.
   * Returns true if drift is detected.
   *
   * BEHAVIORAL EFFECT: drift triggers immediate S3* audit cycle.
   */
  updateFailureRate(currentRate: number, expectedRate: number): boolean {
    const deviation = currentRate - expectedRate
    this._driftDetected = this.failureCusum.update(deviation)

    if (this._driftDetected) {
      getEventBus().emit(events.DomainEvent.driftDetected(
        this.nodeId,
        'tool_failure_rate',
        deviation,
        deviation > 0 ? TrendDirection.Rising : TrendDirection.Falling,
      ))
    }

    return this._driftDetected
  }

  /**
   * Get Beer's Achievement metrics.
   */
  getAchievement(): InstanceType<typeof metrics.Achievement> {
    // Enforce a <= c <= p
    const a = this.tasksCompleted
    const c = Math.max(a, this.tasksAttempted)
    const p = Math.max(c, this.estimatedCapacity)
    return new metrics.Achievement(a, c, p)
  }

  /**
   * Get performance indices (productivity, latency, performance).
   */
  getIndices(): ReturnType<typeof metrics.performanceIndicesFromAchievement> {
    return metrics.performanceIndicesFromAchievement(this.getAchievement())
  }

  /**
   * Get performance health as a color status.
   *
   * BEHAVIORAL EFFECT:
   * - Red (< 0.3): triggers S3 advisor
   * - Amber (< 0.6): triggers S4 advisor
   * - Green: no intervention
   */
  getHealthStatus(): 'red' | 'amber' | 'green' {
    const indices = this.getIndices()
    const health = metrics.performanceHealth(indices)
    if (health < 0.3) return 'red'
    if (health < 0.6) return 'amber'
    return 'green'
  }

  /** Has CUSUM detected drift? */
  isDriftDetected(): boolean {
    return this._driftDetected
  }

  /** Reset CUSUM detector after addressing drift. */
  resetDrift(): void {
    this.failureCusum.reset()
    this._driftDetected = false
  }
}
