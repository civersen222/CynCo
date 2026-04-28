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
