/**
 * Domain event bus for the cybernetics library.
 *
 * All state changes in the system are emitted as domain events.
 * The EventBus provides an in-memory, append-only event log with
 * monotonically increasing sequence numbering.
 *
 * Conformant TypeScript port of `cybernetics::events` (Rust core).
 */

import {
  NodeId,
  AlgedonicType,
  AutonomyConstraint,
  HomeostatBalance,
  ModificationType,
  Severity,
  Timestamp,
  TrendDirection,
  VarietyBalance,
} from '../types';

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

let globalSeq = 1;

function nextSeq(): number {
  return globalSeq++;
}

/** Reset the global sequence counter (for testing only). */
export function resetSequence(start: number = 1): void {
  globalSeq = start;
}

// ---------------------------------------------------------------------------
// EventPayload
// ---------------------------------------------------------------------------

/** Payload variants for each kind of domain event. */
export type EventPayload =
  | {
      kind: 'VarietyRecalculated';
      nodeId: NodeId;
      requisite: number;
      actual: number;
      balance: VarietyBalance;
    }
  | {
      kind: 'AlgedonicFired';
      nodeId: NodeId;
      signalType: AlgedonicType;
      severity: Severity;
      message: string;
    }
  | {
      kind: 'HomeostatUpdated';
      nodeId: NodeId;
      balance: HomeostatBalance;
      ratio: number;
    }
  | {
      kind: 'KillSwitchActivated';
      nodeId: NodeId;
      reason: string;
    }
  | {
      kind: 'ModificationProposed';
      nodeId: NodeId;
      modificationType: ModificationType;
      description: string;
    }
  | {
      kind: 'ModificationDecided';
      nodeId: NodeId;
      modificationType: ModificationType;
      approved: boolean;
      reason: string;
    }
  | {
      kind: 'AchievementUpdated';
      nodeId: NodeId;
      metricName: string;
      value: number;
      target: number;
    }
  | {
      kind: 'DriftDetected';
      nodeId: NodeId;
      metricName: string;
      driftMagnitude: number;
      trend: TrendDirection;
    }
  | {
      kind: 'AutonomyViolation';
      nodeId: NodeId;
      constraint: AutonomyConstraint;
      description: string;
    }
  | {
      kind: 'S5Decision';
      nodeId: NodeId;
      decision: string;
      rationale: string;
    }
  | {
      kind: 'NodeHalted';
      nodeId: NodeId;
      reason: string;
    }
  | {
      kind: 'NodeResumed';
      nodeId: NodeId;
      reason: string;
    }
  | {
      kind: 'ChannelCapacityExceeded';
      nodeId: NodeId;
      channelName: string;
      capacity: number;
      load: number;
    }
  | {
      kind: 'TransductionLoss';
      nodeId: NodeId;
      boundary: string;
      lossRatio: number;
    }
  | {
      kind: 'EigenformConverged';
      nodeId: NodeId;
      eigenformName: string;
      iterations: number;
      residual: number;
    };

// ---------------------------------------------------------------------------
// DomainEvent
// ---------------------------------------------------------------------------

/** A single domain event with metadata. */
export class DomainEvent {
  /** Monotonically increasing sequence number. */
  public readonly seq: number;
  /** When the event occurred. */
  public readonly timestamp: Timestamp;
  /** The event payload. */
  public readonly payload: EventPayload;

  constructor(payload: EventPayload) {
    this.seq = nextSeq();
    this.timestamp = Timestamp.now();
    this.payload = payload;
  }

  // ----- Constructor helpers for each payload variant -----

  static varietyRecalculated(
    nodeId: NodeId,
    requisite: number,
    actual: number,
    balance: VarietyBalance,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'VarietyRecalculated',
      nodeId,
      requisite,
      actual,
      balance,
    });
  }

  static algedonicFired(
    nodeId: NodeId,
    signalType: AlgedonicType,
    severity: Severity,
    message: string,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'AlgedonicFired',
      nodeId,
      signalType,
      severity,
      message,
    });
  }

  static homeostatUpdated(
    nodeId: NodeId,
    balance: HomeostatBalance,
    ratio: number,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'HomeostatUpdated',
      nodeId,
      balance,
      ratio,
    });
  }

  static killSwitchActivated(nodeId: NodeId, reason: string): DomainEvent {
    return new DomainEvent({
      kind: 'KillSwitchActivated',
      nodeId,
      reason,
    });
  }

  static modificationProposed(
    nodeId: NodeId,
    modificationType: ModificationType,
    description: string,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'ModificationProposed',
      nodeId,
      modificationType,
      description,
    });
  }

  static modificationDecided(
    nodeId: NodeId,
    modificationType: ModificationType,
    approved: boolean,
    reason: string,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'ModificationDecided',
      nodeId,
      modificationType,
      approved,
      reason,
    });
  }

  static achievementUpdated(
    nodeId: NodeId,
    metricName: string,
    value: number,
    target: number,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'AchievementUpdated',
      nodeId,
      metricName,
      value,
      target,
    });
  }

  static driftDetected(
    nodeId: NodeId,
    metricName: string,
    driftMagnitude: number,
    trend: TrendDirection,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'DriftDetected',
      nodeId,
      metricName,
      driftMagnitude,
      trend,
    });
  }

  static autonomyViolation(
    nodeId: NodeId,
    constraint: AutonomyConstraint,
    description: string,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'AutonomyViolation',
      nodeId,
      constraint,
      description,
    });
  }

  static s5Decision(
    nodeId: NodeId,
    decision: string,
    rationale: string,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'S5Decision',
      nodeId,
      decision,
      rationale,
    });
  }

  static nodeHalted(nodeId: NodeId, reason: string): DomainEvent {
    return new DomainEvent({
      kind: 'NodeHalted',
      nodeId,
      reason,
    });
  }

  static nodeResumed(nodeId: NodeId, reason: string): DomainEvent {
    return new DomainEvent({
      kind: 'NodeResumed',
      nodeId,
      reason,
    });
  }

  static channelCapacityExceeded(
    nodeId: NodeId,
    channelName: string,
    capacity: number,
    load: number,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'ChannelCapacityExceeded',
      nodeId,
      channelName,
      capacity,
      load,
    });
  }

  static transductionLoss(
    nodeId: NodeId,
    boundary: string,
    lossRatio: number,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'TransductionLoss',
      nodeId,
      boundary,
      lossRatio,
    });
  }

  static eigenformConverged(
    nodeId: NodeId,
    eigenformName: string,
    iterations: number,
    residual: number,
  ): DomainEvent {
    return new DomainEvent({
      kind: 'EigenformConverged',
      nodeId,
      eigenformName,
      iterations,
      residual,
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: extract nodeId from a payload
// ---------------------------------------------------------------------------

/** Extract the nodeId from an EventPayload (all variants have one). */
export function eventNodeId(payload: EventPayload): NodeId {
  return payload.nodeId;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/**
 * In-memory, append-only event log.
 *
 * Events are appended and can be replayed or drained. There is no
 * subscriber mechanism; consumers pull events via replay() or drain().
 */
export class EventBus {
  private events: DomainEvent[] = [];

  /** Emit (append) a domain event. */
  emit(event: DomainEvent): void {
    this.events.push(event);
  }

  /** Replay all events (returns a shallow copy). */
  replay(): ReadonlyArray<DomainEvent> {
    return [...this.events];
  }

  /** Drain all events, leaving the bus empty. */
  drain(): DomainEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  /** Number of events currently stored. */
  len(): number {
    return this.events.length;
  }

  /** Whether the bus is empty. */
  isEmpty(): boolean {
    return this.events.length === 0;
  }

  /** Replay events matching a predicate. */
  replayFiltered(predicate: (event: DomainEvent) => boolean): DomainEvent[] {
    return this.events.filter(predicate);
  }

  /** Replay events for a specific node. */
  replayForNode(nodeId: NodeId): DomainEvent[] {
    return this.events.filter(
      (e) => eventNodeId(e.payload).value === nodeId.value,
    );
  }
}
