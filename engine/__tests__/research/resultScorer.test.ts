import { describe, it, expect } from 'bun:test'
import { scoreResults, deduplicateResults } from '../../research/resultScorer.js'
import type { SearchResult } from '../../research/types.js'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Result',
    url: 'https://example.com/test',
    snippet: 'A test snippet about coding agents and local LLMs',
    source: 'duckduckgo',
    ...overrides,
  }
}

describe('resultScorer', () => {
  describe('scoreResults', () => {
    it('assigns higher scores to results with more keyword matches', () => {
      const results = [
        makeResult({ title: 'unrelated topic', snippet: 'no matching words here at all' }),
        makeResult({ title: 'local AI coding agent', snippet: 'a local LLM coding agent for developers' }),
      ]
      const scored = scoreResults(results, 'local AI coding agent')
      expect(scored[0].score!).toBeGreaterThan(scored[1].score!)
      expect(scored[0].title).toBe('local AI coding agent')
    })

    it('boosts recent results', () => {
      const old = makeResult({ metadata: { date: '2020-01-01' } })
      const recent = makeResult({ metadata: { date: new Date().toISOString() } })
      const scored = scoreResults([old, recent], 'test')
      const recentScore = scored.find(r => r.metadata?.date?.startsWith('202'))!.score!
      const oldScore = scored.find(r => r.metadata?.date === '2020-01-01')!.score!
      expect(recentScore).toBeGreaterThan(oldScore)
    })

    it('boosts github results with high stars', () => {
      const noStars = makeResult({ source: 'duckduckgo' })
      const highStars = makeResult({ source: 'github', metadata: { stars: 50000 } })
      const scored = scoreResults([noStars, highStars], 'test')
      const ghScore = scored.find(r => r.source === 'github')!.score!
      const ddgScore = scored.find(r => r.source === 'duckduckgo')!.score!
      expect(ghScore).toBeGreaterThan(ddgScore)
    })

    it('boosts results that appear from multiple sources (corroboration)', () => {
      const single = makeResult({ url: 'https://unique.com/only-one', title: 'Single source' })
      const multi1 = makeResult({ url: 'https://shared.com/page', source: 'duckduckgo', title: 'Multi A' })
      const multi2 = makeResult({ url: 'https://shared.com/page', source: 'github', title: 'Multi B' })
      const scored = scoreResults([single, multi1, multi2], 'test')
      const multiScore = scored.find(r => r.title === 'Multi A')!.score!
      const singleScore = scored.find(r => r.title === 'Single source')!.score!
      expect(multiScore).toBeGreaterThan(singleScore)
    })
  })

  describe('deduplicateResults', () => {
    it('removes duplicate URLs keeping highest score', () => {
      const results: SearchResult[] = [
        makeResult({ url: 'https://example.com/a', score: 3, title: 'Low' }),
        makeResult({ url: 'https://example.com/a', score: 7, title: 'High' }),
        makeResult({ url: 'https://example.com/b', score: 5, title: 'Other' }),
      ]
      const deduped = deduplicateResults(results)
      expect(deduped.length).toBe(2)
      expect(deduped.find(r => r.url === 'https://example.com/a')!.title).toBe('High')
    })

    it('normalizes URLs for dedup (strips protocol, www, trailing slash)', () => {
      const results: SearchResult[] = [
        makeResult({ url: 'https://www.example.com/page/', score: 2 }),
        makeResult({ url: 'http://example.com/page', score: 5 }),
      ]
      const deduped = deduplicateResults(results)
      expect(deduped.length).toBe(1)
      expect(deduped[0].score).toBe(5)
    })
  })
})
