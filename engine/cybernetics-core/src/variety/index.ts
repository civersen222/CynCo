/**
 * Variety Engineering Module -- metrics, engine, attenuator, amplifier,
 * transducer, and balance equations.
 *
 * Conformant TypeScript port of the Rust cybernetics::variety module.
 */

import {
  VarietyBalance,
  classifyVarietyBalance,
} from '../types';

// ===================================================================
// Metrics -- regulatory variety and amplification factor
// ===================================================================

/**
 * Compute regulatory variety from input count.
 *
 * Formula: max(5, round(5 * log10(max(10, inputCount))))
 *
 * This ensures a minimum regulatory variety of 5, scaling logarithmically
 * with the number of inputs the system must handle.
 */
export function regulatoryVariety(inputCount: number): number {
  const effective = Math.max(inputCount, 10);
  const raw = 5.0 * Math.log10(effective);
  return Math.max(Math.round(raw), 5);
}

/**
 * Compute variety amplification factor from active theories.
 *
 * Formula: 1.0 + (activeTheories * 0.1)
 *
 * Each active theory amplifies the organization's regulatory variety by 10%.
 */
export function amplificationFactor(activeTheories: number): number {
  return 1.0 + activeTheories * 0.1;
}

/**
 * Tracks the ratio between regulatory and environmental variety.
 *
 * The variety ratio is the key diagnostic metric for Ashby's Law:
 *   ratio < 1.0: regulator cannot handle all disturbances (overload)
 *   ratio = 1.0: perfect balance
 *   ratio > 1.0: regulator has excess capacity (underload)
 */
export class VarietyRatio {
  readonly regulatory: number;
  readonly environmental: number;

  constructor(regulatory: number, environmental: number) {
    this.regulatory = regulatory;
    this.environmental = environmental;
  }

  /** The ratio of regulatory to environmental variety. Infinity if env is zero. */
  ratio(): number {
    if (this.environmental === 0) return Infinity;
    return this.regulatory / this.environmental;
  }

  /** Classify the current variety balance. */
  balance(): VarietyBalance {
    return classifyVarietyBalance(this.ratio());
  }
}

// ===================================================================
// Engine -- tracks variety state with history
// ===================================================================

/** A snapshot of variety metrics at a point in time. */
export interface VarietySnapshot {
  inputCount: number;
  filterCount: number;
  activeTheories: number;
  regulatory: number;
  amplified: number;
  ratio: number;
  balance: VarietyBalance;
}

/**
 * Variety engine -- tracks and recalculates variety state.
 *
 * The engine maintains three configurable inputs:
 *   inputCount: number of environmental inputs (disturbances)
 *   filterCount: number of active filters (attenuators)
 *   activeTheories: number of active theories (amplifiers via S4)
 *
 * On recalculate(), it computes the regulatory variety, applies the
 * amplification factor, and derives the ratio and balance.
 */
export class VarietyEngine {
  private inputCount = 0;
  private filterCount = 0;
  private activeTheories = 0;
  private _current: VarietySnapshot | null = null;
  private _history: VarietySnapshot[] = [];

  constructor() {}

  setInputCount(count: number): void {
    this.inputCount = count;
  }

  setFilterCount(count: number): void {
    this.filterCount = count;
  }

  setActiveTheories(count: number): void {
    this.activeTheories = count;
  }

  /**
   * Recalculate variety metrics from current configuration.
   *
   * Pushes the previous snapshot (if any) to history, and computes
   * a new current snapshot.
   */
  recalculate(): void {
    if (this._current !== null) {
      this._history.push(this._current);
    }

    const reg = regulatoryVariety(this.inputCount);
    const amp = amplificationFactor(this.activeTheories);
    const amplified = reg * amp;

    let effectiveInput: number;
    if (this.filterCount > 0) {
      effectiveInput = Math.max(this.inputCount - this.filterCount, 1);
    } else {
      effectiveInput = Math.max(this.inputCount, 1);
    }
    const ratio = amplified / effectiveInput;

    this._current = {
      inputCount: this.inputCount,
      filterCount: this.filterCount,
      activeTheories: this.activeTheories,
      regulatory: reg,
      amplified,
      ratio,
      balance: classifyVarietyBalance(ratio),
    };
  }

  /** Get the current variety snapshot. */
  current(): VarietySnapshot | null {
    return this._current;
  }

  /** Get the history of past variety snapshots. */
  history(): VarietySnapshot[] {
    return this._history;
  }
}

// ===================================================================
// Attenuator -- reduces environmental complexity
// ===================================================================

/**
 * A variety attenuator -- reduces environmental complexity.
 *
 * Beer Heart of Enterprise: attenuators filter incoming variety.
 * The reductionFactor is the fraction of variety that passes through
 * (0.0 = blocks everything, 1.0 = passes everything).
 */
export class Attenuator {
  readonly name: string;
  readonly reductionFactor: number;
  readonly description: string;

  constructor(name: string, reductionFactor: number, description: string) {
    this.name = name;
    this.reductionFactor = Math.min(Math.max(reductionFactor, 0.0), 1.0);
    this.description = description;
  }

  /** Apply this attenuator to an input variety. */
  attenuate(inputVariety: number): number {
    return inputVariety * this.reductionFactor;
  }
}

/**
 * Apply a chain of attenuators sequentially.
 * Each attenuator reduces the variety output by the previous one.
 * Final result: input * r1 * r2 * ... * rN.
 */
export function attenuateChain(
  inputVariety: number,
  attenuators: Attenuator[],
): number {
  return attenuators.reduce(
    (variety, att) => att.attenuate(variety),
    inputVariety,
  );
}

// ===================================================================
// Amplifier -- expands response capacity
// ===================================================================

/**
 * A variety amplifier -- expands response capacity.
 *
 * Beer: amplifiers increase the organization's regulatory variety.
 * The amplificationFactor must be >= 1.0 (1.0 = no amplification).
 */
export class Amplifier {
  readonly name: string;
  readonly amplificationFactor: number;
  readonly description: string;

  constructor(name: string, factor: number, description: string) {
    this.name = name;
    this.amplificationFactor = Math.max(factor, 1.0);
    this.description = description;
  }

  /** Apply this amplifier to a regulatory variety. */
  amplify(regulatoryVariety: number): number {
    return regulatoryVariety * this.amplificationFactor;
  }
}

/**
 * Apply a chain of amplifiers sequentially.
 * Each amplifier multiplies the variety output by the previous one.
 * Final result: variety * f1 * f2 * ... * fN.
 */
export function amplifyChain(
  regulatoryVariety: number,
  amplifiers: Amplifier[],
): number {
  return amplifiers.reduce(
    (variety, amp) => amp.amplify(variety),
    regulatoryVariety,
  );
}

// ===================================================================
// Transducer -- information transduction across boundaries
// ===================================================================

/**
 * A transducer converts information across system boundaries.
 *
 * Beer 3rd Principle: wherever information crosses a boundary, it
 * undergoes transduction. The transducer's variety must >= the channel's
 * variety, or information is lost.
 */
export class Transducer {
  readonly name: string;
  readonly inputVariety: number;
  readonly outputVariety: number;

  constructor(name: string, inputVariety: number, outputVariety: number) {
    this.name = name;
    this.inputVariety = inputVariety;
    this.outputVariety = outputVariety;
  }

  /**
   * Information loss through transduction.
   * Returns max(0, inputVariety - outputVariety). Zero means no loss.
   */
  informationLoss(): number {
    return Math.max(0, this.inputVariety - this.outputVariety);
  }

  /**
   * Is this transducer adequate?
   * Adequate when output variety >= input variety (no information loss).
   */
  isAdequate(): boolean {
    return this.outputVariety >= this.inputVariety;
  }
}

// ===================================================================
// Equations -- Beer's variety balance equations
// ===================================================================

/**
 * Beer Heart of Enterprise: V(E) * Att(E->O) = V(O) * Amp(O->E).
 *
 * Returns the imbalance between the two sides. 0.0 = perfect balance.
 * Positive: environment-side exceeds operations-side.
 * Negative: operations-side exceeds environment-side.
 */
export function varietyBalanceEquation(
  environmentVariety: number,
  attenuation: number,
  operationsVariety: number,
  amplification: number,
): number {
  return (environmentVariety * attenuation) - (operationsVariety * amplification);
}

/**
 * Check if variety balance is achieved (within tolerance).
 */
export function isVarietyBalanced(
  imbalance: number,
  tolerance: number,
): boolean {
  return Math.abs(imbalance) <= tolerance;
}
