/**
 * Shared types used across the cybernetics library.
 *
 * Conformant with Rust: cybernetics/src/types.rs
 */

// --- NodeId ---

/** Unique identifier for a VSM node at any recursion level. */
export class NodeId {
  private readonly uuid: string;

  constructor(uuid?: string) {
    this.uuid = uuid ?? crypto.randomUUID();
  }

  static new(): NodeId {
    return new NodeId();
  }

  static fromUuid(uuid: string): NodeId {
    return new NodeId(uuid);
  }

  toString(): string {
    return this.uuid;
  }

  equals(other: NodeId): boolean {
    return this.uuid === other.uuid;
  }
}

// --- Timestamp ---

/** Millisecond-precision UTC timestamp. */
export class Timestamp {
  private readonly ms: number;

  private constructor(ms: number) {
    this.ms = ms;
  }

  static now(): Timestamp {
    return new Timestamp(Date.now());
  }

  static fromMillis(ms: number): Timestamp {
    return new Timestamp(ms);
  }

  asMillis(): number {
    return this.ms;
  }
}

// --- Severity ---

/** Algedonic signal severity. Ordered LOW < MODERATE < HIGH < CRITICAL. */
export enum Severity {
  Low = 'Low',
  Moderate = 'Moderate',
  High = 'High',
  Critical = 'Critical',
}

/** Classify a 0.0-1.0 score into severity. */
export function classifySeverity(score: number): Severity {
  if (score >= 0.9) return Severity.Critical;
  if (score >= 0.7) return Severity.High;
  if (score >= 0.4) return Severity.Moderate;
  return Severity.Low;
}

/** Alias for classifySeverity (used by algedonic module). */
export const severityFromScore = classifySeverity;

/** Response-time SLA per severity level (in ms). */
export function severitySlaMillis(severity: Severity): number {
  switch (severity) {
    case Severity.Critical: return 1_000;
    case Severity.High: return 10_000;
    case Severity.Moderate: return 60_000;
    case Severity.Low: return 300_000;
  }
}

// --- VarietyBalance ---

/** Variety balance state (Ashby's Law applied). */
export enum VarietyBalance {
  Balanced = 'Balanced',
  Overload = 'Overload',
  Underload = 'Underload',
  Critical = 'Critical',
}

/** Classify variety ratio into balance state. */
export function classifyVarietyBalance(ratio: number): VarietyBalance {
  if (ratio < 0.5 || ratio > 2.0) return VarietyBalance.Critical;
  if (ratio < 0.8) return VarietyBalance.Overload;
  if (ratio > 1.2) return VarietyBalance.Underload;
  return VarietyBalance.Balanced;
}

// --- HomeostatBalance ---

/** Homeostat balance between S3 (operations) and S4 (intelligence). */
export enum HomeostatBalance {
  Balanced = 'Balanced',
  S3Dominant = 'S3Dominant',
  S4Dominant = 'S4Dominant',
  Critical = 'Critical',
}

/** Classify S3/S4 ratio into homeostat balance state. */
export function classifyHomeostatBalance(ratio: number): HomeostatBalance {
  if (ratio < 0.25 || ratio > 4.0) return HomeostatBalance.Critical;
  if (ratio < 0.5) return HomeostatBalance.S4Dominant;
  if (ratio > 2.0) return HomeostatBalance.S3Dominant;
  return HomeostatBalance.Balanced;
}

// --- ModificationType ---

/** Type of self-modification proposal. */
export enum ModificationType {
  Parameter = 'Parameter',
  Workflow = 'Workflow',
  Code = 'Code',
  Structure = 'Structure',
}

/** Whether this modification type requires human approval. */
export function requiresHumanApproval(mt: ModificationType): boolean {
  return mt === ModificationType.Code;
}

/** Whether this modification type requires S5 approval. */
export function requiresS5Approval(mt: ModificationType): boolean {
  return mt === ModificationType.Workflow
    || mt === ModificationType.Code
    || mt === ModificationType.Structure;
}

// --- AlgedonicType ---

/** Beer's algedonic signal type. */
export enum AlgedonicType {
  Pleasure = 'Pleasure',
  Pain = 'Pain',
}

// --- TrendDirection ---

/** Beer's trend direction -- what S4 observes. NOT a recommendation. */
export enum TrendDirection {
  Rising = 'Rising',
  Falling = 'Falling',
  Stable = 'Stable',
  Oscillating = 'Oscillating',
  Emerging = 'Emerging',
}

// --- AutonomyConstraint ---

/** Beer's three constraints on divisional autonomy (Brain of the Firm Ch.11). */
export enum AutonomyConstraint {
  IntentionOfWhole = 'IntentionOfWhole',
  S2Coordination = 'S2Coordination',
  S3AutomaticControl = 'S3AutomaticControl',
}

// --- PleasureLevel ---

/** Pleasure level with reinforcement multipliers (from wagetheory). */
export enum PleasureLevel {
  High = 'High',
  Moderate = 'Moderate',
  Low = 'Low',
}

/** Reinforcement multiplier for a pleasure level. */
export function pleasureReinforcementMultiplier(level: PleasureLevel): number {
  switch (level) {
    case PleasureLevel.High: return 2.0;
    case PleasureLevel.Moderate: return 1.5;
    case PleasureLevel.Low: return 1.1;
  }
}
