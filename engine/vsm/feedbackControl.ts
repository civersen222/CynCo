/**
 * Feedback Control Integration — FeedbackLoop + PidController + UltrastableSystem.
 *
 * Behavioral effects:
 * - FeedbackLoop error drives context compression timing
 * - PidController output DIRECTLY adjusts tool approval sensitivity
 * - UltrastableSystem perturbs agent parameters when essential variables
 *   leave viable range (context %, failure rate, variety balance)
 * - isGoodRegulator checks model fidelity periodically
 */

import {
  foundations,
} from '../cybernetics-core/src/index.js'

export class FeedbackControlIntegration {
  /** Negative feedback loop for context budget: setpoint = 70% utilization */
  readonly contextLoop: InstanceType<typeof foundations.FeedbackLoop>

  /** PID controller for tool approval rate */
  readonly approvalPid: InstanceType<typeof foundations.PidController>

  /** Ultrastable system wrapping essential variables */
  readonly ultrastable: InstanceType<typeof foundations.UltrastableSystem>

  /** Track whether parameters were perturbed this turn */
  private _perturbedThisTurn = false

  /** Track the PID output for external consumption */
  private _lastPidOutput = 0

  constructor() {
    // Context budget feedback loop: target 70% utilization
    // Negative feedback: if utilization > 70%, error is negative → compress
    // If utilization < 70%, error is positive → don't compress
    this.contextLoop = new foundations.FeedbackLoop(
      'context_budget',
      foundations.FeedbackTypes.Negative,
      0.5, // gain: moderate response
      0.7, // setpoint: 70% context utilization
    )

    // PID controller for tool approval rate
    // Kp=0.3, Ki=0.05, Kd=0.1, dt=1.0 (one turn)
    // Error = desired_approval_rate - actual_approval_rate
    // Positive output → ease restrictions, negative → tighten
    this.approvalPid = new foundations.PidController(0.3, 0.05, 0.1, 1.0)

    // Ultrastable system: essential variables with viability bounds
    // Variables: [context_utilization, failure_rate, variety_ratio]
    // Bounds: context [0, 0.85], failure [0, 0.4], variety [0.3, 3.0]
    const fastLoop = new foundations.FeedbackLoop(
      'ultrastable_fast',
      foundations.FeedbackTypes.Negative,
      0.3,
      0.5, // setpoint for context
    )
    this.ultrastable = new foundations.UltrastableSystem(
      fastLoop,
      [0.0, 0.0, 1.0], // initial: 0% context, 0% failure, 1.0 variety ratio
      [[0.0, 0.85], [0.0, 0.4], [0.3, 3.0]], // viability bounds
      [0.7, 8192, 0.3], // parameters: [temperature, max_tokens, approval_threshold]
      0.05, // step size for perturbation
    )
  }

  /**
   * Update all feedback control systems with current metrics.
   *
   * @param contextUtilization - 0.0 to 1.0
   * @param failureRate - 0.0 to 1.0
   * @param varietyRatio - from VarietyEngine
   * @param approvalRate - fraction of tool calls approved (0.0 to 1.0)
   * @returns Actions to take based on feedback signals
   */
  update(
    contextUtilization: number,
    failureRate: number,
    varietyRatio: number,
    approvalRate: number,
  ): FeedbackActions {
    // 1. Context budget feedback loop
    const contextError = this.contextLoop.update(contextUtilization)

    // 2. PID controller for approval rate
    // Target: 80% approval rate (most calls should succeed)
    const approvalError = 0.8 - approvalRate
    this._lastPidOutput = this.approvalPid.update(approvalError)

    // 3. Ultrastable system
    this._perturbedThisTurn = !this.ultrastable.update([
      contextUtilization,
      failureRate,
      varietyRatio,
    ])

    return {
      shouldCompress: contextError < -0.1, // utilization > 80%
      compressionUrgency: Math.abs(Math.min(contextError, 0)), // how urgent
      approvalAdjustment: this._lastPidOutput, // positive = ease, negative = tighten
      parametersPerturbed: this._perturbedThisTurn,
      isViable: this.ultrastable.isViable(),
      perturbedParameters: this._perturbedThisTurn ? this.ultrastable.parameters() : null,
    }
  }

  /**
   * Check model fidelity: does the governance model match reality?
   * Returns fidelity score 0-1 (1 = perfect match).
   */
  checkModelFidelity(
    systemDist: number[],
    modelDist: number[],
  ): number {
    return foundations.modelFidelity(systemDist, modelDist)
  }

  /**
   * Is the governance model a "good regulator"?
   * Conant-Ashby: every good regulator must be a model of its system.
   */
  isGoodRegulator(
    systemDist: number[],
    modelDist: number[],
    threshold: number = 0.7,
  ): boolean {
    return foundations.isGoodRegulator(systemDist, modelDist, threshold)
  }

  /** Was the system perturbed this turn (ultrastability activated)? */
  wasPerturbed(): boolean {
    return this._perturbedThisTurn
  }

  /** Get the last PID output value. */
  getApprovalAdjustment(): number {
    return this._lastPidOutput
  }
}

/** Actions recommended by the feedback control system. */
export interface FeedbackActions {
  /** Should we compress context now? */
  shouldCompress: boolean
  /** How urgent is compression (0-1)? */
  compressionUrgency: number
  /** PID adjustment for tool approval: positive = ease, negative = tighten */
  approvalAdjustment: number
  /** Were parameters perturbed by ultrastability? */
  parametersPerturbed: boolean
  /** Are all essential variables within viable bounds? */
  isViable: boolean
  /** If perturbed, the new parameter values */
  perturbedParameters: number[] | null
}
