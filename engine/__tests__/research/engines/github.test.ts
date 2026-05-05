import { describe, it, expect } from 'bun:test'
import { GitHubEngine } from '../../../research/engines/github.js'

const SAMPLE_RESPONSE = {
  items: [
    {
      full_name: 'facebook/react',
      html_url: 'https://github.com/facebook/react',
      description: 'The library for web and native user interfaces.',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      full_name: 'vuejs/vue',
      html_url: 'https://github.com/vuejs/vue',
      description: null,
      updated_at: '2026-01-02T00:00:00Z',
    },
  ],
}

describe('GitHubEngine', () => {
  it('has correct metadata', () => {
    const engine = new GitHubEngine()
    expect(engine.name).toBe('github')
    expect(engine.domains).toContain('code')
    expect(engine.domains).toContain('repos')
  })
  it('parses JSON response', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('facebook/react')
    expect(results[0].url).toBe('https://github.com/facebook/react')
    expect(results[0].source).toBe('github')
  })
  it('handles null description', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[1].snippet).toBe('')
  })
  it('extracts repo metadata', () => {
    const engine = new GitHubEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[0].metadata?.repo).toBe('facebook/react')
    expect(results[0].metadata?.date).toBe('2026-01-01T00:00:00Z')
  })
  it('handles empty items', () => {
    const engine = new GitHubEngine()
    expect(engine.parseResponse({ items: [] })).toEqual([])
    expect(engine.parseResponse({})).toEqual([])
  })
})
