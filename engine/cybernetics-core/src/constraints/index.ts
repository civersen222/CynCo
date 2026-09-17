/**
 * Beer principle enforcement -- S4 trend validation, autonomy constraints,
 * and freedom as residual variety.
 *
 * Conformant TypeScript port of:
 *   - cybernetics::constraints::beer
 *   - cybernetics::constraints::autonomy
 *   - cybernetics::constraints::freedom
 */

import { TrendDirection, AutonomyConstraint, NodeId } from '../types';
import { klDivergence } from '../foundations';
import { CusumDetector } from '../metrics';

// ===========================================================================
// Beer — S4 trend validation
// ===========================================================================

/**
 * Words that indicate a recommendation rather than an observation.
 * EXACT list from Rust core.
 */
const RECOMMENDATION_WORDS: readonly string[] = [
  'should',
  'must',
  'recommend',
  'suggest',
  'advise',
  'need to',
  'ought to',
  'have to',
  'propose that',
  "let's",
  'we should',
  'i recommend',
];

/** Error thrown when S4 produces recommendation language. */
export class BeerViolationError extends Error {
  constructor(detail: string) {
    super(
      `S4 produced recommendation language: ${detail}. S4 may only observe and report trends.`,
    );
    this.name = 'BeerViolationError';
  }
}

/**
 * S4 output type -- an observed trend, NOT a recommendation.
 * Domain is a string because this library is domain-agnostic.
 *
 * Constructor validates that description contains no recommendation language.
 */
export class Trend {
  constructor(
    public readonly domain: string,
    public readonly direction: TrendDirection,
    public readonly magnitude: number,
    public readonly description: string,
  ) {
    this.validate();
  }

  /**
   * Validate that this trend contains no recommendation language.
   * Throws BeerViolationError if a recommendation word is found.
   */
  validate(): void {
    const lower = this.description.toLowerCase();
    for (const word of RECOMMENDATION_WORDS) {
      if (lower.includes(word)) {
        throw new BeerViolationError(
          `found '${word}' in: ${this.description}`,
        );
      }
    }
  }
}

/**
 * Beer's POSIWID: "The Purpose Of a System Is What It Does"
 * Compare stated purpose vs observed behavior.
 *
 * Simple heuristic: checks whether any observed output contains
 * at least one word from the stated purpose (case-insensitive).
 *
 * @deprecated use posiwidDivergence: a purpose is a distribution over what
 * the system does, not a word list
 */
export function posiwidCheck(
  statedPurpose: string,
  observedOutputs: readonly string[],
): boolean {
  const purposeWords = statedPurpose
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (purposeWords.length === 0) {
    return false;
  }

  return observedOutputs.some((output) => {
    const lowerOutput = output.toLowerCase();
    return purposeWords.some((word) => lowerOutput.includes(word));
  });
}

// ===========================================================================
// Beer — POSIWID as a measurement (divergence, verdict, drift)
// ===========================================================================

const POSIWID_EPS = 1e-3;
/** A dominant observed category whose stated share is at or below this is a contradiction. */
export const POSIWID_CONTRADICTION_SHARE = 0.01;
const OTHER = 'other';

/** What the system says it does: a distribution over outcome categories. */
export class PurposeModel {
  readonly categories: readonly (readonly [string, number])[];

  /**
   * Validates that the categories are a distribution: non-empty, non-negative shares
   * summing to 1, and each name appearing exactly once. Duplicates are rejected because
   * posiwidDivergence counts observed mass per stated name -- a repeated name would count
   * its observations twice, driving the implicit `other` bucket negative.
   */
  constructor(categories: [string, number][]) {
    if (categories.length === 0) {
      throw new Error('purpose model needs at least one category');
    }
    categories.forEach(([name, share], i) => {
      if (share < 0) {
        throw new Error(`share for '${name}' is negative`);
      }
      if (categories.slice(0, i).some(([n]) => n === name)) {
        throw new Error(`category '${name}' appears more than once`);
      }
    });
    const sum = categories.reduce((a, [, s]) => a + s, 0);
    if (Math.abs(sum - 1) > 1e-6) {
      throw new Error(`shares sum to ${sum}, not 1`);
    }
    this.categories = categories.map(([n, s]) => [n, s] as const);
  }

  shareOf(name: string): number {
    const hit = this.categories.find(([n]) => n === name);
    return hit ? hit[1] : 0;
  }
}

/**
 * What the system did: event counts per category. Names absent from the
 * purpose model are folded into an implicit `other` bucket with stated share 0.
 */
export interface ObservedBehaviour {
  counts: [string, number][];
}

export type PosiwidVerdict = 'Consistent' | 'Drifting' | 'Contradicted' | 'Insufficient';

export interface PosiwidReport {
  /** KL(observed || stated) over the stated categories plus `other`, smoothed. */
  divergence: number;
  dominantStated: string;
  dominantObserved: string;
  verdict: PosiwidVerdict;
  support: number;
}

/**
 * Beer's POSIWID as a measurement: how far what the system does diverges from
 * what it says it does, and a verdict.
 */
export function posiwidDivergence(
  stated: PurposeModel,
  observed: ObservedBehaviour,
  driftThreshold: number,
  minSupport: number,
): PosiwidReport {
  const n = stated.categories.length + 1; // + other
  const support = observed.counts.reduce((a, [, c]) => a + c, 0);

  let dominantStated = '';
  let bestStated = Number.NEGATIVE_INFINITY;
  for (const [name, s] of stated.categories) {
    if (s > bestStated) {
      bestStated = s;
      dominantStated = name;
    }
  }

  // Nothing observed: there is no behaviour to compare and none to name. Short-circuit
  // before the dominant-observed search, which would otherwise call the empty `other`
  // bucket dominant and -- with `minSupport` 0 -- report Contradicted from no evidence.
  if (support === 0) {
    return {
      divergence: 0,
      dominantStated,
      dominantObserved: OTHER,
      verdict: 'Insufficient',
      support: 0,
    };
  }

  // observed distribution in stated order, then `other`
  const obs = stated.categories.map(([name]) =>
    observed.counts.filter(([m]) => m === name).reduce((a, [, c]) => a + c, 0),
  );
  const known = obs.reduce((a, b) => a + b, 0);
  obs.push(support - known);
  const denomO = support + POSIWID_EPS * n;
  const p = obs.map((c) => (c + POSIWID_EPS) / denomO);

  const st = stated.categories.map(([, s]) => s);
  st.push(0);
  const denomS = 1 + POSIWID_EPS * n;
  const q = st.map((s) => (s + POSIWID_EPS) / denomS);

  const divergence = klDivergence(p, q);

  const names = [...stated.categories.map(([name]) => name), OTHER];
  let dominantObserved = OTHER;
  let bestCount = 0;
  names.forEach((name, i) => {
    const c = Math.max(obs[i], 0);
    if (c > bestCount) {
      bestCount = c;
      dominantObserved = name;
    }
  });
  if (dominantObserved === OTHER) {
    // name the actual foreign category with the highest count, if any:
    // group by name (summing repeats, first-appearance order), then pick
    // with a strict `>` fold so ties resolve first-wins, same as above.
    const foreign: [string, number][] = [];
    for (const [name, c] of observed.counts) {
      if (stated.categories.some(([s]) => s === name)) continue;
      const entry = foreign.find(([n]) => n === name);
      if (entry) entry[1] += c;
      else foreign.push([name, c]);
    }
    let best: [string, number] = [OTHER, 0];
    for (const [n, c] of foreign) {
      if (c > best[1]) best = [n, c];
    }
    dominantObserved = best[0];
  }

  const verdict: PosiwidVerdict =
    support < minSupport
      ? 'Insufficient'
      : stated.shareOf(dominantObserved) <= POSIWID_CONTRADICTION_SHARE
        ? 'Contradicted'
        : divergence > driftThreshold
          ? 'Drifting'
          : 'Consistent';

  return { divergence, dominantStated, dominantObserved, verdict, support };
}

/**
 * Windowed POSIWID: feeds each window's divergence (minus the expected level)
 * into a CUSUM detector and latches the window index at which drift was first called.
 */
export class PosiwidDrift {
  private detector: CusumDetector;
  private windows = 0;
  private onsetWindow: number | null = null;

  constructor(
    private readonly stated: PurposeModel,
    private readonly expectedDivergence: number,
    private readonly driftThreshold: number,
    private readonly minSupport: number,
    cusumThreshold: number,
    cusumSlack: number,
  ) {
    this.detector = new CusumDetector(cusumThreshold, cusumSlack);
  }

  /**
   * Feeds one window into the CUSUM and returns the LATCHED onset: null until the first
   * window whose cumulative sum crosses the threshold, then that window's index on every
   * later call.
   *
   * The CUSUM does not self-reset, so every window past the threshold stays past it.
   * Returning the *current* index instead made a caller that records the last non-null
   * value report "onset = final window"; the onset is a fact about when drift started,
   * and only reset() forgets it.
   *
   * A window with too little support is skipped entirely -- it neither advances the CUSUM
   * nor sets an onset -- but it still consumes a window index.
   */
  observe(window: ObservedBehaviour): number | null {
    const idx = this.windows++;
    const r = posiwidDivergence(this.stated, window, this.driftThreshold, this.minSupport);
    if (r.verdict === 'Insufficient') {
      return this.onsetWindow;
    }
    if (this.detector.update(r.divergence - this.expectedDivergence) && this.onsetWindow === null) {
      this.onsetWindow = idx;
    }
    return this.onsetWindow;
  }

  /**
   * The latched drift onset: the window index at which drift was first called, or null if
   * it has not been called since construction or the last reset().
   */
  onset(): number | null {
    return this.onsetWindow;
  }

  /** Clears both the CUSUM state and the latched onset. Window indices keep counting. */
  reset(): void {
    this.detector.reset();
    this.onsetWindow = null;
  }
}

// ===========================================================================
// Autonomy — Beer's three constraints on divisional autonomy
// ===========================================================================

/**
 * Context for checking Beer's three autonomy constraints.
 * Each division is autonomous EXCEPT for these three conditions.
 */
export interface AutonomyContext {
  /** Node identifier. */
  nodeId: NodeId;
  /** (i) Does the node operate within the intention of the whole? */
  alignedWithWhole: boolean;
  /** (ii) Does the node accept S2's coordination framework? */
  acceptsS2Coordination: boolean;
  /** (iii) Does the node submit to S3's automatic control? */
  submitsToS3Control: boolean;
}

/**
 * Check all three autonomy constraints.
 * Returns null if all pass, or an array of violated constraints.
 */
export function checkAutonomy(
  ctx: AutonomyContext,
): AutonomyConstraint[] | null {
  const violations: AutonomyConstraint[] = [];

  if (!ctx.alignedWithWhole) {
    violations.push(AutonomyConstraint.IntentionOfWhole);
  }
  if (!ctx.acceptsS2Coordination) {
    violations.push(AutonomyConstraint.S2Coordination);
  }
  if (!ctx.submitsToS3Control) {
    violations.push(AutonomyConstraint.S3AutomaticControl);
  }

  return violations.length === 0 ? null : violations;
}

// ===========================================================================
// Freedom — residual variety
// ===========================================================================

/**
 * Freedom measurement for a system unit.
 *
 * "Freedom is a computable function of systemic purpose" -- Beer.
 * Freedom = residual variety after constraints are applied.
 */
export interface FreedomMeasure {
  /** Total variety the unit could express (unconstrained). */
  totalVariety: number;
  /** Variety consumed by mandatory constraints. */
  constraintVariety: number;
  /** Residual variety = total - constraints = freedom. */
  freedom: number;
  /** Ratio of freedom to total (0.0 = no freedom, 1.0 = unconstrained). */
  freedomRatio: number;
}

/**
 * Calculate freedom as residual variety.
 *
 * Beer: freedom is not the absence of constraint -- it is the
 * variety remaining after necessary constraints are satisfied.
 */
export function calculateFreedom(
  totalVariety: number,
  constraintVariety: number,
): FreedomMeasure {
  const freedom = Math.max(totalVariety - constraintVariety, 0.0);
  const freedomRatio = totalVariety > 0.0 ? freedom / totalVariety : 0.0;

  return {
    totalVariety,
    constraintVariety,
    freedom,
    freedomRatio,
  };
}

/**
 * Check if a unit has sufficient freedom to operate effectively.
 *
 * Beer: too little freedom and the unit cannot adapt;
 * too much and it threatens the viability of the whole.
 *
 * Viable range: 0.2 -- 0.8 (at least 20% freedom, at most 80%).
 */
export function freedomIsViable(measure: FreedomMeasure): boolean {
  return measure.freedomRatio >= 0.2 && measure.freedomRatio <= 0.8;
}
