/**
 * Pask's conversation theory -- entailment meshes, teachback protocol,
 * and agreement levels.
 *
 * Conformant TypeScript port of:
 *   - cybernetics::conversation::mesh
 *   - cybernetics::conversation::teachback
 *   - cybernetics::conversation::agreement
 */

// ===========================================================================
// Entailment Mesh — directed concept graphs
// ===========================================================================

/**
 * A single topic in the entailment mesh.
 */
export interface Topic {
  id: string;
  description: string;
}

/**
 * An entailment mesh -- a directed graph of conceptual dependencies.
 *
 * Nodes are topics/concepts, edges are entailment relations (A entails B
 * means understanding A requires understanding B).
 */
export class EntailmentMesh {
  /** Topics by id. */
  private topics: Map<string, Topic> = new Map();
  /** Entailment edges: topic_id -> set of topic_ids it entails (depends on). */
  private entailments: Map<string, Set<string>> = new Map();

  /** Add a topic to the mesh. */
  addTopic(id: string, description: string): void {
    this.topics.set(id, { id, description });
  }

  /** Add an entailment: understanding `from` requires understanding `to`. */
  addEntailment(from: string, to: string): void {
    let set = this.entailments.get(from);
    if (!set) {
      set = new Set();
      this.entailments.set(from, set);
    }
    set.add(to);
  }

  /** Get all topics that a given topic depends on (direct entailments). */
  entails(topicId: string): Set<string> {
    const set = this.entailments.get(topicId);
    return set ? new Set(set) : new Set();
  }

  /**
   * Get all topics (transitive closure of entailments).
   * Uses stack-based DFS, matching Rust core algorithm.
   */
  allPrerequisites(topicId: string): Set<string> {
    const result = new Set<string>();
    const stack: string[] = [topicId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const deps = this.entailments.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!result.has(dep)) {
            result.add(dep);
            stack.push(dep);
          }
        }
      }
    }
    return result;
  }

  /**
   * Calculate the delta between two agents' meshes.
   * Returns topic ids in `other` that are not in `this`.
   */
  delta(other: EntailmentMesh): string[] {
    const result: string[] = [];
    for (const key of other.topics.keys()) {
      if (!this.topics.has(key)) {
        result.push(key);
      }
    }
    return result;
  }

  /** Get a topic by id. */
  getTopic(id: string): Topic | undefined {
    return this.topics.get(id);
  }

  /** Count topics. */
  topicCount(): number {
    return this.topics.size;
  }
}

// ===========================================================================
// Teachback Protocol — Pask's verification of mutual understanding
// ===========================================================================

/**
 * Result of a teachback verification.
 */
export enum TeachbackResult {
  /** Learner's teachback matches the teacher's understanding. */
  Verified = 'Verified',
  /** Learner's teachback diverges -- more conversation needed. */
  Divergent = 'Divergent',
  /** Not yet verified. */
  Pending = 'Pending',
}

/**
 * A single teachback exchange.
 *
 * In teachback, after Agent A explains concept X to Agent B,
 * Agent B must explain X back to Agent A. Agreement is verified
 * by comparing the explanations.
 */
export class TeachbackExchange {
  public teachbackExplanation: string = '';
  public verified: boolean | null = null;

  constructor(
    public readonly topic: string,
    public readonly teacher: string,
    public readonly learner: string,
    public readonly originalExplanation: string,
  ) {}

  /** Record the learner's teachback. */
  recordTeachback(teachback: string): void {
    this.teachbackExplanation = teachback;
  }

  /** Verify the teachback (teacher confirms or denies). */
  verify(accepted: boolean): void {
    this.verified = accepted;
  }

  /** Get the result of this exchange. */
  result(): TeachbackResult {
    if (this.verified === true) return TeachbackResult.Verified;
    if (this.verified === false) return TeachbackResult.Divergent;
    return TeachbackResult.Pending;
  }
}

/**
 * A teachback protocol session tracking multiple exchanges.
 */
export class TeachbackProtocol {
  public readonly exchanges: TeachbackExchange[] = [];

  addExchange(exchange: TeachbackExchange): void {
    this.exchanges.push(exchange);
  }

  /** Count verified exchanges. */
  verifiedCount(): number {
    return this.exchanges.filter(
      (e) => e.result() === TeachbackResult.Verified,
    ).length;
  }

  /** Count divergent exchanges. */
  divergentCount(): number {
    return this.exchanges.filter(
      (e) => e.result() === TeachbackResult.Divergent,
    ).length;
  }

  /**
   * Overall agreement ratio (verified / total decided).
   * Returns 0.0 if no exchanges have been decided.
   */
  agreementRatio(): number {
    const decided = this.exchanges.filter((e) => e.verified !== null).length;
    if (decided === 0) return 0.0;
    return this.verifiedCount() / decided;
  }
}

// ===========================================================================
// Agreement Levels — Pask's four levels of conversational agreement
// ===========================================================================

/**
 * Pask's agreement levels in conversation.
 *
 * 0. None -- agents don't share the topic.
 * 1. SharedTopics -- both recognize the topic exists.
 * 2. SharedProcedures -- both can perform operations on the topic.
 * 3. MutualUnderstanding -- teachback verified.
 * 4. SharedExplanation -- equivalent explanations produced.
 *
 * Numeric values support ordering comparisons via the helper functions.
 */
export enum AgreementLevel {
  None = 0,
  SharedTopics = 1,
  SharedProcedures = 2,
  MutualUnderstanding = 3,
  SharedExplanation = 4,
}

/**
 * Agreement state between two agents on a specific topic.
 */
export class AgreementState {
  public level: AgreementLevel = AgreementLevel.None;

  constructor(
    public readonly topic: string,
    public readonly agentA: string,
    public readonly agentB: string,
  ) {}

  /**
   * Advance to a higher agreement level if conditions are met.
   * Cannot regress -- only moves forward.
   */
  advanceTo(level: AgreementLevel): void {
    if (level > this.level) {
      this.level = level;
    }
  }

  /** Check if agents have at least the given level of agreement. */
  hasAtLeast(level: AgreementLevel): boolean {
    return this.level >= level;
  }
}

/**
 * Track agreement across multiple topics between two agents.
 */
export class AgreementTracker {
  public readonly states: AgreementState[] = [];

  add(state: AgreementState): void {
    this.states.push(state);
  }

  /** Get states at or above a given level. */
  atLevel(level: AgreementLevel): AgreementState[] {
    return this.states.filter((s) => s.level >= level);
  }

  /**
   * Overall agreement depth: average level across all topics.
   * Each AgreementLevel's numeric value (0-4) is used for the average.
   */
  averageDepth(): number {
    if (this.states.length === 0) return 0.0;
    const total = this.states.reduce(
      (sum, s) => sum + (s.level as number),
      0,
    );
    return total / this.states.length;
  }
}
