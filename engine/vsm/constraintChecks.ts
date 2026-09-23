/**
 * Constraint Checks — autonomy, POSIWID, freedom enforcement.
 *
 * Behavioral effects:
 * - Autonomy checks BLOCK invalid S3 directives
 * - POSIWID violations trigger governance alerts
 * - Freedom ratio outside viable band triggers constraint adjustment
 * - S4 Trends enforce observation-only (no recommendation language)
 */

import {
  constraints,
  NodeId,
  AutonomyConstraint,
  TrendDirection,
} from '../cybernetics-core/src/index.js'
import type { PosiwidReport } from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events } from '../cybernetics-core/src/index.js'

/**
 * Folds `classifyCall` classes (vsm/missionInvariants.ts) into the purpose
 * model's categories. A read-shaped Bash call and a CodeIndex query are
 * inspection. Everything the model does not name — `revert`,
 * `denied-or-error`, `other` — falls into posiwidDivergence's implicit `other`
 * bucket (stated share 0), so a session DOMINATED by one of them reads
 * `Contradicted`: that is the verdict this check exists to produce.
 */
export function toolClassToPurpose(cls: string): string {
  return cls === 'read' || cls === 'codeIndex' ? 'inspect' : cls
}

export class ConstraintChecksIntegration {
  private nodeId: InstanceType<typeof NodeId>
  /**
   * The stated purpose of a coding session, as shares over the classifier's
   * classes. These are the supervisor's priors, not measurements: a session
   * that mostly inspects is `Drifting` (C8 wave 1: 828 of 931 calls), one
   * that mostly reverts or errors is `Contradicted`. Missions with a campaign
   * spec are graded post hoc against the spec's own `posiwid` block by the
   * runner; this default is what the ENGINE reads live, for every session.
   */
  private purposeModel = new constraints.PurposeModel([
    ['sourceEdit', 0.15],
    ['commit', 0.05],
    ['inspect', 0.55],
    ['run', 0.20],
    ['write', 0.05],
  ])

  constructor(nodeId: InstanceType<typeof NodeId>) {
    this.nodeId = nodeId
  }

  /**
   * Check autonomy constraints before S3 sends a directive.
   *
   * BEHAVIORAL EFFECT: returns violations that BLOCK the directive.
   * S3 can set bounds but can't micromanage.
   */
  checkAutonomy(
    alignedWithWhole: boolean,
    acceptsS2: boolean,
    submitsToS3: boolean,
  ): AutonomyConstraint[] | null {
    const violations = constraints.checkAutonomy({
      nodeId: this.nodeId,
      alignedWithWhole,
      acceptsS2Coordination: acceptsS2,
      submitsToS3Control: submitsToS3,
    })

    if (violations) {
      for (const v of violations) {
        getEventBus().emit(events.DomainEvent.autonomyViolation(
          this.nodeId,
          v,
          `Autonomy constraint violated: ${v}`,
        ))
      }
    }

    return violations
  }

  /**
   * POSIWID: the purpose of a system is what it does. Compares the distribution of
   * observed tool classes with the stated purpose model.
   * BEHAVIORAL EFFECT: a `Contradicted` verdict emits a governance drift alert.
   */
  checkPurposeAlignment(observed: { counts: [string, number][] }): PosiwidReport {
    const report = constraints.posiwidDivergence(this.purposeModel, observed, 0.1, 50)
    if (report.verdict === 'Contradicted') {
      getEventBus().emit(events.DomainEvent.driftDetected(
        this.nodeId,
        'posiwid',
        report.divergence,
        TrendDirection.Rising,
      ))
    }
    return report
  }

  /**
   * POSIWID over raw tool classes as `classifyCall` produces them: fold into
   * the purpose categories, then `checkPurposeAlignment`.
   */
  checkToolClassAlignment(counts: ReadonlyMap<string, number> | Record<string, number>): PosiwidReport {
    const folded = new Map<string, number>()
    const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts)
    for (const [cls, n] of entries) {
      const cat = toolClassToPurpose(cls)
      folded.set(cat, (folded.get(cat) ?? 0) + n)
    }
    return this.checkPurposeAlignment({ counts: [...folded.entries()] })
  }

  /** Replace the stated purpose model (e.g. from profile configuration). */
  setPurposeModel(categories: [string, number][]): void {
    this.purposeModel = new constraints.PurposeModel(categories)
  }

  /**
   * Calculate freedom as residual variety.
   *
   * BEHAVIORAL EFFECT: freedom outside 0.2-0.8 → adjust constraints.
   * Too constrained = can't adapt. Too free = chaotic.
   */
  calculateFreedom(
    totalToolCount: number,
    deniedToolCount: number,
  ): { freedom: ReturnType<typeof constraints.calculateFreedom>; viable: boolean } {
    const measure = constraints.calculateFreedom(totalToolCount, deniedToolCount)
    const viable = constraints.freedomIsViable(measure)
    return { freedom: measure, viable }
  }

  /**
   * Validate an S4 observation as a Trend (no recommendation language).
   *
   * BEHAVIORAL EFFECT: throws BeerViolationError if S4 tries to recommend
   * instead of observe. Keeps S4 in its lane.
   */
  validateS4Trend(
    domain: string,
    direction: TrendDirection,
    magnitude: number,
    description: string,
  ): InstanceType<typeof constraints.Trend> {
    // This will throw BeerViolationError if description contains "should", "must", etc.
    return new constraints.Trend(domain, direction, magnitude, description)
  }
}
