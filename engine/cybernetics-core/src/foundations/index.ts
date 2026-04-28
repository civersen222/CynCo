/**
 * Universal cybernetic primitives.
 *
 * This module implements the foundational theorems and mechanisms of cybernetics:
 *
 * - Variety     -- Ashby's Law of Requisite Variety and Shannon entropy
 * - Feedback    -- Wiener's feedback loops and circular causality
 * - Control     -- Discrete PID control and damping classification
 * - Information -- Shannon channel capacity and Beer's channel sufficiency
 * - Regulator   -- Conant-Ashby Good Regulator Theorem
 * - Ultrastability -- Ashby's nested feedback with parameter search
 *
 * All primitives are pure functions or state machines with no I/O.
 *
 * Conformant TypeScript port of `cybernetics::foundations` (Rust core).
 */

// ===================================================================
// VARIETY -- Ashby's Law of Requisite Variety
// ===================================================================

/**
 * Checks whether the regulator has requisite variety to handle all disturbances.
 *
 * Ashby's Law: V(regulator) >= V(disturbance) is necessary for effective regulation.
 *
 * @param disturbanceVariety - Number of distinct disturbance states
 * @param regulatorVariety   - Number of distinct regulator responses
 * @returns true if requisite variety is satisfied
 */
export function requisiteVariety(
  disturbanceVariety: number,
  regulatorVariety: number,
): boolean {
  return regulatorVariety >= disturbanceVariety;
}

/**
 * Computes Shannon entropy: H(X) = -Sum p_i * log2(p_i).
 *
 * Entropy measures the average information content (in bits) of a probability
 * distribution. It is the fundamental measure of variety in information-theoretic
 * cybernetics.
 *
 * - Maximum entropy occurs with a uniform distribution: H = log2(n)
 * - Minimum entropy (0) occurs when one outcome has probability 1
 * - Probabilities of zero are skipped (0 * log2(0) is taken as 0)
 *
 * @param probabilities - Array of probabilities that should sum to 1.0
 * @returns Shannon entropy in bits (base-2 logarithm). Returns 0.0 for empty input.
 */
export function entropy(probabilities: number[]): number {
  return probabilities
    .filter((p) => p > 0)
    .reduce((sum, p) => sum + -p * Math.log2(p), 0);
}

/**
 * Computes the constraint (variety reduction) of a distribution.
 *
 * Constraint = H_max - H_actual, measuring how much the actual entropy
 * falls below the theoretical maximum.
 *
 * @param maxEntropy    - Maximum possible entropy (e.g., log2(n) for n states)
 * @param actualEntropy - Observed entropy of the distribution
 * @returns The constraint value (non-negative if maxEntropy >= actualEntropy)
 */
export function constraint(
  maxEntropy: number,
  actualEntropy: number,
): number {
  return maxEntropy - actualEntropy;
}

/**
 * Computes mutual information I(X;Y) = H(X) + H(Y) - H(X,Y).
 *
 * Mutual information measures the amount of information that one random variable
 * contains about another. In cybernetic terms, it quantifies the effectiveness
 * of a communication channel between regulator and system.
 *
 * @param hX  - Entropy of variable X
 * @param hY  - Entropy of variable Y
 * @param hXY - Joint entropy of (X, Y)
 * @returns Mutual information I(X;Y) in bits
 */
export function mutualInformation(
  hX: number,
  hY: number,
  hXY: number,
): number {
  return hX + hY - hXY;
}

// ===================================================================
// FEEDBACK -- Wiener's feedback loops and circular causality
// ===================================================================

/** The type of feedback operating in a loop. */
export type FeedbackType =
  | { kind: 'Negative' }
  | { kind: 'Positive' }
  | { kind: 'Delayed'; tau: number };

/** Convenience constructors for FeedbackType. */
export const FeedbackTypes = {
  Negative: { kind: 'Negative' } as FeedbackType,
  Positive: { kind: 'Positive' } as FeedbackType,
  Delayed: (tau: number): FeedbackType => ({ kind: 'Delayed', tau }),
} as const;

/**
 * A feedback loop with a setpoint, gain, and current error state.
 *
 * The loop computes an error signal on each update and tracks its current state.
 * For delayed feedback, a history buffer stores past measurements so that the
 * error is computed against a measurement from tau steps ago.
 */
export class FeedbackLoop {
  /** Human-readable name for this loop. */
  public readonly name: string;
  /** The type of feedback (negative, positive, or delayed). */
  public readonly loopType: FeedbackType;
  /** Loop gain -- multiplied with the error signal. */
  public readonly gain: number;
  /** Target value the system is regulated toward. */
  public setpoint: number;
  /** Current error signal (setpoint - measurement for negative feedback). */
  private current: number = 0;
  /** History buffer for delayed feedback. */
  private history: number[] = [];

  constructor(
    name: string,
    loopType: FeedbackType,
    gain: number,
    setpoint: number,
  ) {
    this.name = name;
    this.loopType = loopType;
    this.gain = gain;
    this.setpoint = setpoint;
  }

  /**
   * Updates the loop with a new measurement and returns the error signal.
   *
   * - Negative: error = setpoint - measurement (drives toward setpoint)
   * - Positive: error = measurement - setpoint (amplifies deviation)
   * - Delayed:  like negative but uses measurement from tau steps ago
   *
   * @param measurement - Current observed value of the controlled variable
   * @returns The raw error signal (before gain is applied)
   */
  update(measurement: number): number {
    let error: number;

    switch (this.loopType.kind) {
      case 'Negative':
        error = this.setpoint - measurement;
        break;
      case 'Positive':
        error = measurement - this.setpoint;
        break;
      case 'Delayed': {
        this.history.push(measurement);
        const delaySteps = Math.ceil(this.loopType.tau);
        let delayedMeasurement: number;
        if (this.history.length > delaySteps) {
          delayedMeasurement =
            this.history[this.history.length - 1 - delaySteps];
        } else {
          // Not enough history yet; use the oldest available measurement
          delayedMeasurement = this.history[0];
        }
        error = this.setpoint - delayedMeasurement;
        break;
      }
    }

    this.current = error;
    return error;
  }

  /** Returns the current error signal from the most recent update. */
  error(): number {
    return this.current;
  }

  /**
   * Determines whether this feedback loop is inherently stable.
   *
   * - Negative feedback with gain < 1.0 is stable (converges).
   * - Positive feedback is never inherently stable (diverges).
   * - Delayed feedback is stable if gain < 1.0.
   */
  isStable(): boolean {
    switch (this.loopType.kind) {
      case 'Negative':
        return Math.abs(this.gain) < 1.0;
      case 'Positive':
        return false;
      case 'Delayed':
        return Math.abs(this.gain) < 1.0;
    }
  }
}

/** Polarity of a causal loop. */
export enum Polarity {
  /** Even number of negative edges -- the loop amplifies deviations. */
  Positive = 'Positive',
  /** Odd number of negative edges -- the loop counteracts deviations. */
  Negative = 'Negative',
}

/**
 * A directed weighted graph of causal influences.
 *
 * Models circular causality where nodes influence each other through
 * edges with signed gains. Used to analyse whether causal loops are
 * stabilising (negative polarity) or amplifying (positive polarity).
 */
export class CausalGraph {
  /** Directed edges: [from, to, gain]. */
  private edges: [string, string, number][] = [];

  /** Adds a directed causal edge (immutable -- returns a new graph). */
  addEdge(from: string, to: string, gain: number): CausalGraph {
    const g = new CausalGraph();
    g.edges = [...this.edges, [from, to, gain]];
    return g;
  }

  /** Adds a directed causal edge in place (mutable). */
  addEdgeMut(from: string, to: string, gain: number): void {
    this.edges.push([from, to, gain]);
  }

  /**
   * Computes the total loop gain around a path.
   *
   * The loop gain is the product of all edge gains along the path.
   * Returns undefined if path has < 2 nodes or any edge is missing.
   */
  loopGain(path: string[]): number | undefined {
    if (path.length < 2) return undefined;

    let gain = 1.0;
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      const edge = this.edges.find((e) => e[0] === from && e[1] === to);
      if (edge === undefined) return undefined;
      gain *= edge[2];
    }
    return gain;
  }

  /**
   * Determines the polarity of a causal loop.
   *
   * Positive if the product of all edge gains is positive (even number of
   * negative edges). Negative if the product is negative (odd number of
   * negative edges). Returns undefined if any edge is missing or gain is zero.
   */
  loopPolarity(path: string[]): Polarity | undefined {
    const gain = this.loopGain(path);
    if (gain === undefined) return undefined;
    if (gain > 0) return Polarity.Positive;
    if (gain < 0) return Polarity.Negative;
    return undefined; // Zero gain has no defined polarity
  }
}

// ===================================================================
// CONTROL -- Discrete PID controller and damping classification
// ===================================================================

/**
 * A discrete-time PID controller.
 *
 * Control law:
 *   u = Kp * e + Ki * dt * integral + Kd * (e - e_prev) / dt
 *
 * Note: The integral accumulates raw error (integral += error), and the
 * integral term is Ki * dt * integral. This matches the Rust core exactly.
 */
export class PidController {
  public readonly kp: number;
  public readonly ki: number;
  public readonly kd: number;
  public readonly dt: number;
  private integral: number = 0;
  private prevError: number = 0;

  /**
   * Creates a new PID controller.
   *
   * @param kp - Proportional gain
   * @param ki - Integral gain
   * @param kd - Derivative gain
   * @param dt - Time step between updates (must be positive)
   * @throws Error if dt is zero or negative
   */
  constructor(kp: number, ki: number, kd: number, dt: number) {
    if (dt <= 0) {
      throw new Error(`Time step dt must be positive, got ${dt}`);
    }
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.dt = dt;
  }

  /**
   * Computes the control signal for the given error.
   *
   * @param error - Current error signal (setpoint - measurement)
   * @returns The control signal u to apply to the actuator
   */
  update(error: number): number {
    this.integral += error;
    const derivative = (error - this.prevError) / this.dt;
    const output =
      this.kp * error +
      this.ki * this.dt * this.integral +
      this.kd * derivative;
    this.prevError = error;
    return output;
  }

  /** Resets the controller state (integral accumulator and previous error). */
  reset(): void {
    this.integral = 0;
    this.prevError = 0;
  }
}

/**
 * Classification of second-order system damping.
 *
 * The damping ratio zeta determines the character of the transient response.
 */
export enum DampingClass {
  /** zeta > 1: Returns to equilibrium slowly without oscillation. */
  Overdamped = 'Overdamped',
  /** zeta = 1: Fastest return to equilibrium without oscillation. */
  CriticallyDamped = 'CriticallyDamped',
  /** 0 < zeta < 1: Returns to equilibrium with decaying oscillation. */
  Underdamped = 'Underdamped',
  /** zeta = 0: Perpetual oscillation at the natural frequency. */
  Undamped = 'Undamped',
}

/**
 * Classifies the damping behaviour of a second-order system.
 *
 * Uses epsilon = 1e-12 for floating-point comparison with exact boundary
 * values (0.0 and 1.0), matching the Rust core.
 *
 * @param zeta - The damping ratio (non-negative)
 * @returns The DampingClass corresponding to the given damping ratio
 */
export function classifyDamping(zeta: number): DampingClass {
  const EPSILON = 1e-12;

  if (Math.abs(zeta) < EPSILON) {
    return DampingClass.Undamped;
  } else if (Math.abs(zeta - 1.0) < EPSILON) {
    return DampingClass.CriticallyDamped;
  } else if (zeta < 1.0) {
    return DampingClass.Underdamped;
  } else {
    return DampingClass.Overdamped;
  }
}

// ===================================================================
// INFORMATION -- Shannon channel capacity and Beer's channel sufficiency
// ===================================================================

/**
 * Re-export Shannon entropy from the variety section.
 * (entropy is already exported above, this comment notes the Rust re-export pattern.)
 */

/**
 * Computes the Shannon-Hartley channel capacity.
 *
 *   C = B * log2(1 + S/N)
 *
 * @param bandwidth      - Channel bandwidth in hertz (non-negative)
 * @param signalToNoise  - Signal-to-noise ratio (linear scale, non-negative)
 * @returns Channel capacity in bits per second
 */
export function channelCapacity(
  bandwidth: number,
  signalToNoise: number,
): number {
  return bandwidth * Math.log2(1.0 + signalToNoise);
}

/**
 * Computes negentropy: the distance from maximum entropy.
 *
 *   J = H_max - H_actual
 *
 * Equivalent to constraint() but framed in Schrodinger's language.
 *
 * @param maxEntropy    - Maximum possible entropy for the system
 * @param actualEntropy - Observed entropy of the system
 * @returns Negentropy value (non-negative if max >= actual)
 */
export function negentropy(
  maxEntropy: number,
  actualEntropy: number,
): number {
  return maxEntropy - actualEntropy;
}

/**
 * Checks whether a channel has sufficient capacity for regulation.
 *
 * Beer's Second Principle of Organisation: the information channel connecting
 * a regulator to its system must carry at least as much variety per unit time
 * as the disturbance source generates.
 *
 * @param sourceVarietyRate - Rate at which disturbance generates variety (bps)
 * @param channelCapacity   - Maximum information rate of the channel (bps)
 * @returns true if channel capacity meets or exceeds source variety rate
 */
export function channelSufficient(
  sourceVarietyRate: number,
  channelCapacity: number,
): boolean {
  return channelCapacity >= sourceVarietyRate;
}

// ===================================================================
// REGULATOR -- Conant-Ashby Good Regulator Theorem
// ===================================================================

/**
 * Computes the Kullback-Leibler divergence D_KL(P || Q).
 *
 * Uses natural logarithm (ln), matching the Rust core.
 *
 *   D_KL(P || Q) = Sum_i P(i) * ln(P(i) / Q(i))
 *
 * @param p - The "true" system distribution (reference)
 * @param q - The model's distribution (approximation)
 * @returns The KL divergence (non-negative). Returns Infinity if any p[i] > 0 while q[i] === 0.
 * @throws Error if p and q have different lengths
 */
export function klDivergence(p: number[], q: number[]): number {
  if (p.length !== q.length) {
    throw new Error(
      `Distributions must have equal length: p has ${p.length}, q has ${q.length}`,
    );
  }

  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i];
    if (pi <= 0) continue;
    const qi = q[i];
    if (qi === 0) return Infinity;
    sum += pi * Math.log(pi / qi);
  }
  return sum;
}

/**
 * Computes model fidelity as a normalised score in [0, 1].
 *
 *   fidelity = 1.0 / (1.0 + D_KL(system || model))
 *
 * A fidelity of 1.0 indicates a perfect model (D_KL = 0).
 * Returns 0.0 if KL divergence is infinite.
 *
 * @param systemDist - The system's actual probability distribution
 * @param modelDist  - The model's probability distribution
 * @returns Fidelity score in [0, 1]
 */
export function modelFidelity(
  systemDist: number[],
  modelDist: number[],
): number {
  const d = klDivergence(systemDist, modelDist);
  if (!isFinite(d)) return 0.0;
  return 1.0 / (1.0 + d);
}

/**
 * Determines whether a model qualifies as a "good regulator."
 *
 * Conant-Ashby (1970): every good regulator of a system must be a model
 * of that system.
 *
 * @param systemDist - The system's actual probability distribution
 * @param modelDist  - The model's probability distribution
 * @param threshold  - Minimum fidelity required to qualify as "good" (in [0, 1])
 * @returns true if model fidelity >= threshold
 */
export function isGoodRegulator(
  systemDist: number[],
  modelDist: number[],
  threshold: number,
): boolean {
  return modelFidelity(systemDist, modelDist) >= threshold;
}

// ===================================================================
// ULTRASTABILITY -- Ashby's nested feedback with parameter search
// ===================================================================

/**
 * An ultrastable system with two nested feedback loops.
 *
 * The fast loop (a FeedbackLoop) handles routine error correction.
 * The slow loop monitors essential variables against their viable bounds
 * and perturbs parameters when viability is lost.
 *
 * Uses a deterministic pseudo-random perturbation (LCG) seeded from the
 * step count, matching the Rust core.
 */
export class UltrastableSystem {
  /** The fast (inner) feedback loop for routine regulation. */
  private fastLoopInner: FeedbackLoop;
  /** Essential variables that must remain within viable bounds. */
  private essentialVariablesInner: number[];
  /** Viable bounds [min, max] for each essential variable. */
  private boundsInner: [number, number][];
  /** Parameters that the slow loop adjusts when viability is lost. */
  private parametersInner: number[];
  /** Step size for parameter perturbation. */
  private stepSize: number;
  /** Internal step counter used as seed for deterministic perturbation. */
  private stepCount: bigint = 0n;

  /**
   * Creates a new ultrastable system.
   *
   * @param fastLoop   - The inner feedback loop for routine regulation
   * @param variables  - Initial values of essential variables
   * @param bounds     - Viable range [min, max] for each essential variable
   * @param parameters - Initial parameter values for the slow loop
   * @param stepSize   - Magnitude of random parameter perturbations
   * @throws Error if variables and bounds have different lengths
   */
  constructor(
    fastLoop: FeedbackLoop,
    variables: number[],
    bounds: [number, number][],
    parameters: number[],
    stepSize: number,
  ) {
    if (variables.length !== bounds.length) {
      throw new Error(
        `Variables and bounds must have equal length: ${variables.length} vs ${bounds.length}`,
      );
    }
    this.fastLoopInner = fastLoop;
    this.essentialVariablesInner = [...variables];
    this.boundsInner = bounds.map((b) => [b[0], b[1]]);
    this.parametersInner = [...parameters];
    this.stepSize = stepSize;
  }

  /**
   * Updates the system with new measurements and returns viability status.
   *
   * Ashby's ultrastability algorithm:
   * 1. Update essential variables with the provided measurements.
   * 2. Run the fast loop with the first measurement.
   * 3. Check viability (all essential variables within bounds).
   * 4. If not viable, perturb parameters (slow loop activation).
   *
   * @param measurements - Current values of essential variables
   * @returns true if system is viable after update; false if parameters were perturbed
   * @throws Error if measurements length differs from essential variables count
   */
  update(measurements: number[]): boolean {
    if (measurements.length !== this.essentialVariablesInner.length) {
      throw new Error(
        `Measurements length (${measurements.length}) must match essential variables (${this.essentialVariablesInner.length})`,
      );
    }

    this.stepCount += 1n;

    // Update essential variables
    for (let i = 0; i < measurements.length; i++) {
      this.essentialVariablesInner[i] = measurements[i];
    }

    // Run the fast loop on the first measurement
    if (measurements.length > 0) {
      this.fastLoopInner.update(measurements[0]);
    }

    // Check viability
    if (this.isViable()) {
      return true;
    }

    // Slow loop: perturb parameters (Ashby's step function)
    this.perturbParameters();
    return false;
  }

  /**
   * Checks whether all essential variables are within their viable bounds.
   */
  isViable(): boolean {
    for (let i = 0; i < this.essentialVariablesInner.length; i++) {
      const v = this.essentialVariablesInner[i];
      const [min, max] = this.boundsInner[i];
      if (v < min || v > max) return false;
    }
    return true;
  }

  /** Returns a copy of the current essential variable values. */
  essentialVariables(): number[] {
    return [...this.essentialVariablesInner];
  }

  /** Returns a copy of the current parameter values. */
  parameters(): number[] {
    return [...this.parametersInner];
  }

  /** Returns the inner fast feedback loop. */
  fastLoop(): FeedbackLoop {
    return this.fastLoopInner;
  }

  /**
   * Perturbs parameters using a deterministic pseudo-random generator.
   *
   * Uses a simple linear congruential generator (LCG) seeded from the step
   * count. Constants match the Rust core (Numerical Recipes LCG).
   *
   * LCG: next = (a * seed + c) mod 2^64
   *   a = 6364136223846793005
   *   c = 1442695040888963407
   *
   * Maps to [-1.0, 1.0] via (seed >> 33) / (2^31 - 0.5) - 1.0
   */
  private perturbParameters(): void {
    // Use BigInt for exact 64-bit wrapping arithmetic matching Rust's wrapping_mul/wrapping_add
    const MASK = (1n << 64n) - 1n;
    const A = 6364136223846793005n;
    const C = 1442695040888963407n;

    let seed = this.stepCount;

    for (let i = 0; i < this.parametersInner.length; i++) {
      // LCG step with wrapping 64-bit arithmetic
      seed = (seed * A + C) & MASK;
      // Map to [-1.0, 1.0] -- matches Rust: ((seed >> 33) as f64) / (u32::MAX as f64 / 2.0) - 1.0
      const shifted = Number(seed >> 33n);
      const normalized = shifted / (4294967295 / 2.0) - 1.0;
      this.parametersInner[i] += this.stepSize * normalized;
    }
  }
}
