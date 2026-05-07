import { describe, it, expect } from 'bun:test'
import { routeQuery } from '../../research/engineRouter.js'
import type { SearchEngine } from '../../research/types.js'

function mockEngine(name: string, domains: string[]): SearchEngine {
  return {
    name,
    description: `Mock ${name}`,
    domains,
    search: async () => [],
    healthCheck: async () => true,
  }
}

describe('Engine router', () => {
  const engines = [
    mockEngine('arxiv', ['academic', 'cs', 'physics']),
    mockEngine('wikipedia', ['reference', 'general']),
    mockEngine('github', ['code', 'repos', 'technical']),
    mockEngine('duckduckgo', ['general', 'web']),
  ]

  it('routes academic queries to arxiv', () => {
    const result = routeQuery('machine learning research paper', engines)
    expect(result[0].name).toBe('arxiv')
  })
  it('routes code queries to github', () => {
    const result = routeQuery('typescript framework implementation', engines)
    expect(result[0].name).toBe('github')
  })
  it('routes definition queries to wikipedia', () => {
    const result = routeQuery('what is quantum computing', engines)
    const names = result.map(e => e.name)
    expect(names).toContain('wikipedia')
  })
  it('always includes general engines as fallback', () => {
    const result = routeQuery('obscure query with no domain match', engines)
    expect(result.length).toBeGreaterThan(0)
    const names = result.map(e => e.name)
    expect(names).toContain('duckduckgo')
  })
  it('returns empty for empty engine list', () => {
    expect(routeQuery('test', [])).toEqual([])
  })
})
