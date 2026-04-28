/**
 * Beer's performance metrics -- Achievement, Indices, and CUSUM drift detection.
 *
 * Conformant with Rust: cybernetics/src/metrics/
 */

// ============================================================================
// Achievement
// ============================================================================

/**
 * Beer's achievement metrics (Brain of the Firm Ch.11).
 *
 * Actuality   = what we ARE doing now
 * Capability  = what we COULD be doing (with current resources)
 * Potentiality = what we OUGHT to be doing (with ideal resources)
 *
 * Invariant: 0 <= Actuality <= Capability <= Potentiality
 */
export class Achievement {
  readonly actuality: number;
  readonly capability: number;
  readonly potentiality: number;

  constructor(actuality: number, capability: number, potentiality: number) {
    if (actuality < 0 || capability < 0 || potentiality < 0) {
      throw new Error('Values must be non-negative');
    }
    if (actuality > capability) {
      throw new Error(
        `Actuality (${actuality}) cannot exceed capability (${capability})`
      );
    }
    if (capability > potentiality) {
      throw new Error(
        `Capability (${capability}) cannot exceed potentiality (${potentiality})`
      );
    }
    this.actuality = actuality;
    this.capability = capability;
    this.potentiality = potentiality;
  }

  /**
   * Productivity = Actuality / Capability
   * "How well are we using what we have?"
   */
  productivity(): number {
    if (this.capability === 0.0) return 0.0;
    return this.actuality / this.capability;
  }

  /**
   * Latency = Capability / Potentiality
   * "How much of our potential have we built capacity for?"
   */
  latency(): number {
    if (this.potentiality === 0.0) return 0.0;
    return this.capability / this.potentiality;
  }

  /**
   * Performance = Actuality / Potentiality
   * "Overall: how close are we to what we should be doing?"
   */
  performance(): number {
    if (this.potentiality === 0.0) return 0.0;
    return this.actuality / this.potentiality;
  }
}

// ============================================================================
// Performance Indices
// ============================================================================

/**
 * Beer's complete performance index dashboard for a VSM node.
 */
export interface PerformanceIndices {
  productivity: number; // A/C
  latency: number;      // C/P
  performance: number;  // A/P = productivity * latency
}

/**
 * Create performance indices from an Achievement.
 */
export function performanceIndicesFromAchievement(a: Achievement): PerformanceIndices {
  return {
    productivity: a.productivity(),
    latency: a.latency(),
    performance: a.performance(),
  };
}

/**
 * Overall health score (0.0-1.0). Simple average of three indices.
 */
export function performanceHealth(indices: PerformanceIndices): number {
  return (indices.productivity + indices.latency + indices.performance) / 3.0;
}

// ============================================================================
// CUSUM Drift Detection
// ============================================================================

/**
 * CUSUM (Cumulative Sum) change detection.
 * Detects when a metric drifts from its expected mean.
 * From WageTheory's continuous monitoring pattern.
 *
 * threshold (h): how much cumulative deviation triggers an alarm.
 * slack (k): allowance for natural variation (typically 0.5 * expected shift size).
 */
export class CusumDetector {
  private readonly threshold: number;
  private readonly slack: number;
  private _upper: number = 0.0;
  private _lower: number = 0.0;

  constructor(threshold: number, slack: number) {
    this.threshold = threshold;
    this.slack = slack;
  }

  /**
   * Feed a new deviation value (observation - expected_mean).
   * Returns true if drift is detected.
   */
  update(deviation: number): boolean {
    this._upper = Math.max(0, this._upper + deviation - this.slack);
    this._lower = Math.max(0, this._lower - deviation - this.slack);
    return this._upper > this.threshold || this._lower > this.threshold;
  }

  upper(): number {
    return this._upper;
  }

  lower(): number {
    return this._lower;
  }

  reset(): void {
    this._upper = 0.0;
    this._lower = 0.0;
  }
}
