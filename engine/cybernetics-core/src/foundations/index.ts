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
 * An essential variable: a named quantity that must stay inside `bounds`.
 * `hysteresis` is the fraction of the bound range a variable must re-enter by
 * before it counts as viable again (0 = no hysteresis).
 */
export interface EssentialVariable {
  name: string;
  bounds: [number, number];
  hysteresis: number;
}

/**
 * Ashby's step function. `Continuous` is the legacy parameter vector;
 * `Discrete` is the homeostat's uniselector (a finite ordered set of positions).
 */
export type StepFunction =
  | { kind: 'Continuous'; values: number[]; stepSize: number }
  | { kind: 'Discrete'; positions: string[]; index: number };

/** How the slow loop searches for a new configuration. */
export type SearchStrategy = 'Random' | 'Ordered' | 'Habituated';

export interface UltrastableConfig {
  /** Updates to wait after a step before judging it (the slow loop is slow on purpose). */
  dwell: number;
  strategy: SearchStrategy;
  /** Added to the step count when seeding the LCG; 0n reproduces the legacy sequence. */
  seed: bigint;
}

/**
 * A snapshot of the step function's current value. Same JSON shape as
 * serde's externally-tagged Rust enum: `{ Discrete: string }` / `{ Continuous: number[] }`.
 */
export type Configuration = { Continuous: number[] } | { Discrete: string };

export type Bound = 'Min' | 'Max';

export interface Violation {
  index: number;
  name: string;
  value: number;
  bound: Bound;
  /**
   * Distance outside the effective bound, in the variable's units (always > 0). With
   * hysteresis, the effective bound is narrowed while the variable is in violation, so
   * `excess` is measured against `bound +/- hysteresis * range`, not the raw `bounds` value.
   */
  excess: number;
}

export interface ViabilityReport {
  viable: boolean;
  violations: Violation[];
  /** Minimum normalised distance to a bound across variables; negative when violated. */
  margin: number;
  stepped: boolean;
  configuration: Configuration;
  dwellRemaining: number;
}

/** One slow-loop step and, once known, whether it restored viability. */
export class AdaptationEvent {
  constructor(
    public step: number,
    public violations: string[],
    public from: Configuration,
    public to: Configuration,
    public strategy: SearchStrategy,
    /** Updates after the step until every variable was viable again; null while open or if a later step superseded it. */
    public restoredAfter: number | null,
  ) {}

  /** serde field order and snake_case so JSON matches the Rust core byte for byte. */
  toJSON() {
    return {
      step: this.step,
      violations: this.violations,
      from: this.from,
      to: this.to,
      strategy: this.strategy,
      restored_after: this.restoredAfter,
    };
  }
}

const MASK = (1n << 64n) - 1n;
const LCG_A = 6364136223846793005n;
const LCG_C = 1442695040888963407n;
const lcgNext = (seed: bigint): bigint => (seed * LCG_A + LCG_C) & MASK;
const lcgUnit = (seed: bigint): number => Number(seed >> 33n) / (4294967295 / 2.0) - 1.0;
const retainedKey = (names: string[]): string => [...names].sort().join('+');

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
  private fastLoopInner!: FeedbackLoop;
  private vars!: EssentialVariable[];
  private values!: number[];
  private step!: StepFunction;
  private config!: UltrastableConfig;
  private stepCount: bigint = 0n;
  private dwellRemaining = 0;
  private traceInner: AdaptationEvent[] = [];
  private retainedInner = new Map<string, Configuration>();
  private inViolation!: boolean[];
  private openEvent: number | null = null;
  private updatesSinceStep = 0;

  /**
   * Legacy constructor -- continuous parameters, no dwell, no hysteresis, Random
   * search, seed 0n. Bit-identical to the original implementation.
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
    const vars = bounds.map((b, i) => ({ name: `ev${i}`, bounds: [b[0], b[1]] as [number, number], hysteresis: 0 }));
    const s = UltrastableSystem.withConfig(
      fastLoop,
      vars,
      { kind: 'Continuous', values: [...parameters], stepSize },
      { dwell: 0, strategy: 'Random', seed: 0n },
    );
    Object.assign(this, s);
    this.values = [...variables];
  }

  /**
   * Full constructor (Ashby's homeostat). Initial values are 0 for every variable.
   *
   * @throws Error if `step` is Discrete with no positions, or with an out-of-range index.
   */
  static withConfig(
    fastLoop: FeedbackLoop,
    variables: EssentialVariable[],
    step: StepFunction,
    config: UltrastableConfig,
  ): UltrastableSystem {
    if (step.kind === 'Discrete') {
      if (step.positions.length === 0) {
        throw new Error('Discrete step function needs at least one position');
      }
      if (step.index >= step.positions.length) {
        throw new Error(`Discrete index ${step.index} out of range ${step.positions.length}`);
      }
    }
    const s = Object.create(UltrastableSystem.prototype) as UltrastableSystem;
    s.fastLoopInner = fastLoop;
    s.vars = variables.map((v) => ({ ...v, bounds: [v.bounds[0], v.bounds[1]] }));
    s.values = variables.map(() => 0);
    s.step = step.kind === 'Continuous' ? { ...step, values: [...step.values] } : { ...step, positions: [...step.positions] };
    s.config = { ...config };
    s.stepCount = 0n;
    s.dwellRemaining = 0;
    s.traceInner = [];
    s.retainedInner = new Map();
    s.inViolation = variables.map(() => false);
    s.openEvent = null;
    s.updatesSinceStep = 0;
    return s;
  }

  /** Returns a snapshot of the step function's current value. */
  configuration(): Configuration {
    return this.step.kind === 'Continuous'
      ? { Continuous: [...this.step.values] }
      : { Discrete: this.step.positions[this.step.index] };
  }

  /** Returns the essential variable definitions. */
  variables(): readonly EssentialVariable[] {
    return this.vars;
  }

  /** Returns a copy of the current essential variable values. */
  essentialVariables(): number[] {
    return [...this.values];
  }

  /** Returns a copy of the current parameter values (empty for Discrete). */
  parameters(): number[] {
    return this.step.kind === 'Continuous' ? [...this.step.values] : [];
  }

  /** Returns the inner fast feedback loop. */
  fastLoop(): FeedbackLoop {
    return this.fastLoopInner;
  }

  /** Returns the adaptation trace: one entry per slow-loop step taken via observe(). */
  trace(): readonly AdaptationEvent[] {
    return this.traceInner;
  }

  /**
   * Returns the habituation memory: violated-variable key (sorted names joined with `+`)
   * to the configuration that last restored viability for that combination.
   */
  retained(): ReadonlyMap<string, Configuration> {
    return this.retainedInner;
  }

  /**
   * Checks whether all essential variables are within their viable bounds.
   *
   * Compares current values against bounds directly (inclusive), independent of the
   * hysteresis-tracking `inViolation` state used by observe() -- this is what lets
   * a freshly constructed system with out-of-bounds initial values report `false`
   * before any observation has run.
   */
  isViable(): boolean {
    return this.vars.every((v, i) => this.values[i] >= v.bounds[0] && this.values[i] <= v.bounds[1]);
  }

  /**
   * Minimum normalised distance to a bound across essential variables (negative when
   * violated). Reflects the current values against the plain (non-hysteresis-narrowed)
   * bounds -- the same rule observe() uses to compute ViabilityReport.margin, so the two
   * never diverge for the same state.
   */
  margin(): number {
    return this.computeMargin();
  }

  /**
   * Minimum normalised distance to a bound across essential variables (negative when
   * violated).
   *
   * A zero-range variable (`bounds[0] === bounds[1]`) can only ever sit exactly on its
   * bound: it contributes `0` when its value equals that bound, and `-1` (an arbitrary
   * but always-negative "outside" signal) otherwise. Skipping it instead would silently
   * hide a violated variable from the margin. Shared by observe() and margin() so the
   * two can never diverge.
   */
  private computeMargin(): number {
    let margin = Infinity;
    this.vars.forEach((v, i) => {
      const [min, max] = v.bounds;
      const range = Math.max(max - min, 0);
      const value = this.values[i];
      let dist: number;
      if (range > 0) {
        dist = Math.min((value - min) / range, (max - value) / range);
      } else if (value === min) {
        dist = 0;
      } else {
        dist = -1;
      }
      margin = Math.min(margin, dist);
    });
    return margin === Infinity ? 0 : margin;
  }

  /** Serialises the retained-configuration map to a JSON object. */
  exportRetained(): string {
    return JSON.stringify(Object.fromEntries(this.retainedInner));
  }

  /** Replaces the retained-configuration map from a JSON object produced by exportRetained(). */
  importRetained(json: string): void {
    const parsed = JSON.parse(json) as Record<string, Configuration>;
    this.retainedInner = new Map(Object.entries(parsed));
  }

  /**
   * Legacy API: `true` when viable, `false` when a step was taken (dwell 0 => every
   * non-viable update steps).
   */
  update(measurements: number[]): boolean {
    return this.observe(measurements).viable;
  }

  /**
   * Ashby's ultrastability, one observation:
   * 1. record the measurements and run the fast loop on the first one;
   * 2. judge each essential variable against its bounds (with hysteresis for a variable already in violation);
   * 3. viable -> close the open adaptation event, retain the configuration that restored viability;
   * 4. not viable -> wait out the dwell, else step the step function and open a new event.
   */
  observe(measurements: number[]): ViabilityReport {
    if (measurements.length !== this.values.length) {
      throw new Error(
        `Measurements length (${measurements.length}) must match essential variables (${this.values.length})`,
      );
    }
    this.stepCount += 1n;
    if (this.openEvent !== null) this.updatesSinceStep += 1;
    this.values = [...measurements];
    if (measurements.length > 0) this.fastLoopInner.update(measurements[0]);

    const violations: Violation[] = [];
    this.vars.forEach((v, i) => {
      const [min, max] = v.bounds;
      const range = Math.max(max - min, 0);
      const band = this.inViolation[i] ? v.hysteresis * range : 0;
      const value = this.values[i];
      const lo = min + band;
      const hi = max - band;
      if (value < lo) {
        violations.push({ index: i, name: v.name, value, bound: 'Min', excess: lo - value });
        this.inViolation[i] = true;
      } else if (value > hi) {
        violations.push({ index: i, name: v.name, value, bound: 'Max', excess: value - hi });
        this.inViolation[i] = true;
      } else {
        this.inViolation[i] = false;
      }
    });
    const margin = this.computeMargin();

    let stepped = false;
    if (violations.length === 0) {
      if (this.openEvent !== null) {
        const ev = this.traceInner[this.openEvent];
        ev.restoredAfter = this.updatesSinceStep;
        this.retainedInner.set(retainedKey(ev.violations), this.configuration());
        this.openEvent = null;
      }
      this.dwellRemaining = 0;
      this.updatesSinceStep = 0;
    } else if (this.dwellRemaining > 0) {
      this.dwellRemaining -= 1;
    } else {
      const names = violations.map((v) => v.name);
      const from = this.configuration();
      const used = this.stepConfiguration(names);
      this.traceInner.push(new AdaptationEvent(Number(this.stepCount), names, from, this.configuration(), used, null));
      this.openEvent = this.traceInner.length - 1;
      this.dwellRemaining = this.config.dwell;
      this.updatesSinceStep = 0;
      stepped = true;
    }

    return {
      viable: violations.length === 0,
      violations,
      margin,
      stepped,
      configuration: this.configuration(),
      dwellRemaining: this.dwellRemaining,
    };
  }

  /**
   * Applies one step of the step function. Returns the strategy actually used
   * (Habituated falls back to Random when nothing is retained).
   */
  private stepConfiguration(names: string[]): SearchStrategy {
    if (this.config.strategy === 'Habituated') {
      const retained = this.retainedInner.get(retainedKey(names));
      let applied = false;
      if (retained && 'Discrete' in retained && this.step.kind === 'Discrete') {
        const i = this.step.positions.indexOf(retained.Discrete);
        if (i >= 0 && i !== this.step.index) {
          this.step.index = i;
          applied = true;
        }
      } else if (
        retained && 'Continuous' in retained && this.step.kind === 'Continuous' &&
        retained.Continuous.length === this.step.values.length &&
        retained.Continuous.some((x, i) => x !== (this.step as { values: number[] }).values[i])
      ) {
        this.step.values = [...retained.Continuous];
        applied = true;
      }
      if (applied) return 'Habituated';
      this.stepRandom();
      return 'Random';
    }
    if (this.config.strategy === 'Ordered') {
      if (this.step.kind === 'Discrete') {
        this.step.index = (this.step.index + 1) % this.step.positions.length;
      } else {
        this.step.values = this.step.values.map((v) => v + (this.step as { stepSize: number }).stepSize);
      }
      return 'Ordered';
    }
    this.stepRandom();
    return 'Random';
  }

  /** Legacy perturbation for Continuous; for Discrete, a random position other than the current one. */
  private stepRandom(): void {
    let seed = (this.config.seed + this.stepCount) & MASK;
    if (this.step.kind === 'Continuous') {
      for (let i = 0; i < this.step.values.length; i++) {
        seed = lcgNext(seed);
        this.step.values[i] += this.step.stepSize * lcgUnit(seed);
      }
    } else if (this.step.positions.length > 1) {
      seed = lcgNext(seed);
      const offset = 1 + Number((seed >> 33n) % BigInt(this.step.positions.length - 1));
      this.step.index = (this.step.index + offset) % this.step.positions.length;
    }
  }
}
