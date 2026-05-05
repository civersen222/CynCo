import { describe, it, expect } from 'bun:test'
import type { SearchResult, SearchEngine } from '../../research/types.js'

describe('Research types', () => {
  it('SearchResult has required fields', () => {
    const result: SearchResult = {
      title: 'Test Paper',
      url: 'https://example.com/paper',
      snippet: 'A test paper about testing',
      source: 'arxiv',
    }
    expect(result.title).toBe('Test Paper')
    expect(result.source).toBe('arxiv')
  })

  it('SearchResult supports optional metadata', () => {
    const result: SearchResult = {
      title: 'Test',
      url: 'https://example.com',
      snippet: 'Test snippet',
      source: 'pubmed',
      relevance: 0.95,
      metadata: {
        authors: ['Alice', 'Bob'],
        date: '2026-01-01',
        doi: '10.1234/test',
      },
    }
    expect(result.metadata?.authors).toEqual(['Alice', 'Bob'])
    expect(result.relevance).toBe(0.95)
  })

  it('SearchEngine interface can be implemented', () => {
    const engine: SearchEngine = {
      name: 'test',
      description: 'Test engine',
      domains: ['general'],
      search: async () => [],
      healthCheck: async () => true,
    }
    expect(engine.name).toBe('test')
    expect(engine.domains).toContain('general')
  })
})
