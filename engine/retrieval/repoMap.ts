export type RankedDefinition = {
  file: string;
  name: string;
  kind: string;
  score: number;
};

interface NodeData {
  file: string;
  name: string;
  kind: string;
}

export class RepoGraph {
  // key: "file::name"
  private nodes = new Map<string, NodeData>();
  // outEdges[from] = set of to-node keys
  private outEdges = new Map<string, Set<string>>();
  // inEdges[to] = set of from-node keys
  private inEdges = new Map<string, Set<string>>();

  private nodeKey(file: string, name: string): string {
    return `${file}::${name}`;
  }

  addDefinition(file: string, name: string, kind: string): void {
    const key = this.nodeKey(file, name);
    if (!this.nodes.has(key)) {
      this.nodes.set(key, { file, name, kind });
      this.outEdges.set(key, new Set());
      this.inEdges.set(key, new Set());
    }
  }

  addReference(fromFile: string, fromName: string, toFile: string, toName: string): void {
    const fromKey = this.nodeKey(fromFile, fromName);
    const toKey = this.nodeKey(toFile, toName);
    // Only add edge if both nodes exist
    if (!this.nodes.has(fromKey) || !this.nodes.has(toKey)) return;
    this.outEdges.get(fromKey)!.add(toKey);
    this.inEdges.get(toKey)!.add(fromKey);
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    let count = 0;
    for (const edges of this.outEdges.values()) {
      count += edges.size;
    }
    return count;
  }

  clear(): void {
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
  }

  pageRank(
    seedFiles: string[],
    topK: number,
    iterations = 20,
    damping = 0.85,
  ): RankedDefinition[] {
    const keys = Array.from(this.nodes.keys());
    const n = keys.length;
    if (n === 0) return [];

    const seedSet = new Set(seedFiles);

    // Build personalization vector
    const personal = new Map<string, number>();
    const seedNodes = keys.filter(k => seedSet.has(this.nodes.get(k)!.file));

    if (seedNodes.length > 0) {
      const weight = 1 / seedNodes.length;
      for (const k of seedNodes) personal.set(k, weight);
      for (const k of keys) if (!personal.has(k)) personal.set(k, 0);
    } else {
      // Uniform distribution
      const weight = 1 / n;
      for (const k of keys) personal.set(k, weight);
    }

    // Initialize scores uniformly
    const scores = new Map<string, number>();
    for (const k of keys) scores.set(k, 1 / n);

    // Iterate PageRank
    for (let i = 0; i < iterations; i++) {
      const newScores = new Map<string, number>();

      for (const k of keys) {
        const personalScore = (1 - damping) * personal.get(k)!;

        // Sum incoming contributions
        let incomingSum = 0;
        for (const fromKey of this.inEdges.get(k)!) {
          const outDeg = this.outEdges.get(fromKey)!.size;
          if (outDeg > 0) {
            incomingSum += scores.get(fromKey)! / outDeg;
          }
        }

        newScores.set(k, personalScore + damping * incomingSum);
      }

      // Handle dangling nodes: nodes with no outgoing edges contribute to all nodes
      // via personalization vector to preserve probability mass
      let danglingSum = 0;
      for (const k of keys) {
        if (this.outEdges.get(k)!.size === 0) {
          danglingSum += scores.get(k)!;
        }
      }
      if (danglingSum > 0) {
        for (const k of keys) {
          newScores.set(k, newScores.get(k)! + damping * danglingSum * personal.get(k)!);
        }
      }

      for (const [k, v] of newScores) scores.set(k, v);
    }

    // Build result array sorted by score descending, return topK
    const results: RankedDefinition[] = keys.map(k => {
      const node = this.nodes.get(k)!;
      return { file: node.file, name: node.name, kind: node.kind, score: scores.get(k)! };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
