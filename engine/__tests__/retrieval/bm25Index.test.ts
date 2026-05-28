import { describe, it, expect, beforeEach } from 'bun:test';
import { BM25Index } from '../../retrieval/bm25Index.js';

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it('adds and retrieves documents', () => {
    index.add(1, 'function parseToken tokenize identifier');
    index.add(2, 'class DatabaseConnection pool query');

    const results = index.search('tokenize', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe(1);
  });

  it('ranks by relevance', () => {
    index.add(1, 'search search search bm25 ranking');
    index.add(2, 'search bm25 something else entirely');
    index.add(3, 'completely unrelated document about cats');

    const results = index.search('search bm25', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both matching docs should rank above the non-matching one
    const matchingIds = results.slice(0, 2).map(r => r.docId);
    expect(matchingIds).toContain(1);
    expect(matchingIds).toContain(2);
    // Non-matching doc should not appear in top 2
    expect(matchingIds).not.toContain(3);
    // Doc with higher term frequency should rank first
    expect(results[0].docId).toBe(1);
  });

  it('returns empty for no matches', () => {
    index.add(1, 'function parseToken identifier');
    index.add(2, 'class DatabaseConnection pool');

    const results = index.search('xyzzy_nonexistent_term', 5);
    expect(results).toEqual([]);
  });

  it('removes documents', () => {
    index.add(1, 'function tokenize parse identifier');
    index.add(2, 'class DatabaseConnection pool query');

    index.remove(1);

    const results = index.search('tokenize', 5);
    const ids = results.map(r => r.docId);
    expect(ids).not.toContain(1);
  });

  it('handles empty query', () => {
    index.add(1, 'function parseToken identifier');

    const results = index.search('', 5);
    expect(results).toEqual([]);
  });

  it('handles query with only short tokens (filtered out)', () => {
    index.add(1, 'function parseToken identifier');

    const results = index.search('a b', 5);
    expect(results).toEqual([]);
  });

  it('respects topK limit', () => {
    for (let i = 1; i <= 10; i++) {
      index.add(i, `document with the word search repeated ${i} times search`);
    }

    const results = index.search('search', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
