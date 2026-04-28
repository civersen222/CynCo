/**
 * Autopoiesis -- self-producing systems.
 *
 * Implements Maturana/Varela's autopoiesis theory:
 * - criteria: The six formal criteria for autopoiesis
 * - closure: Production network verification for organizational closure
 * - proposal: Self-modification proposal types and state machine
 * - coupling: Structural coupling tracker (congruent co-drift)
 * - identity: Organization vs Structure distinction (Beer)
 *
 * Conformant with Rust: cybernetics/src/autopoiesis/
 */

import { ModificationType } from '../types';
import { NodeId, Timestamp } from '../types';

// ============================================================================
// Criteria
// ============================================================================

/**
 * The six formal criteria for autopoiesis (Maturana & Varela).
 * An autopoietic system must satisfy ALL six.
 */
export interface AutopoiesisAssessment {
  /** 1. The system has a distinguishable boundary */
  hasBoundary: boolean;
  /** 2. The boundary is produced by the system's own processes */
  boundarySelfProduced: boolean;
  /** 3. The system contains components that produce other components */
  internalProduction: boolean;
  /** 4. The production is circular (components produce components that produce them) */
  circularProduction: boolean;
  /** 5. The system has no inputs or outputs (organizationally closed) */
  organizationallyClosed: boolean;
  /** 6. The organization is maintained through ongoing processes */
  organizationMaintained: boolean;
}

/** Returns true only if all six criteria are satisfied. */
export function isAutopoietic(assessment: AutopoiesisAssessment): boolean {
  return assessment.hasBoundary
    && assessment.boundarySelfProduced
    && assessment.internalProduction
    && assessment.circularProduction
    && assessment.organizationallyClosed
    && assessment.organizationMaintained;
}

/** Returns the names of criteria that are not satisfied. */
export function missingCriteria(assessment: AutopoiesisAssessment): string[] {
  const missing: string[] = [];
  if (!assessment.hasBoundary) missing.push('distinguishable boundary');
  if (!assessment.boundarySelfProduced) missing.push('self-produced boundary');
  if (!assessment.internalProduction) missing.push('internal component production');
  if (!assessment.circularProduction) missing.push('circular production');
  if (!assessment.organizationallyClosed) missing.push('organizational closure');
  if (!assessment.organizationMaintained) missing.push('organization maintenance');
  return missing;
}

// ============================================================================
// Closure (Production Network)
// ============================================================================

/**
 * Production network for verifying organizational closure.
 * Nodes are components, edges are "produces" relationships.
 */
export class ProductionNetwork {
  private components: string[] = [];
  private produces: Array<[number, number]> = []; // (producer_idx, product_idx)

  /** Add a component to the network. Returns its index. */
  addComponent(name: string): number {
    const idx = this.components.length;
    this.components.push(name);
    return idx;
  }

  /** Add a production relationship: producer produces product. */
  addProduction(producer: number, product: number): void {
    this.produces.push([producer, product]);
  }

  /**
   * Check organizational closure: every component must be produced by at least
   * one other component in the network.
   */
  isClosed(): boolean {
    for (let i = 0; i < this.components.length; i++) {
      if (!this.produces.some(([_, p]) => p === i)) {
        return false;
      }
    }
    return true;
  }

  /** Find components not produced by any other component. */
  unproducedComponents(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.components.length; i++) {
      if (!this.produces.some(([_, p]) => p === i)) {
        result.push(this.components[i]);
      }
    }
    return result;
  }

  /** Number of components in the network. */
  componentCount(): number {
    return this.components.length;
  }

  /** Number of production relationships. */
  productionCount(): number {
    return this.produces.length;
  }
}

// ============================================================================
// Proposal
// ============================================================================

/** Proposal status in the state machine. */
export enum ProposalStatus {
  Proposed = 'Proposed',
  PendingS5 = 'PendingS5',
  PendingHuman = 'PendingHuman',
  Approved = 'Approved',
  Rejected = 'Rejected',
  Applied = 'Applied',
  Reverted = 'Reverted',
  Failed = 'Failed',
}

/** Parameter bounds for validation. */
export interface ParameterBounds {
  min: number;
  max: number;
}

/** Detail types for proposals. */
export type ProposalDetail =
  | { type: 'Parameter'; name: string; newValue: number; bounds: ParameterBounds }
  | { type: 'Workflow'; description: string }
  | { type: 'Code'; description: string }
  | { type: 'Structure'; description: string };

/**
 * Self-modification proposal with state machine.
 */
export class Proposal {
  nodeId: NodeId;
  timestamp: Timestamp;
  modificationType: ModificationType;
  status: ProposalStatus;
  detail: ProposalDetail;
  decisionReason: string | null;

  constructor(
    nodeId: NodeId,
    timestamp: Timestamp,
    modificationType: ModificationType,
    status: ProposalStatus,
    detail: ProposalDetail,
    decisionReason: string | null = null,
  ) {
    this.nodeId = nodeId;
    this.timestamp = timestamp;
    this.modificationType = modificationType;
    this.status = status;
    this.detail = detail;
    this.decisionReason = decisionReason;
  }

  /** Create a parameter modification proposal. */
  static parameter(nodeId: NodeId, name: string, newValue: number, bounds: ParameterBounds): Proposal {
    return new Proposal(
      nodeId,
      Timestamp.now(),
      ModificationType.Parameter,
      ProposalStatus.Proposed,
      { type: 'Parameter', name, newValue, bounds },
    );
  }

  /** Create a workflow modification proposal. */
  static workflow(nodeId: NodeId, description: string): Proposal {
    return new Proposal(
      nodeId,
      Timestamp.now(),
      ModificationType.Workflow,
      ProposalStatus.Proposed,
      { type: 'Workflow', description },
    );
  }

  /** Create a code modification proposal. */
  static code(nodeId: NodeId, description: string): Proposal {
    return new Proposal(
      nodeId,
      Timestamp.now(),
      ModificationType.Code,
      ProposalStatus.Proposed,
      { type: 'Code', description },
    );
  }

  /**
   * Evaluate the proposal and transition to the next state.
   * Parameters auto-approve if within bounds. Workflows route to S5. Code routes to human.
   */
  evaluate(): ProposalStatus {
    switch (this.detail.type) {
      case 'Parameter': {
        const { newValue, bounds } = this.detail;
        if (newValue >= bounds.min && newValue <= bounds.max) {
          this.status = ProposalStatus.Approved;
        } else {
          this.status = ProposalStatus.PendingS5;
        }
        break;
      }
      case 'Workflow':
      case 'Structure':
        this.status = ProposalStatus.PendingS5;
        break;
      case 'Code':
        this.status = ProposalStatus.PendingHuman;
        break;
    }
    return this.status;
  }

  /** Approve a pending proposal. */
  approve(reason: string): void {
    if (this.status !== ProposalStatus.PendingS5 && this.status !== ProposalStatus.PendingHuman) {
      throw new Error('Can only approve pending proposals');
    }
    this.status = ProposalStatus.Approved;
    this.decisionReason = reason;
  }

  /** Reject a pending proposal. */
  reject(reason: string): void {
    if (this.status !== ProposalStatus.PendingS5 && this.status !== ProposalStatus.PendingHuman) {
      throw new Error('Can only reject pending proposals');
    }
    this.status = ProposalStatus.Rejected;
    this.decisionReason = reason;
  }

  /** Apply an approved proposal. */
  apply(): void {
    if (this.status !== ProposalStatus.Approved) {
      throw new Error('Can only apply approved proposals');
    }
    this.status = ProposalStatus.Applied;
  }

  /** Revert an applied proposal. */
  revert(): void {
    if (this.status !== ProposalStatus.Applied) {
      throw new Error('Can only revert applied proposals');
    }
    this.status = ProposalStatus.Reverted;
  }

  /** Mark as failed with a reason. */
  fail(reason: string): void {
    this.status = ProposalStatus.Failed;
    this.decisionReason = reason;
  }
}

// ============================================================================
// Coupling
// ============================================================================

/** A record of structural coupling between two systems. */
export interface CouplingRecord {
  systemA: string;
  systemB: string;
  interactionCount: number;
  coDriftCorrelation: number; // -1.0 to 1.0
}

/** Internal tracking state for computing running correlation. */
interface InteractionState {
  systemA: string;
  systemB: string;
  count: number;
  sumA: number;
  sumB: number;
  sumA2: number;
  sumB2: number;
  sumAB: number;
}

function newInteractionState(a: string, b: string): InteractionState {
  return {
    systemA: a,
    systemB: b,
    count: 0,
    sumA: 0,
    sumB: 0,
    sumA2: 0,
    sumB2: 0,
    sumAB: 0,
  };
}

function recordInteraction(state: InteractionState, aState: number, bState: number): void {
  state.count += 1;
  state.sumA += aState;
  state.sumB += bState;
  state.sumA2 += aState * aState;
  state.sumB2 += bState * bState;
  state.sumAB += aState * bState;
}

/** Pearson correlation coefficient. */
function correlation(state: InteractionState): number {
  if (state.count < 2) {
    return 0.0;
  }
  const n = state.count;
  const numerator = n * state.sumAB - state.sumA * state.sumB;
  const denomA = Math.sqrt(n * state.sumA2 - state.sumA * state.sumA);
  const denomB = Math.sqrt(n * state.sumB2 - state.sumB * state.sumB);
  const denom = denomA * denomB;
  if (denom === 0.0) {
    return 0.0;
  }
  return numerator / denom;
}

function toRecord(state: InteractionState): CouplingRecord {
  return {
    systemA: state.systemA,
    systemB: state.systemB,
    interactionCount: state.count,
    coDriftCorrelation: correlation(state),
  };
}

/**
 * Structural coupling tracker -- tracks congruent co-drift between interacting systems.
 */
export class StructuralCoupling {
  private states: InteractionState[] = [];

  /**
   * Record an interaction between two systems with their current state values.
   * The pair (a, b) is treated as unordered -- (a,b) and (b,a) map to the same record.
   */
  recordInteraction(a: string, b: string, aState: number, bState: number): void {
    // Normalize key ordering
    let keyA: string, keyB: string, valA: number, valB: number;
    if (a <= b) {
      keyA = a; keyB = b; valA = aState; valB = bState;
    } else {
      keyA = b; keyB = a; valA = bState; valB = aState;
    }

    const existing = this.states.find(s => s.systemA === keyA && s.systemB === keyB);
    if (existing) {
      recordInteraction(existing, valA, valB);
    } else {
      const state = newInteractionState(keyA, keyB);
      recordInteraction(state, valA, valB);
      this.states.push(state);
    }
  }

  /** Get the correlation between two systems, if any interactions have been recorded. */
  correlation(a: string, b: string): number | undefined {
    const keyA = a <= b ? a : b;
    const keyB = a <= b ? b : a;
    const state = this.states.find(s => s.systemA === keyA && s.systemB === keyB);
    if (!state) return undefined;
    return correlation(state);
  }

  /** Return all coupling records with correlation above the given threshold. */
  stronglyCoupled(threshold: number): CouplingRecord[] {
    return this.states
      .filter(s => Math.abs(correlation(s)) >= threshold)
      .map(toRecord);
  }

  /** Return all coupling records. */
  allRecords(): CouplingRecord[] {
    return this.states.map(toRecord);
  }
}

// ============================================================================
// Identity
// ============================================================================

/**
 * Beer's distinction: Organization (invariant relational pattern) vs Structure (actual components).
 * Identity is maintained when organization persists even as structure changes.
 */
export class OrganizationalIdentity {
  readonly name: string;
  readonly invariantRelations: string[];
  currentStructure: string[];
  identityScore: number;

  constructor(name: string, invariants: string[]) {
    this.name = name;
    this.invariantRelations = [...invariants];
    this.currentStructure = [];
    this.identityScore = 1.0;
  }

  /** Set the current structure. */
  setStructure(structure: string[]): void {
    this.currentStructure = [...structure];
    this.updateIdentityScore();
  }

  /**
   * Check if a proposed structural change preserves identity.
   * All invariant relations must still be satisfiable.
   * Simple: check that no invariant is removed from the structure.
   */
  preservesIdentity(proposedStructure: string[]): boolean {
    return this.invariantRelations.every(inv => proposedStructure.includes(inv));
  }

  /**
   * Update the identity score based on how many invariants are present
   * in the current structure.
   */
  private updateIdentityScore(): void {
    if (this.invariantRelations.length === 0) {
      this.identityScore = 1.0;
      return;
    }
    const present = this.invariantRelations.filter(
      inv => this.currentStructure.includes(inv)
    ).length;
    this.identityScore = present / this.invariantRelations.length;
  }
}
