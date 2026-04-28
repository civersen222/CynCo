/**
 * VSM Module -- Viable System Model components.
 *
 * Conformant TypeScript port of the Rust cybernetics::vsm module.
 * Includes: node, channels, focus, axioms, principles, aphorisms,
 * cohesion, and environment.
 */

import { NodeId } from '../types';

// Re-export VarietyEngine from the variety module for use in VSMNode.
// We inline a minimal forward-compatible version here so the vsm module
// is self-contained. The full VarietyEngine lives in ../variety/index.ts.
import { VarietyEngine } from '../variety/index';

// ===================================================================
// VSM Node
// ===================================================================

/**
 * A node in the Viable System Model hierarchy.
 *
 * Each node is itself a viable system (recursion principle).
 * It contains children which are the S1 operational units at the
 * next recursion level down.
 */
export class VSMNode {
  readonly id: NodeId;
  readonly name: string;
  children: VSMNode[] = [];
  variety: VarietyEngine;
  halted = false;

  constructor(name: string) {
    this.id = new NodeId();
    this.name = name;
    this.variety = new VarietyEngine();
  }

  /** Add a child node (S1 operational unit at next recursion level). */
  addChild(child: VSMNode): void {
    this.children.push(child);
  }

  /** Check if this node is halted. */
  isHalted(): boolean {
    return this.halted;
  }

  /** Halt this node. */
  halt(): void {
    this.halted = true;
  }

  /** Resume this node. */
  resume(): void {
    this.halted = false;
  }

  /** Find a node by ID in this tree (DFS). */
  find(id: NodeId): VSMNode | null {
    if (this.id.equals(id)) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found) return found;
    }
    return null;
  }

  /** Count total nodes in this tree (including self). */
  nodeCount(): number {
    return 1 + this.children.reduce((sum, c) => sum + c.nodeCount(), 0);
  }

  /** Calculate the depth of this tree (0 for leaf, max child depth + 1). */
  depth(): number {
    if (this.children.length === 0) return 0;
    return 1 + Math.max(...this.children.map(c => c.depth()));
  }
}

// ===================================================================
// Channels -- Beer's six vertical cohesion channels
// ===================================================================

/** Beer's six vertical cohesion channels (Heart of Enterprise, 1st Axiom). */
export enum VerticalChannel {
  /** Channel 1: S3 direct command to S1 */
  S3Command = 'S3Command',
  /** Channel 2: S2 coordination between S1 units */
  S2Coordination = 'S2Coordination',
  /** Channel 3: S3* audit/inspection */
  S3StarAudit = 'S3StarAudit',
  /** Channel 4: Environmental interaction (S1 <-> environment) */
  EnvironmentalInteraction = 'EnvironmentalInteraction',
  /** Channel 5: S1 upward variety (reporting to S3) */
  S1UpwardVariety = 'S1UpwardVariety',
  /** Channel 6: Algedonic alerts (pain/pleasure bypass) */
  AlgedonicAlerts = 'AlgedonicAlerts',
}

/** All six channels in canonical order. */
export const VERTICAL_CHANNEL_ALL: VerticalChannel[] = [
  VerticalChannel.S3Command,
  VerticalChannel.S2Coordination,
  VerticalChannel.S3StarAudit,
  VerticalChannel.EnvironmentalInteraction,
  VerticalChannel.S1UpwardVariety,
  VerticalChannel.AlgedonicAlerts,
];

/** Index of a vertical channel (0-5). */
export function verticalChannelIndex(channel: VerticalChannel): number {
  switch (channel) {
    case VerticalChannel.S3Command:                return 0;
    case VerticalChannel.S2Coordination:           return 1;
    case VerticalChannel.S3StarAudit:              return 2;
    case VerticalChannel.EnvironmentalInteraction: return 3;
    case VerticalChannel.S1UpwardVariety:          return 4;
    case VerticalChannel.AlgedonicAlerts:          return 5;
  }
}

/** Channel state tracking. */
export class ChannelState {
  channel: VerticalChannel;
  capacity: number;     // bits/second or variety units
  currentLoad: number;  // current variety flowing through
  utilization: number;  // load / capacity

  constructor(channel: VerticalChannel, capacity: number) {
    this.channel = channel;
    this.capacity = capacity;
    this.currentLoad = 0;
    this.utilization = 0;
  }

  updateLoad(load: number): void {
    this.currentLoad = load;
    this.utilization = this.capacity > 0 ? load / this.capacity : Infinity;
  }

  isOverloaded(): boolean {
    return this.utilization > 1.0;
  }

  isAdequate(): boolean {
    return this.utilization <= 1.0;
  }
}

/** All six channels for a VSM recursion level. */
export class ChannelSet {
  private channels: ChannelState[];

  constructor(defaultCapacity: number) {
    this.channels = [
      new ChannelState(VerticalChannel.S3Command, defaultCapacity),
      new ChannelState(VerticalChannel.S2Coordination, defaultCapacity),
      new ChannelState(VerticalChannel.S3StarAudit, defaultCapacity),
      new ChannelState(VerticalChannel.EnvironmentalInteraction, defaultCapacity),
      new ChannelState(VerticalChannel.S1UpwardVariety, defaultCapacity),
      new ChannelState(VerticalChannel.AlgedonicAlerts, defaultCapacity),
    ];
  }

  get(channel: VerticalChannel): ChannelState {
    return this.channels[verticalChannelIndex(channel)];
  }

  anyOverloaded(): boolean {
    return this.channels.some(c => c.isOverloaded());
  }

  overloadedChannels(): ChannelState[] {
    return this.channels.filter(c => c.isOverloaded());
  }
}

// ===================================================================
// Focus -- System-in-Focus
// ===================================================================

/**
 * System-in-Focus: the observer's choice of which recursion level to examine.
 * Beer: "the system-in-focus is determined by the observer."
 */
export class SystemInFocus {
  readonly nodeId: NodeId;
  readonly recursionLevel: number;
  readonly observer: string;

  constructor(nodeId: NodeId, level: number, observer: string) {
    this.nodeId = nodeId;
    this.recursionLevel = level;
    this.observer = observer;
  }

  /** Zoom in: focus on a child node (recursionLevel + 1). */
  zoomIn(childId: NodeId): SystemInFocus {
    return new SystemInFocus(childId, this.recursionLevel + 1, this.observer);
  }

  /** Zoom out: focus on parent node (recursionLevel - 1). Returns null if at level 0. */
  zoomOut(parentId: NodeId): SystemInFocus | null {
    if (this.recursionLevel === 0) return null;
    return new SystemInFocus(parentId, this.recursionLevel - 1, this.observer);
  }
}

// ===================================================================
// Axioms -- Beer's Three Axioms of Management
// ===================================================================

/**
 * Axiom 1: The sum of horizontal variety disposed by n operational elements
 * equals the sum of vertical variety disposed on the six vertical command channels.
 */
export function checkAxiom1(
  horizontalVariety: number,
  verticalVariety: number,
  tolerance: number,
): boolean {
  return Math.abs(horizontalVariety - verticalVariety) <= tolerance;
}

/**
 * Axiom 2: The variety disposed by System 3 resulting from Axiom 1 equals
 * the variety disposed by System 4.
 */
export function checkAxiom2(
  s3Variety: number,
  s4Variety: number,
  tolerance: number,
): boolean {
  return Math.abs(s3Variety - s4Variety) <= tolerance;
}

/**
 * Axiom 3: System 5 is the ultimate variety sink. Any residual variety from
 * the S3/S4 balance must be absorbed by S5's identity function.
 */
export function checkAxiom3(
  residualVariety: number,
  s5Capacity: number,
): boolean {
  return residualVariety <= s5Capacity;
}

// ===================================================================
// Principles -- Beer's Four Principles of Organization
// ===================================================================

/**
 * Principle 1: Managerial, operational, and environmental varieties tend to
 * equate; they should be designed to do so with minimal delay.
 */
export function checkPrinciple1(
  managerial: number,
  operational: number,
  environmental: number,
  tolerance: number,
): boolean {
  const maxDiff = Math.max(
    Math.abs(managerial - operational),
    Math.abs(operational - environmental),
    Math.abs(managerial - environmental),
  );
  return maxDiff <= tolerance;
}

/**
 * Principle 2: The four directional channels carrying information between
 * management and operations must each have a higher capacity than the
 * variety generator that feeds them.
 */
export function checkPrinciple2(
  channelCapacity: number,
  sourceVarietyRate: number,
): boolean {
  return channelCapacity >= sourceVarietyRate;
}

/**
 * Principle 3: Wherever information crosses a boundary, it undergoes
 * transduction; the transducer's variety must be at least equivalent
 * to the channel's variety.
 */
export function checkPrinciple3(
  transducerVariety: number,
  channelVariety: number,
): boolean {
  return transducerVariety >= channelVariety;
}

/**
 * Principle 4: Operation of Principles 1-3 must be maintained cyclically
 * through time, without hiatus or lag.
 */
export function checkPrinciple4(
  timeSinceLastCheck: number,
  maxAllowedLag: number,
): boolean {
  return timeSinceLastCheck <= maxAllowedLag;
}

// ===================================================================
// Aphorisms -- Beer's Two Regulatory Aphorisms
// ===================================================================

/**
 * Aphorism 1: It is not necessary to enter the black box to understand
 * the nature of the function it performs.
 *
 * Returns the absolute Pearson correlation coefficient between inputs and outputs.
 */
export function understandFromIo(inputs: number[], outputs: number[]): number {
  if (inputs.length !== outputs.length || inputs.length === 0) return 0.0;

  const n = inputs.length;
  const meanI = inputs.reduce((a, b) => a + b, 0) / n;
  const meanO = outputs.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  for (let k = 0; k < n; k++) {
    cov += (inputs[k] - meanI) * (outputs[k] - meanO);
  }
  cov /= n;

  let stdI = 0;
  for (let k = 0; k < n; k++) {
    stdI += (inputs[k] - meanI) ** 2;
  }
  stdI = Math.sqrt(stdI / n);

  let stdO = 0;
  for (let k = 0; k < n; k++) {
    stdO += (outputs[k] - meanO) ** 2;
  }
  stdO = Math.sqrt(stdO / n);

  if (stdI === 0 || stdO === 0) return 0.0;

  return Math.abs(cov / (stdI * stdO));
}

/**
 * Aphorism 2: It is not necessary to enter the black box to calculate
 * the variety it can generate.
 *
 * Returns log2 of distinct_states (Shannon variety).
 */
export function observableVariety(distinctStates: number): number {
  if (distinctStates <= 1) return 0.0;
  return Math.log2(distinctStates);
}

// ===================================================================
// Cohesion -- Beer's Law of Cohesion
// ===================================================================

/**
 * Check cohesion: S1 variety at recursion x should match
 * the sum of metasystem variety at recursion y.
 */
export function checkCohesion(
  s1VarietyAtX: number,
  sumMetasystemVarietyAtY: number,
  tolerance: number,
): boolean {
  return Math.abs(s1VarietyAtX - sumMetasystemVarietyAtY) <= tolerance;
}

/**
 * Cohesion score: 1.0 = perfect, 0.0 = completely uncoupled.
 */
export function cohesionScore(
  s1Variety: number,
  metasystemVariety: number,
): number {
  if (s1Variety === 0 && metasystemVariety === 0) return 1.0;
  const max = Math.max(s1Variety, metasystemVariety);
  if (max === 0) return 1.0;
  return 1.0 - Math.abs(s1Variety - metasystemVariety) / max;
}

// ===================================================================
// Environment
// ===================================================================

/** A domain within the environment (e.g., market, regulatory, technology). */
export interface EnvironmentDomain {
  name: string;
  variety: number;
  volatility: number; // 0.0-1.0
}

/** Environmental model for S4's outside-and-then perspective. */
export class Environment {
  name: string;
  variety: number;
  rateOfChange: number;
  domains: EnvironmentDomain[];

  constructor(name: string) {
    this.name = name;
    this.variety = 0;
    this.rateOfChange = 0;
    this.domains = [];
  }

  addDomain(domain: EnvironmentDomain): void {
    this.variety += domain.variety;
    this.domains.push(domain);
  }

  totalVariety(): number {
    return this.variety;
  }

  mostVolatile(): EnvironmentDomain | null {
    if (this.domains.length === 0) return null;
    return this.domains.reduce((best, d) =>
      d.volatility > best.volatility ? d : best,
    );
  }
}
