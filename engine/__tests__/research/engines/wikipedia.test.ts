import { describe, it, expect } from 'bun:test'
import { WikipediaEngine } from '../../../research/engines/wikipedia.js'

const SAMPLE_RESPONSE = {
  query: {
    search: [
      {
        title: 'Machine learning',
        snippet: 'Machine learning is a <span class="searchmatch">subset</span> of artificial intelligence',
        pageid: 233488,
      },
      {
        title: 'Deep learning',
        snippet: '<span class="searchmatch">Deep</span> learning is part of machine learning',
        pageid: 32472,
      },
    ],
  },
}

describe('WikipediaEngine', () => {
  it('has correct metadata', () => {
    const engine = new WikipediaEngine()
    expect(engine.name).toBe('wikipedia')
    expect(engine.domains).toContain('reference')
  })

  it('parses JSON response', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Machine learning')
    expect(results[0].source).toBe('wikipedia')
    expect(results[0].url).toContain('en.wikipedia.org/wiki/Machine_learning')
  })

  it('strips HTML from snippets', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse(SAMPLE_RESPONSE)
    expect(results[0].snippet).not.toContain('<span')
    expect(results[0].snippet).toContain('subset')
  })

  it('handles empty response', () => {
    const engine = new WikipediaEngine()
    const results = engine.parseResponse({ query: { search: [] } })
    expect(results).toEqual([])
  })
})
