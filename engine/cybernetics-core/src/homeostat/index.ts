/**
 * Homeostasis -- maintaining viability through balance.
 *
 * Implements the homeostatic mechanisms of Beer's VSM:
 * - balance: S3/S4 pressure calculation and balance classification
 * - metasystem: Full 3-4-5 metasystem homeostat with S5 arbitration
 * - trend: Rolling-window trend detection
 * - ashby: Ashby's original coupled differential equation homeostat
 * - time: Time constants and relaxation dynamics
 *
 * Conformant with Rust: cybernetics/src/homeostat/
 */

import { HomeostatBalance, classifyHomeostatBalance, TrendDirection, ModificationType } from '../types';

// ============================================================================
// Balance
// ============================================================================

/** S3 (operations) input -- urgency of an operational issue. */
export interface S3Input {
  urgency: number;
}

/** S4 (intelligence) input -- confidence of a trend observation. */
export interface S4Input {
  confidence: number;
}

/** Result of a homeostat balance calculation. */
export interface BalanceResult {
  s3Pressure: number;
  s4Pressure: number;
  ratio: number;
  balance: HomeostatBalance;
  conflict: boolean;
}

/**
 * Pressure from values: (mean(values) + min(count/10, 1.0)) / 2
 */
function pressureFromValues(values: number[]): number {
  if (values.length === 0) {
    return 0.0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const countPressure = Math.min(values.length / 10.0, 1.0);
  return (mean + countPressure) / 2.0;
}

/**
 * Calculate balance from raw pressure values (0.0-1.0).
 * ratio = (s3 + epsilon) / (s4 + epsilon) where epsilon = 0.01
 */
export function calculateBalance(s3Pressure: number, s4Pressure: number): BalanceResult {
  const epsilon = 0.01;
  const ratio = (s3Pressure + epsilon) / (s4Pressure + epsilon);
  const balance = classifyHomeostatBalance(ratio);
  const conflict = s3Pressure > 0.6 && s4Pressure > 0.6;
  return { s3Pressure, s4Pressure, ratio, balance, conflict };
}

/**
 * Calculate balance from structured inputs.
 */
export function calculateBalanceFromInputs(s3Inputs: S3Input[], s4Inputs: S4Input[]): BalanceResult {
  const s3Values = s3Inputs.map(i => i.urgency);
  const s4Values = s4Inputs.map(i => i.confidence);
  const s3Pressure = pressureFromValues(s3Values);
  const s4Pressure = pressureFromValues(s4Values);
  return calculateBalance(s3Pressure, s4Pressure);
}

// ============================================================================
// Metasystem
// ============================================================================

/** S5 favor -- which system S5 leans toward when arbitrating. */
export enum S5Favor {
  S3Operations = 'S3Operations',
  S4Intelligence = 'S4Intelligence',
  Neither = 'Neither',
}

/** Metasystem state: the combined 3-4-5 homeostat. */
export interface MetasystemState {
  s3Pressure: number;
  s4Pressure: number;
  s5Engagement: number;
  balance: HomeostatBalance;
  s5Favor: S5Favor;
  coherence: number;
}

/**
 * Calculate the full metasystem homeostat.
 *
 * - s3Pressure: current operational pressure (0.0-1.0)
 * - s4Pressure: current intelligence/trend pressure (0.0-1.0)
 * - s5Engagement: how actively S5 is engaged (0.0-1.0)
 * - s5Favor: which direction S5 leans
 */
export function calculateMetasystem(
  s3Pressure: number,
  s4Pressure: number,
  s5Engagement: number,
  s5Favor: S5Favor,
): MetasystemState {
  const epsilon = 0.01;

  // Apply S5 bias: S5 can shift effective pressures
  const s5Shift = s5Engagement * 0.2; // max 20% shift
  let effS3: number;
  let effS4: number;

  switch (s5Favor) {
    case S5Favor.S3Operations:
      effS3 = s3Pressure + s5Shift;
      effS4 = s4Pressure - s5Shift * 0.5;
      break;
    case S5Favor.S4Intelligence:
      effS3 = s3Pressure - s5Shift * 0.5;
      effS4 = s4Pressure + s5Shift;
      break;
    case S5Favor.Neither:
      effS3 = s3Pressure;
      effS4 = s4Pressure;
      break;
  }

  // Clamp to [0.0, 1.0]
  effS3 = Math.max(0.0, Math.min(1.0, effS3));
  effS4 = Math.max(0.0, Math.min(1.0, effS4));

  const ratio = (effS3 + epsilon) / (effS4 + epsilon);
  const balance = classifyHomeostatBalance(ratio);

  // Coherence: how well-integrated the metasystem is.
  // High when pressures are moderate and S5 is engaged.
  // Low when extreme imbalance or S5 disengaged.
  const imbalance = Math.abs(effS3 - effS4);
  const coherence = (1.0 - imbalance) * (0.5 + 0.5 * s5Engagement);

  return {
    s3Pressure: effS3,
    s4Pressure: effS4,
    s5Engagement,
    balance,
    s5Favor,
    coherence,
  };
}

// ============================================================================
// Trend
// ============================================================================

/**
 * Rolling window trend tracker.
 * Uses half-window average comparison: diff < 0.1 = Stable.
 */
export class TrendTracker {
  private window: number[] = [];
  private readonly maxSize: number;

  constructor(windowSize: number = 20) {
    this.maxSize = windowSize;
  }

  push(value: number): void {
    if (this.window.length >= this.maxSize) {
      this.window.shift();
    }
    this.window.push(value);
  }

  len(): number {
    return this.window.length;
  }

  isEmpty(): boolean {
    return this.window.length === 0;
  }

  /**
   * Determine trend direction from rolling window.
   * Compares first-half average to second-half average.
   */
  direction(): TrendDirection {
    if (this.window.length < 4) {
      return TrendDirection.Stable;
    }
    const mid = Math.floor(this.window.length / 2);
    let firstHalfSum = 0;
    for (let i = 0; i < mid; i++) {
      firstHalfSum += this.window[i];
    }
    const firstHalf = firstHalfSum / mid;

    let secondHalfSum = 0;
    const secondHalfCount = this.window.length - mid;
    for (let i = mid; i < this.window.length; i++) {
      secondHalfSum += this.window[i];
    }
    const secondHalf = secondHalfSum / secondHalfCount;

    const diff = secondHalf - firstHalf;
    if (Math.abs(diff) < 0.1) {
      return TrendDirection.Stable;
    } else if (diff > 0.0) {
      return TrendDirection.Rising;
    } else {
      return TrendDirection.Falling;
    }
  }

  latest(): number | undefined {
    if (this.window.length === 0) return undefined;
    return this.window[this.window.length - 1];
  }

  values(): readonly number[] {
    return this.window;
  }
}

// ============================================================================
// Ashby Homeostat
// ============================================================================

/**
 * Ashby's original homeostat -- coupled differential equation system.
 *
 * dx_i/dt = (1/tau)(Sum a_ik*x_k - h*x_i)
 * where a_ik are coupling weights, h is damping, tau is time constant.
 */
export class AshbyHomeostat {
  /** State variables for each unit. */
  states: number[];
  /** Coupling matrix (n x n). weights[i][j] = influence of unit j on unit i. */
  weights: number[][];
  /** Damping coefficient (h). Higher = more stable but slower adaptation. */
  readonly damping: number;
  /** Time constant (tau). Lower = faster response. */
  readonly timeConstant: number;
  /** Number of units. */
  readonly n: number;

  constructor(n: number, damping: number, timeConstant: number) {
    this.n = n;
    this.damping = damping;
    this.timeConstant = timeConstant;
    this.states = new Array(n).fill(0.0);
    this.weights = Array.from({ length: n }, () => new Array(n).fill(0.0));
  }

  /** Set coupling weight from unit `from` to unit `to`. */
  setWeight(to: number, from: number, weight: number): void {
    this.weights[to][from] = weight;
  }

  /** Set state of unit i. */
  setState(i: number, value: number): void {
    this.states[i] = value;
  }

  /**
   * Step the homeostat forward by dt using Euler integration.
   * dx_i/dt = (1/tau)(Sum a_ik*x_k - h*x_i)
   */
  step(dt: number): void {
    const derivatives = new Array(this.n).fill(0.0);
    for (let i = 0; i < this.n; i++) {
      let couplingSum = 0.0;
      for (let k = 0; k < this.n; k++) {
        couplingSum += this.weights[i][k] * this.states[k];
      }
      derivatives[i] = (couplingSum - this.damping * this.states[i]) / this.timeConstant;
    }
    for (let i = 0; i < this.n; i++) {
      this.states[i] += derivatives[i] * dt;
    }
  }

  /** Run for `steps` iterations with time step `dt`. */
  run(steps: number, dt: number): void {
    for (let s = 0; s < steps; s++) {
      this.step(dt);
    }
  }

  /** Check if the system has reached equilibrium (all derivatives near zero). */
  isStable(tolerance: number): boolean {
    for (let i = 0; i < this.n; i++) {
      let couplingSum = 0.0;
      for (let k = 0; k < this.n; k++) {
        couplingSum += this.weights[i][k] * this.states[k];
      }
      const derivative = (couplingSum - this.damping * this.states[i]) / this.timeConstant;
      if (Math.abs(derivative) > tolerance) {
        return false;
      }
    }
    return true;
  }

  /**
   * Randomize weights (Ashby's random parameter search for ultrastability).
   * Deterministic pseudo-random based on current state.
   */
  randomizeWeights(magnitude: number): void {
    // Simple deterministic hash-based pseudo-random (matching Rust behavior conceptually)
    for (let i = 0; i < this.n; i++) {
      for (let j = 0; j < this.n; j++) {
        if (i !== j) {
          // Deterministic pseudo-random based on indices and state
          const seed = this.hashState(i, j);
          const random = ((seed % 1000) / 500.0) - 1.0; // [-1.0, 1.0)
          this.weights[i][j] = random * magnitude;
        }
      }
    }
  }

  /** Simple deterministic hash for pseudo-random weight generation. */
  private hashState(i: number, j: number): number {
    // FNV-1a inspired hash of (i, j, states[i] bits, states[j] bits)
    let h = 2166136261;
    const mix = (val: number) => {
      h ^= val & 0xFFFF;
      h = Math.imul(h, 16777619) >>> 0;
      h ^= (val >>> 16) & 0xFFFF;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(i);
    mix(j);
    // Convert float64 to integer bits approximation
    const iBits = Math.floor(this.states[i] * 1e10);
    const jBits = Math.floor(this.states[j] * 1e10);
    mix(iBits);
    mix(jBits);
    return h;
  }
}

// ============================================================================
// Time Constants
// ============================================================================

/** Time constant configuration for a VSM system level. */
export interface TimeConstant {
  /** System level (1-5). */
  level: number;
  /** Base time constant in seconds. */
  tau: number;
  /** Description of the temporal role. */
  description: string;
}

/** Default time constants per Beer's VSM levels. */
export const SYSTEM_TIME_CONSTANTS: readonly TimeConstant[] = [
  { level: 1, tau: 1.0, description: 'S1: Real-time operations' },
  { level: 2, tau: 5.0, description: 'S2: Anti-oscillation coordination' },
  { level: 3, tau: 30.0, description: 'S3: Operational oversight cycle' },
  { level: 4, tau: 300.0, description: 'S4: Trend observation window' },
  { level: 5, tau: 3600.0, description: 'S5: Policy/identity cycle' },
] as const;

/** Relaxation time measurement -- how long a system takes to return to equilibrium. */
export interface RelaxationMeasurement {
  /** System level being measured. */
  level: number;
  /** Initial perturbation magnitude. */
  perturbation: number;
  /** Measured relaxation time (seconds to reach within 5% of equilibrium). */
  relaxationTime: number;
  /** Expected relaxation time (3x time constant is ~95% recovery). */
  expectedTime: number;
  /** Whether relaxation is within acceptable bounds (0.5x to 3x expected). */
  healthy: boolean;
}

/**
 * Measure relaxation health: is the system recovering at the right speed?
 */
export function measureRelaxation(level: number, perturbation: number, relaxationTime: number): RelaxationMeasurement {
  const tau = timeConstantForLevel(level);
  const expected = 3.0 * tau; // 3*tau ~ 95% recovery
  const ratio = relaxationTime / expected;
  const healthy = ratio >= 0.5 && ratio <= 3.0;
  return { level, perturbation, relaxationTime, expectedTime: expected, healthy };
}

/**
 * Get the time constant for a given system level.
 */
export function timeConstantForLevel(level: number): number {
  const tc = SYSTEM_TIME_CONSTANTS.find(tc => tc.level === level);
  return tc ? tc.tau : 1.0;
}
