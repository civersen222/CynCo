/**
 * Observer Effects Integration — second-order cybernetics.
 *
 * Von Foerster: the observer is part of the system. Different VSM systems
 * measuring the same thing from different perspectives will get different
 * values. That divergence is INFORMATION, not error.
 *
 * Behavioral effects:
 * - Observer divergence triggers S5 arbitration
 * - Non-convergent eigenforms trigger parameter reset
 * - All measurements carry observer metadata for audit
 */

import { observer } from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events, NodeId } from '../cybernetics-core/src/index.js'

export class ObserverEffectsIntegration {
  readonly measurementLog: InstanceType<typeof observer.MeasurementLog>
  private nodeId: InstanceType<typeof NodeId>

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId
    this.measurementLog = new observer.MeasurementLog()
  }

  /**
   * Record a measurement from a specific VSM system observer.
   * ALL metrics should go through this to track observer perspective.
   */
  recordMeasurement(
    observable: string,
    value: number,
    observerSystem: string,
  ): void {
    const m = new observer.Measurement(observable, value, observerSystem)
    m.withTimestamp(Date.now())
    this.measurementLog.record(m)
  }

  /**
   * Check observer divergence for a given observable.
   * High divergence = different VSM systems see the same thing differently.
   *
   * BEHAVIORAL EFFECT: divergence > threshold → S5 arbitration.
   * This is INFORMATION, not error — it means perspectives differ.
   */
  checkDivergence(observable: string, threshold: number = 0.2): {
    divergence: number
    exceeds: boolean
  } {
    const divergence = this.measurementLog.observerDivergence(observable)
    return {
      divergence,
      exceeds: divergence > threshold,
    }
  }

  /**
   * Find the eigenform (fixed point) of a self-assessment function.
   *
   * When the governance system evaluates itself, the eigenform is the
   * self-consistent assessment. If it doesn't converge, the system's
   * self-model is unstable.
   *
   * BEHAVIORAL EFFECT: non-convergent → trigger reset to known-good parameters.
   *
   * @param assessFn - function that maps current assessment to refined assessment
   * @param initialGuess - starting point
   */
  findSelfAssessmentEigenform(
    assessFn: (x: number) => number,
    initialGuess: number,
  ): { converged: boolean; value: number; iterations: number } {
    const result = observer.findEigenform(assessFn, initialGuess, 0.001, 100)

    if (result.converged) {
      getEventBus().emit(events.DomainEvent.eigenformConverged(
        this.nodeId,
        'self_assessment',
        result.iterations,
        result.residual,
      ))
    }

    return {
      converged: result.converged,
      value: result.value,
      iterations: result.iterations,
    }
  }

  /**
   * Check if a fixed point is stable (contraction mapping).
   */
  isStableFixedPoint(
    f: (x: number) => number,
    xStar: number,
  ): boolean {
    return observer.isStableEigenform(f, xStar, 0.001)
  }

  /**
   * Get all measurements by a specific observer.
   */
  getMeasurementsByObserver(observerSystem: string) {
    return this.measurementLog.byObserver(observerSystem)
  }
}
