import { describe, it, expect } from 'bun:test'
import { searchWithFallback } from '../../../research/engineRouter.js'
import type { SearchEngine, SearchResult } from '../../../research/types.js'

function mockEngine(name: string, results: SearchResult[]): SearchEngine {
  return {
    name,
    description: `Mock ${name}`,
    domains: ['general'],
    search: async () => results,
    healthCheck: async () => true,
  }
}

function failEngine(name: string): SearchEngine {
  return {
    name,
    description: `Failing ${name}`,
    domains: ['general'],
    search: async () => [],
    healthCheck: async () => true,
  }
}

describe('searchWithFallback', () => {
  it('returns primary results when available', async () => {
    const primary = mockEngine('primary', [
      { title: 'A', url: 'https://a.com', snippet: 'Result A', source: 'primary' },
    ])
    const fallback = mockEngine('duckduckgo', [
      { title: 'B', url: 'https://b.com', snippet: 'Result B', source: 'duckduckgo' },
    ])
    const results = await searchWithFallback('test', primary, [primary, fallback], 5)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('A')
  })

  it('falls back to duckduckgo when primary returns empty', async () => {
    const primary = failEngine('primary')
    const ddg = mockEngine('duckduckgo', [
      { title: 'DDG', url: 'https://ddg.com', snippet: 'From DDG', source: 'duckduckgo' },
    ])
    const results = await searchWithFallback('test', primary, [primary, ddg], 5)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('DDG')
  })

  it('tries multiple fallbacks in order', async () => {
    const primary = failEngine('primary')
    const ddg = failEngine('duckduckgo')
    const searxng = failEngine('searxng')
    const wiki = mockEngine('wikipedia', [
      { title: 'Wiki', url: 'https://wiki.com', snippet: 'From Wiki', source: 'wikipedia' },
    ])
    const results = await searchWithFallback('test', primary, [primary, ddg, searxng, wiki], 5)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Wiki')
  })

  it('returns empty when all engines fail', async () => {
    const primary = failEngine('primary')
    const ddg = failEngine('duckduckgo')
    const results = await searchWithFallback('test', primary, [primary, ddg], 5)
    expect(results).toEqual([])
  })
})
