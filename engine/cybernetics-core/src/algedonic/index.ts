/**
 * Algedonic Channel Module -- signal, kill switch, channel routing, SLA.
 *
 * Conformant TypeScript port of the Rust cybernetics::algedonic module.
 *
 * Algedonic signals carry pleasure or pain information from any node
 * in the system. Critical signals bypass normal management channels.
 */

import {
  NodeId,
  Severity,
  AlgedonicType,
  Timestamp,
  severityFromScore,
  severitySlaMillis,
} from '../types';

// ===================================================================
// Signal
// ===================================================================

/**
 * An algedonic signal -- pleasure or pain from a node.
 *
 * Algedonic signals bypass normal management channels. They carry
 * a score (0.0-1.0), a severity classification, the signal type
 * (pleasure or pain), and the source description.
 */
export class AlgedonicSignal {
  readonly nodeId: NodeId;
  readonly timestamp: Timestamp;
  readonly score: number;
  readonly severity: Severity;
  readonly signalType: AlgedonicType;
  source: string;

  constructor(
    nodeId: NodeId,
    score: number,
    signalType: AlgedonicType,
    source: string,
  ) {
    this.nodeId = nodeId;
    this.timestamp = Timestamp.now();
    this.score = Math.min(Math.max(score, 0.0), 1.0);
    this.severity = severityFromScore(this.score);
    this.signalType = signalType;
    this.source = source;
  }

  /** Is this a critical signal? */
  isCritical(): boolean {
    return this.severity === Severity.Critical;
  }

  /** Is this a pain signal? */
  isPain(): boolean {
    return this.signalType === AlgedonicType.Pain;
  }

  /** Is this a pleasure signal? */
  isPleasure(): boolean {
    return this.signalType === AlgedonicType.Pleasure;
  }
}

/**
 * A critical algedonic signal that MUST be handled.
 *
 * Beer's Law: critical algedonic signals cannot be ignored.
 */
export class CriticalSignal {
  readonly signal: AlgedonicSignal;

  private constructor(signal: AlgedonicSignal) {
    this.signal = signal;
  }

  /**
   * Wrap a signal as critical. Returns null if the signal
   * is not actually critical severity.
   */
  static fromSignal(signal: AlgedonicSignal): CriticalSignal | null {
    if (signal.isCritical()) {
      return new CriticalSignal(signal);
    }
    return null;
  }

  /**
   * Acknowledge handling this critical signal.
   * Returns the underlying signal.
   */
  acknowledge(): AlgedonicSignal {
    return this.signal;
  }
}

// ===================================================================
// Kill Switch
// ===================================================================

/** Error returned when the system is halted. */
export class HaltedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`System halted: ${reason}`);
    this.reason = reason;
    this.name = 'HaltedError';
  }
}

/**
 * Emergency halt mechanism -- the algedonic kill switch.
 *
 * The kill switch can be activated from anywhere. Once activated,
 * checkOrHalt() throws a HaltedError. It can be reset.
 */
export class KillSwitch {
  private _halted = false;
  private _reason: string | null = null;

  /** Activate the kill switch with a reason. */
  activate(reason: string): void {
    this._reason = reason;
    this._halted = true;
  }

  /** Check whether the system is halted. */
  isHalted(): boolean {
    return this._halted;
  }

  /** Get the reason for the halt, if any. */
  reason(): string | null {
    return this._reason;
  }

  /** Reset the kill switch to the non-halted state. */
  reset(): void {
    this._halted = false;
    this._reason = null;
  }

  /**
   * Check if the system is operational, or throw HaltedError.
   * This is the primary API for operations to check before proceeding.
   */
  checkOrHalt(): void {
    if (this._halted) {
      throw new HaltedError(this._reason ?? 'unknown');
    }
  }
}

// ===================================================================
// Channel -- routes signals based on severity
// ===================================================================

/**
 * Routing action determined by signal severity.
 *
 * Routing rules:
 *   CRITICAL  -> Immediate display, require acknowledgment
 *   HIGH      -> Delayed display (30s) if unacknowledged
 *   MODERATE  -> Badge count increment only
 *   LOW       -> Log only, no notification
 */
export type RoutingAction =
  | { type: 'Immediate' }
  | { type: 'Delayed'; millis: number }
  | { type: 'Badge' }
  | { type: 'Log' };

/** Route a signal based on its severity. */
export function routeSignal(severity: Severity): RoutingAction {
  switch (severity) {
    case Severity.Critical:
      return { type: 'Immediate' };
    case Severity.High:
      return { type: 'Delayed', millis: 30_000 };
    case Severity.Moderate:
      return { type: 'Badge' };
    case Severity.Low:
      return { type: 'Log' };
  }
}

/**
 * Algedonic channel with signal history and deduplication.
 *
 * Collects signals, routes them by severity, and provides filtered
 * views (unacknowledged, critical count, etc.).
 */
export class AlgedonicChannel {
  private _signals: AlgedonicSignal[] = [];
  private maxSignals: number;

  constructor(maxSignals: number) {
    this.maxSignals = maxSignals;
  }

  /**
   * Emit a signal into the channel.
   * Returns the routing action for this signal.
   */
  emit(signal: AlgedonicSignal): RoutingAction {
    const action = routeSignal(signal.severity);
    this._signals.push(signal);

    // Trim oldest if over capacity
    if (this._signals.length > this.maxSignals) {
      const excess = this._signals.length - this.maxSignals;
      this._signals.splice(0, excess);
    }

    return action;
  }

  /** Get all signals in the channel history. */
  signals(): AlgedonicSignal[] {
    return this._signals;
  }

  /** Get all unacknowledged signals (Critical and High severity). */
  unacknowledged(): AlgedonicSignal[] {
    return this._signals.filter(
      s => s.severity === Severity.Critical || s.severity === Severity.High,
    );
  }

  /** Count of critical signals in history. */
  criticalCount(): number {
    return this._signals.filter(s => s.severity === Severity.Critical).length;
  }
}

// ===================================================================
// SLA -- Response-time SLA tracking per severity
// ===================================================================

/** A single SLA violation record. */
export interface SlaViolation {
  severity: Severity;
  expectedMillis: number;
  actualMillis: number;
  source: string;
}

/**
 * Response-time SLA tracker.
 *
 * Checks response times against per-severity SLAs and records violations.
 *
 * SLA Thresholds:
 *   Critical:  < 1,000ms (1 second)
 *   High:      < 10,000ms (10 seconds)
 *   Moderate:  < 60,000ms (1 minute)
 *   Low:       < 300,000ms (5 minutes)
 */
export class SlaTracker {
  private _violations: SlaViolation[] = [];

  /**
   * Check a response time against the SLA for the given severity.
   *
   * Returns true if the SLA was met, false if violated.
   * Violations are recorded internally.
   */
  check(severity: Severity, responseMillis: number, source: string): boolean {
    const sla = severitySlaMillis(severity);
    if (responseMillis > sla) {
      this._violations.push({
        severity,
        expectedMillis: sla,
        actualMillis: responseMillis,
        source,
      });
      return false;
    }
    return true;
  }

  /** Get all recorded violations. */
  violations(): SlaViolation[] {
    return this._violations;
  }
}
