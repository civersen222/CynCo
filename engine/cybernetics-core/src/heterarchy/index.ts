/**
 * McCulloch's heterarchy -- non-transitive preference graphs and
 * redundancy of potential command.
 *
 * Conformant TypeScript port of:
 *   - cybernetics::heterarchy::graph
 *   - cybernetics::heterarchy::command
 */

// ===========================================================================
// Heterarchy Graph — non-transitive preference relationships
// ===========================================================================

/**
 * A heterarchical preference graph.
 *
 * Unlike hierarchy (A > B > C implies A > C), heterarchy allows
 * cycles: A > B > C > A. This models situations where no single
 * element dominates, and context determines precedence.
 *
 * Nodes represent decision-making units; edges represent preference
 * relationships.
 */
export class HeterarchyGraph {
  /** Adjacency list: node -> set of nodes it is preferred over. */
  private edges: Map<string, Set<string>> = new Map();

  /** Add a preference: `preferred` is preferred over `over` in some context. */
  addPreference(preferred: string, over: string): void {
    let set = this.edges.get(preferred);
    if (!set) {
      set = new Set();
      this.edges.set(preferred, set);
    }
    set.add(over);
  }

  /** Check if `a` is directly preferred over `b`. */
  prefers(a: string, b: string): boolean {
    const set = this.edges.get(a);
    return set ? set.has(b) : false;
  }

  /**
   * Detect cycles in the preference graph (non-transitivity).
   * Returns true if any cycle exists -- this is the hallmark of heterarchy.
   *
   * Algorithm: For each node, run DFS looking for a path back to the start.
   * Matches Rust core's cycle detection logic.
   */
  hasCycle(): boolean {
    // Collect all nodes (sources and targets)
    const allNodes = new Set<string>();
    for (const [src, targets] of this.edges) {
      allNodes.add(src);
      for (const t of targets) {
        allNodes.add(t);
      }
    }

    for (const start of allNodes) {
      const visited = new Set<string>();
      const stack: string[] = [start];

      while (stack.length > 0) {
        const node = stack.pop()!;

        if (!visited.has(node)) {
          visited.add(node);
          const neighbors = this.edges.get(node);
          if (neighbors) {
            for (const next of neighbors) {
              if (next === start) {
                return true;
              }
              if (!visited.has(next)) {
                stack.push(next);
              }
            }
          }
        } else {
          // Already visited -- check if it's the start
          if (node === start) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Find all cycles (non-transitive preference loops).
   * Returns arrays of node names forming each cycle.
   */
  findCycles(): string[][] {
    const cycles: string[][] = [];
    const nodes = Array.from(this.edges.keys());
    const visitedStarts = new Set<string>();

    for (const start of nodes) {
      this.dfsCycles(start, start, [start], visitedStarts, cycles);
    }
    return cycles;
  }

  private dfsCycles(
    start: string,
    current: string,
    path: string[],
    visitedStarts: Set<string>,
    cycles: string[][],
  ): void {
    const neighbors = this.edges.get(current);
    if (neighbors) {
      for (const next of neighbors) {
        if (next === start && path.length > 1) {
          if (!visitedStarts.has(start)) {
            cycles.push([...path]);
          }
        } else if (!path.includes(next)) {
          path.push(next);
          this.dfsCycles(start, next, path, visitedStarts, cycles);
          path.pop();
        }
      }
    }
    if (current === start) {
      visitedStarts.add(start);
    }
  }

  /** List all nodes in the graph (sources and targets). */
  nodes(): Set<string> {
    const allNodes = new Set<string>();
    for (const [src, targets] of this.edges) {
      allNodes.add(src);
      for (const t of targets) {
        allNodes.add(t);
      }
    }
    return allNodes;
  }
}

// ===========================================================================
// Redundancy of Potential Command (McCulloch)
// ===========================================================================

/**
 * Authority score for a component in a given context.
 */
export interface AuthorityScore {
  component: string;
  context: string;
  score: number;
}

/**
 * Registry of potential commanders.
 *
 * In a heterarchy, command is not fixed -- the unit best suited to
 * a particular context takes command. This is "redundancy of potential
 * command": multiple units COULD command, and the one with highest
 * contextual authority does.
 */
export class CommandRegistry {
  /** component -> context -> authority score */
  private scores: Map<string, Map<string, number>> = new Map();

  /** Register a component's authority score for a context. */
  register(component: string, context: string, score: number): void {
    let contexts = this.scores.get(component);
    if (!contexts) {
      contexts = new Map();
      this.scores.set(component, contexts);
    }
    contexts.set(context, score);
  }

  /**
   * Determine who commands in a given context.
   * Returns the component with the highest authority score.
   *
   * McCulloch: argmax(authority_score(component, context))
   */
  whoCommands(context: string): AuthorityScore | null {
    let best: AuthorityScore | null = null;

    for (const [component, contexts] of this.scores) {
      const score = contexts.get(context);
      if (score !== undefined) {
        if (best === null || score > best.score) {
          best = { component, context, score };
        }
      }
    }
    return best;
  }

  /**
   * List all components that could potentially command in a context,
   * sorted by score descending.
   */
  potentialCommanders(context: string): AuthorityScore[] {
    const commanders: AuthorityScore[] = [];

    for (const [component, contexts] of this.scores) {
      const score = contexts.get(context);
      if (score !== undefined) {
        commanders.push({ component, context, score });
      }
    }

    commanders.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });
    return commanders;
  }

  /** Check if redundancy exists (more than one potential commander). */
  hasRedundancy(context: string): boolean {
    return this.potentialCommanders(context).length > 1;
  }
}
