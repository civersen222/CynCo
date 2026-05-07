import { describe, it, expect } from 'bun:test'
import { SearXNGEngine } from '../../../research/engines/searxng.js'

const SAMPLE_RESPONSE = {
  results: [
    { title: 'First Result', url: 'https://example.com/1', content: 'First result content text' },
    { title: 'Second Result', url: 'https://example.com/2', content: 'Second result content text' },
    { title: 'Third Result', url: 'https://example.com/3', content: 'Third result content text' },
  ],
}

describe('SearXNGEngine', () => {
  it('has correct metadata', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    expect(engine.name).toBe('searxng')
    expect(engine.domains).toContain('general')
    expect(engine.domains).toContain('meta')
  })
  it('parses JSON response', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    const results = engine.parseResponse(SAMPLE_RESPONSE, 5)
    expect(results.length).toBe(3)
    expect(results[0].title).toBe('First Result')
    expect(results[0].url).toBe('https://example.com/1')
    expect(results[0].source).toBe('searxng')
  })
  it('respects maxResults limit', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    const results = engine.parseResponse(SAMPLE_RESPONSE, 2)
    expect(results.length).toBe(2)
  })
  it('healthCheck returns false when no baseUrl', async () => {
    const engine = new SearXNGEngine('')
    expect(await engine.healthCheck()).toBe(false)
  })
  it('search returns empty when no baseUrl', async () => {
    const engine = new SearXNGEngine('')
    const results = await engine.search('test')
    expect(results).toEqual([])
  })
  it('handles empty results', () => {
    const engine = new SearXNGEngine('http://localhost:8080')
    expect(engine.parseResponse({ results: [] }, 5)).toEqual([])
    expect(engine.parseResponse({}, 5)).toEqual([])
  })
})
