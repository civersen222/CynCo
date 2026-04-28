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
import { getEventBus } from './eventBus.js'
import { events } from '../cybernetics-core/src/index.js'

export class ConstraintChecksIntegration {
  private nodeId: InstanceType<typeof NodeId>
  private toolNames: string[] = []
  private recentOutputs: string[] = []
  private statedPurpose: string = 'coding assistant that helps with software engineering tasks'

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
   * POSIWID check: compare stated purpose vs actual behavior.
   *
   * BEHAVIORAL EFFECT: returns false when system purpose has drifted.
   * Triggers governance alert.
   */
  checkPurposeAlignment(observedOutputs: string[]): boolean {
    this.recentOutputs = observedOutputs.slice(-20)
    return constraints.posiwidCheck(this.statedPurpose, this.recentOutputs)
  }

  /** Update stated purpose (e.g. from profile system_prompt_append). */
  setStatedPurpose(purpose: string): void {
    this.statedPurpose = purpose
  }

  /** Record a tool name for POSIWID tracking. */
  recordToolUse(toolName: string): void {
    this.toolNames.push(toolName)
    if (this.toolNames.length > 50) this.toolNames = this.toolNames.slice(-50)
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
