import { describe, test, expect, beforeEach } from 'bun:test';
import { RepoGraph } from '../../retrieval/repoMap.js';

describe('RepoGraph', () => {
  let graph: RepoGraph;

  beforeEach(() => {
    graph = new RepoGraph();
  });

  describe('addDefinition / addReference', () => {
    test('tracks node count correctly', () => {
      expect(graph.nodeCount()).toBe(0);
      graph.addDefinition('a.ts', 'funcA', 'function');
      expect(graph.nodeCount()).toBe(1);
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addDefinition('b.ts', 'helper', 'function');
      expect(graph.nodeCount()).toBe(3);
    });

    test('duplicate addDefinition does not increase count', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('a.ts', 'funcA', 'function');
      expect(graph.nodeCount()).toBe(1);
    });

    test('tracks edge count correctly', () => {
      expect(graph.edgeCount()).toBe(0);
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');
      expect(graph.edgeCount()).toBe(1);
    });

    test('addReference ignores missing nodes', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      // 'ghost' does not exist
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ghost');
      expect(graph.edgeCount()).toBe(0);

      graph.addReference('x.ts', 'missing', 'a.ts', 'funcA');
      expect(graph.edgeCount()).toBe(0);
    });

    test('addReference does not duplicate edges', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');
      expect(graph.edgeCount()).toBe(1);
    });
  });

  describe('pageRank', () => {
    test('returns empty array for empty graph', () => {
      const results = graph.pageRank(['a.ts'], 10);
      expect(results).toEqual([]);
    });

    test('returns at most topK results', () => {
      graph.addDefinition('a.ts', 'f1', 'function');
      graph.addDefinition('a.ts', 'f2', 'function');
      graph.addDefinition('b.ts', 'g1', 'function');
      graph.addDefinition('c.ts', 'h1', 'function');
      const results = graph.pageRank([], 2);
      expect(results.length).toBe(2);
    });

    test('seeded PageRank ranks nodes in seed files higher', () => {
      // Build a graph where b.ts nodes are referenced by a.ts (seed)
      // a.ts -> b.ts (central hub), c.ts is isolated
      graph.addDefinition('a.ts', 'caller', 'function');
      graph.addDefinition('b.ts', 'hub', 'class');
      graph.addDefinition('c.ts', 'isolated', 'function');

      // a.ts/caller references b.ts/hub
      graph.addReference('a.ts', 'caller', 'b.ts', 'hub');

      // Seed on a.ts — a.ts/caller should get boosted, and b.ts/hub should rank
      // higher than c.ts/isolated due to incoming link from the seed
      const results = graph.pageRank(['a.ts'], 3);

      const hubScore = results.find(r => r.name === 'hub')!.score;
      const isolatedScore = results.find(r => r.name === 'isolated')!.score;

      expect(hubScore).toBeGreaterThan(isolatedScore);
    });

    test('seeded PageRank returns results with correct shape', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');

      const results = graph.pageRank(['a.ts'], 10);
      expect(results.length).toBe(2);
      for (const r of results) {
        expect(typeof r.file).toBe('string');
        expect(typeof r.name).toBe('string');
        expect(typeof r.kind).toBe('string');
        expect(typeof r.score).toBe('number');
        expect(r.score).toBeGreaterThan(0);
      }
    });

    test('results are sorted by score descending', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addDefinition('b.ts', 'helper', 'function');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');
      graph.addReference('b.ts', 'helper', 'b.ts', 'ClassB');

      const results = graph.pageRank(['a.ts'], 10);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    test('empty seed falls back to uniform and still returns results', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');

      const results = graph.pageRank([], 10);
      expect(results.length).toBe(2);
      // All scores should be positive
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
      }
    });

    test('unknown seed file behaves like uniform (no nodes matched)', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');

      const resultEmpty = graph.pageRank([], 10);
      const resultUnknown = graph.pageRank(['does-not-exist.ts'], 10);

      // Both should return results with positive scores
      expect(resultEmpty.length).toBe(2);
      expect(resultUnknown.length).toBe(2);
    });
  });

  describe('clear', () => {
    test('resets node and edge counts to zero', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.addDefinition('b.ts', 'ClassB', 'class');
      graph.addReference('a.ts', 'funcA', 'b.ts', 'ClassB');

      expect(graph.nodeCount()).toBe(2);
      expect(graph.edgeCount()).toBe(1);

      graph.clear();

      expect(graph.nodeCount()).toBe(0);
      expect(graph.edgeCount()).toBe(0);
    });

    test('allows adding definitions after clear', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.clear();
      graph.addDefinition('c.ts', 'newFunc', 'function');
      expect(graph.nodeCount()).toBe(1);
    });

    test('pageRank on cleared graph returns empty array', () => {
      graph.addDefinition('a.ts', 'funcA', 'function');
      graph.clear();
      const results = graph.pageRank(['a.ts'], 10);
      expect(results).toEqual([]);
    });
  });
});
