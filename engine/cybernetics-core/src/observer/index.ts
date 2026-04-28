/**
 * Von Foerster's second-order cybernetics -- eigenforms (fixed-point
 * iteration) and observer-dependent measurement.
 *
 * Conformant TypeScript port of:
 *   - cybernetics::observer::eigenform
 *   - cybernetics::observer::measurement
 */

// ===========================================================================
// Eigenform — fixed points of recursive operations
// ===========================================================================

/**
 * Result of an eigenform search.
 */
export interface EigenformResult {
  /** The fixed-point value found. */
  value: number;
  /** Number of iterations to converge. */
  iterations: number;
  /** Final residual |f(x) - x|. */
  residual: number;
  /** Whether convergence was achieved within tolerance. */
  converged: boolean;
}

/**
 * Find a fixed point x* where f(x*) = x* using simple iteration.
 *
 * Starts from `x0`, applies `f` repeatedly up to `maxIter` times,
 * stopping when |f(x) - x| < tolerance.
 *
 * This is Von Foerster's eigenform: a stable structure that emerges
 * from recursive application of an operation.
 */
export function findEigenform(
  f: (x: number) => number,
  x0: number,
  tolerance: number,
  maxIter: number,
): EigenformResult {
  let x = x0;

  for (let i = 0; i < maxIter; i++) {
    const fx = f(x);
    const residual = Math.abs(fx - x);
    if (residual < tolerance) {
      return {
        value: fx,
        iterations: i + 1,
        residual,
        converged: true,
      };
    }
    x = fx;
  }

  const fx = f(x);
  return {
    value: x,
    iterations: maxIter,
    residual: Math.abs(fx - x),
    converged: false,
  };
}

/**
 * Check stability of a fixed point via numerical derivative.
 * A fixed point is stable if |f'(x*)| < 1 (contraction mapping).
 */
export function isStableEigenform(
  f: (x: number) => number,
  xStar: number,
  epsilon: number,
): boolean {
  const derivative =
    (f(xStar + epsilon) - f(xStar - epsilon)) / (2.0 * epsilon);
  return Math.abs(derivative) < 1.0;
}

/**
 * Find eigenform of a vector-valued function (multi-dimensional).
 * Each component is iterated independently.
 *
 * The function f takes a vector and returns a new vector of the same length.
 */
export function findVectorEigenform(
  f: (x: number[]) => number[],
  x0: number[],
  tolerance: number,
  maxIter: number,
): EigenformResult[] {
  const n = x0.length;
  let x = [...x0];
  const results: EigenformResult[] = new Array(n).fill(null).map(() => ({
    value: 0.0,
    iterations: 0,
    residual: Infinity,
    converged: false,
  }));
  const converged: boolean[] = new Array(n).fill(false);

  for (let iter = 0; iter < maxIter; iter++) {
    const fx = f(x);
    let allConverged = true;

    for (let i = 0; i < n; i++) {
      if (!converged[i]) {
        const residual = Math.abs(fx[i] - x[i]);
        if (residual < tolerance) {
          converged[i] = true;
          results[i] = {
            value: fx[i],
            iterations: iter + 1,
            residual,
            converged: true,
          };
        } else {
          allConverged = false;
        }
      }
    }

    x = fx;
    if (allConverged) {
      break;
    }
  }

  // Fill in non-converged results
  for (let i = 0; i < n; i++) {
    if (!converged[i]) {
      const fx = f(x);
      results[i] = {
        value: x[i],
        iterations: maxIter,
        residual: Math.abs(fx[i] - x[i]),
        converged: false,
      };
    }
  }

  return results;
}

// ===========================================================================
// Observer-dependent measurement (second-order cybernetics)
// ===========================================================================

/**
 * A single measurement that records both the observed value
 * and the observer's state at the time of observation.
 *
 * Every measurement includes both the observed value and the observer's
 * state. The same system may produce different measurements depending
 * on who observes it and from what perspective.
 */
export class Measurement {
  /** The observer's state at the time (key-value context). */
  public observerState: Map<string, string> = new Map();
  /** Timestamp (epoch millis). */
  public timestamp: number = 0;

  constructor(
    /** What was measured. */
    public readonly observable: string,
    /** The observed value. */
    public readonly value: number,
    /** Who/what made the observation. */
    public readonly observer: string,
  ) {}

  /** Add observer state context. Returns this for chaining. */
  withState(key: string, value: string): this {
    this.observerState.set(key, value);
    return this;
  }

  /** Add timestamp. Returns this for chaining. */
  withTimestamp(ts: number): this {
    this.timestamp = ts;
    return this;
  }
}

/**
 * A measurement log that tracks how different observers see the same thing.
 */
export class MeasurementLog {
  private measurements: Measurement[] = [];

  record(measurement: Measurement): void {
    this.measurements.push(measurement);
  }

  /** Get all measurements of a given observable. */
  forObservable(observable: string): Measurement[] {
    return this.measurements.filter((m) => m.observable === observable);
  }

  /** Get all measurements by a given observer. */
  byObserver(observer: string): Measurement[] {
    return this.measurements.filter((m) => m.observer === observer);
  }

  /**
   * Calculate observer divergence: how much do different observers
   * disagree about the same observable?
   *
   * Returns the standard deviation of values for the observable.
   * Uses population std dev (divides by N), matching Rust core.
   */
  observerDivergence(observable: string): number {
    const values = this.forObservable(observable).map((m) => m.value);
    if (values.length < 2) return 0.0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /** Count total measurements. */
  get length(): number {
    return this.measurements.length;
  }

  get isEmpty(): boolean {
    return this.measurements.length === 0;
  }
}
