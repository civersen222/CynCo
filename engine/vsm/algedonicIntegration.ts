/**
 * Algedonic Integration — real pain/pleasure signaling with kill switch.
 *
 * Replaces hand-rolled consecutive failure tracking with the library's
 * AlgedonicChannel, KillSwitch, and SlaTracker.
 *
 * Behavioral effects:
 * - KillSwitch.checkOrHalt() STOPS the conversation loop on critical failures
 * - AlgedonicChannel routes signals by severity (immediate/delayed/badge/log)
 * - SlaTracker tracks response time violations per severity level
 */

import { algedonic, NodeId, AlgedonicType, Severity, classifySeverity } from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { events } from '../cybernetics-core/src/index.js'

export class AlgedonicIntegration {
  readonly channel: InstanceType<typeof algedonic.AlgedonicChannel>
  readonly killSwitch: InstanceType<typeof algedonic.KillSwitch>
  readonly slaTracker: InstanceType<typeof algedonic.SlaTracker>
  private nodeId: InstanceType<typeof NodeId>
  private consecutivePainCount = 0
  private readonly KILL_THRESHOLD = 5 // halt after 5 consecutive pain signals

  constructor(nodeId: InstanceType<typeof NodeId>, maxSignals: number = 100) {
    this.nodeId = nodeId
    this.channel = new algedonic.AlgedonicChannel(maxSignals)
    this.killSwitch = new algedonic.KillSwitch()
    this.slaTracker = new algedonic.SlaTracker()
  }

  /**
   * Record a tool result as a pleasure or pain signal.
   * Returns the routing action (Immediate/Delayed/Badge/Log).
   *
   * Behavioral effect: consecutive pain signals activate the kill switch.
   *
   * `governanceDenial` marks a call the engine REFUSED to run — the read-loop
   * gate, the commit-scope guard, the allowedTools pin, S5's live restriction.
   * Nothing executed, so nothing in the environment failed, and the kill switch
   * is the wrong instrument: it exists to stop a run whose world is broken.
   * Measured 2026-07-28 in the Gilded L4.5 run — five consecutive read-loop
   * denials halted a session that was making edits, losing 148 uncommitted
   * lines. The denial is meant to climb toward stuck detection's halt at 15,
   * which gives the model room to adapt; the algedonic halt at 5 pre-empted it.
   *
   * A denial is NEUTRAL for the counter, not forgiving: it neither increments
   * nor clears, so a genuine failure streak cannot be laundered by interleaving
   * refusals. It still reaches the channel, so the pain ratio tells the truth
   * about how much of the run was being refused.
   */
  recordToolResult(
    toolName: string,
    success: boolean,
    latencyMs: number,
    opts?: { governanceDenial?: boolean },
  ): ReturnType<typeof algedonic.routeSignal> {
    const baseScore = success ? 0.15 : 0.7
    const latencyPenalty = latencyMs > 30000 ? 0.2 : latencyMs > 10000 ? 0.1 : 0
    const score = Math.min(1.0, baseScore + latencyPenalty)
    const signalType = success ? AlgedonicType.Pleasure : AlgedonicType.Pain
    const signal = new algedonic.AlgedonicSignal(
      this.nodeId,
      score,
      signalType,
      `Tool ${toolName}: ${success ? 'success' : 'failure'}`,
    )

    const action = this.channel.emit(signal)

    // Audit: log algedonic signal
    try {
      const { AuditLogger } = require('../audit/auditLogger.js')
      AuditLogger.log('algedonic', {
        type: 'algedonic.signal',
        severity: success ? 'pleasure' : (this.consecutivePainCount >= this.KILL_THRESHOLD - 1 ? 'critical' : 'mild_pain'),
        source: toolName,
        trigger: `Tool ${toolName}: ${success ? 'success' : 'failure'}`,
        consecutive_count: this.consecutivePainCount,
        killswitch_state: this.killSwitch.isActive ? 'active' : 'inactive',
        s5_notified: false,
      })
    } catch {}

    // Track consecutive pain for kill switch
    if (opts?.governanceDenial) {
      // Neither arm nor clear — see the note on this method.
    } else if (signal.isPain()) {
      this.consecutivePainCount++
      if (this.consecutivePainCount >= this.KILL_THRESHOLD) {
        this.killSwitch.activate(
          `${this.KILL_THRESHOLD} consecutive failures — system halted for safety`
        )
        // Emit kill switch event
        getEventBus().emit(events.DomainEvent.killSwitchActivated(
          this.nodeId,
          `${this.KILL_THRESHOLD} consecutive tool failures`,
        ))
        // Audit: log kill switch activation
        try {
          const { AuditLogger } = require('../audit/auditLogger.js')
          AuditLogger.log('algedonic', { type: 'algedonic.killswitch_fire' })
        } catch {}
      }
    } else {
      this.consecutivePainCount = 0
    }

    // Check SLA
    const severity = classifySeverity(score)
    this.slaTracker.check(severity, latencyMs, toolName)

    return action
  }

  /**
   * Record a model error as a critical pain signal.
   */
  recordModelError(error: string): void {
    const signal = new algedonic.AlgedonicSignal(
      this.nodeId,
      0.9, // near-critical
      AlgedonicType.Pain,
      `Model error: ${error}`,
    )
    this.channel.emit(signal)
    this.consecutivePainCount++

    if (this.consecutivePainCount >= this.KILL_THRESHOLD) {
      this.killSwitch.activate(`Model errors: ${error}`)
    }
  }

  /**
   * Check if the system is operational. Throws HaltedError if kill switch active.
   *
   * BEHAVIORAL EFFECT: This STOPS the conversation loop.
   * Call this before every model invocation.
   */
  checkOrHalt(): void {
    this.killSwitch.checkOrHalt()
  }

  /**
   * Reset the kill switch (e.g., after user intervention).
   */
  reset(): void {
    this.killSwitch.reset()
    this.consecutivePainCount = 0
  }

  /**
   * Get current pain/pleasure ratio for governance reporting.
   */
  getPainRatio(): number {
    const signals = this.channel.signals()
    if (signals.length === 0) return 0
    const painCount = signals.filter(s => s.isPain()).length
    return painCount / signals.length
  }

  /**
   * Get unacknowledged alert count.
   */
  getUnacknowledgedCount(): number {
    return this.channel.unacknowledged().length
  }

  /**
   * Get SLA violation count.
   */
  getSlaViolationCount(): number {
    return this.slaTracker.violations().length
  }
}
