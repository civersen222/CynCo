import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { routeQuery } from '../research/engineRouter.js'
import { scoreResults, deduplicateResults } from '../research/resultScorer.js'
import { resetEngines, initEngines, getAllEngines } from '../research/engines/registry.js'
import type { SearchResult, SearchEngine } from '../research/types.js'

// ─── routeQuery tests ─────────────────────────────────────────────────────────

describe('routeQuery', () => {
  const makeEngine = (name: string, domains: string[]): SearchEngine => ({
    name,
    description: `Mock ${name}`,
    domains,
    search: async () => [],
    healthCheck: async () => true,
  })

  it('returns empty when no engines are provided', () => {
    const result = routeQuery('anything', [])
    expect(result).toEqual([])
  })

  it('routes code queries to code-domain engines', () => {
    const engines = [
      makeEngine('github', ['code', 'repos']),
      makeEngine('wikipedia', ['reference', 'encyclopedia']),
    ]
    const result = routeQuery('npm package library implementation', engines)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].name).toBe('github')
  })

  it('routes academic queries to academic engines', () => {
    const engines = [
      makeEngine('arxiv', ['academic', 'cs', 'papers']),
      makeEngine('duckduckgo', ['web', 'general']),
    ]
    const result = routeQuery('machine learning neural network deep learning paper', engines)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].name).toBe('arxiv')
  })

  it('includes general-purpose engines even for non-matching queries', () => {
    const engines = [
      makeEngine('duckduckgo', ['web', 'general']),
      makeEngine('github', ['code', 'repos']),
    ]
    const result = routeQuery('something random', engines)
    // general/web engines get score 0.5 and should appear
    const names = result.map(e => e.name)
    expect(names).toContain('duckduckgo')
  })

  it('sorts results by descending relevance score', () => {
    const engines = [
      makeEngine('arxiv', ['academic', 'cs', 'papers', 'ml', 'ai']),
      makeEngine('github', ['code', 'repos']),
      makeEngine('duckduckgo', ['web', 'general']),
    ]
    const result = routeQuery('machine learning neural network deep learning transformer ai', engines)
    // arxiv has more matching keywords so should rank first
    expect(result[0].name).toBe('arxiv')
  })
})

// ─── scoreResults tests ───────────────────────────────────────────────────────

describe('scoreResults', () => {
  const makeResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
    title: 'Test result',
    url: 'https://example.com/test',
    snippet: 'A test snippet.',
    source: 'duckduckgo',
    ...overrides,
  })

  it('returns results with a score field', () => {
    const results = [makeResult({ title: 'foo bar', snippet: 'foo bar baz' })]
    const scored = scoreResults(results, 'foo bar')
    expect(scored[0].score).toBeDefined()
    expect(typeof scored[0].score).toBe('number')
  })

  it('gives higher score to results with query keywords in title/snippet', () => {
    const results = [
      makeResult({ title: 'unrelated topic', snippet: 'something else entirely' }),
      makeResult({ title: 'typescript library implementation', snippet: 'open source typescript framework package' }),
    ]
    const scored = scoreResults(results, 'typescript library implementation')
    expect(scored[0].score!).toBeGreaterThan(scored[1].score!)
    expect(scored[0].title).toBe('typescript library implementation')
  })

  it('gives github results with high stars a higher authority score', () => {
    const results = [
      makeResult({ source: 'duckduckgo', url: 'https://example.com/a', title: 'query term', snippet: 'query term' }),
      makeResult({ source: 'github', url: 'https://github.com/org/repo', title: 'query term', snippet: 'query term', metadata: { stars: 15000 } }),
    ]
    const scored = scoreResults(results, 'query term')
    const github = scored.find(r => r.source === 'github')!
    const ddg = scored.find(r => r.source === 'duckduckgo')!
    expect(github.score!).toBeGreaterThan(ddg.score!)
  })

  it('boosts corroborated results (same URL from multiple engines)', () => {
    const url = 'https://corroborated.com/page'
    const results = [
      makeResult({ url, source: 'duckduckgo', title: 'same page', snippet: 'same' }),
      makeResult({ url, source: 'searxng', title: 'same page', snippet: 'same' }),
      makeResult({ url: 'https://unique.com/page', source: 'duckduckgo', title: 'unique', snippet: 'unique' }),
    ]
    const scored = scoreResults(results, 'same page')
    const corroborated = scored.filter(r => r.url === url)
    const unique = scored.find(r => r.url !== url)!
    // At least one corroborated copy should score higher than the unique result
    expect(corroborated.some(r => r.score! >= unique.score!)).toBe(true)
  })

  it('returns results sorted by descending score', () => {
    const results = [
      makeResult({ title: 'unrelated', snippet: 'nothing here', url: 'https://a.com' }),
      makeResult({ title: 'best match typescript', snippet: 'typescript library implementation framework', url: 'https://b.com' }),
    ]
    const scored = scoreResults(results, 'typescript library')
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score!).toBeGreaterThanOrEqual(scored[i].score!)
    }
  })
})

// ─── deduplicateResults tests ─────────────────────────────────────────────────

describe('deduplicateResults', () => {
  const makeResult = (url: string, score = 5, extra: Partial<SearchResult> = {}): SearchResult => ({
    title: 'title',
    url,
    snippet: 'snippet',
    source: 'duckduckgo',
    score,
    ...extra,
  })

  it('removes duplicate URLs, keeping highest-scored version', () => {
    const results = [
      makeResult('https://example.com/page', 3),
      makeResult('https://example.com/page', 7),
      makeResult('https://other.com/page', 5),
    ]
    const deduped = deduplicateResults(results)
    const exampleResults = deduped.filter(r => r.url === 'https://example.com/page')
    expect(exampleResults.length).toBe(1)
    expect(exampleResults[0].score).toBe(7)
  })

  it('treats http and https of same URL as duplicates', () => {
    const results = [
      makeResult('https://example.com/page', 4),
      makeResult('http://example.com/page', 6),
    ]
    const deduped = deduplicateResults(results)
    expect(deduped.length).toBe(1)
    expect(deduped[0].score).toBe(6)
  })

  it('treats www. and non-www as duplicates', () => {
    const results = [
      makeResult('https://www.example.com/page', 8),
      makeResult('https://example.com/page', 3),
    ]
    const deduped = deduplicateResults(results)
    expect(deduped.length).toBe(1)
    expect(deduped[0].score).toBe(8)
  })

  it('keeps distinct URLs as separate results', () => {
    const results = [
      makeResult('https://a.com/page1'),
      makeResult('https://b.com/page2'),
      makeResult('https://c.com/page3'),
    ]
    const deduped = deduplicateResults(results)
    expect(deduped.length).toBe(3)
  })

  it('returns empty array for empty input', () => {
    expect(deduplicateResults([])).toEqual([])
  })

  it('handles results with no URL by using title as key', () => {
    const results = [
      { title: 'Same Title', url: '', snippet: 'a', source: 'x', score: 5 },
      { title: 'Same Title', url: '', snippet: 'b', source: 'y', score: 9 },
      { title: 'Different Title', url: '', snippet: 'c', source: 'z', score: 3 },
    ]
    const deduped = deduplicateResults(results)
    const sameTitles = deduped.filter(r => r.title === 'Same Title')
    expect(sameTitles.length).toBe(1)
    expect(sameTitles[0].score).toBe(9)
  })
})

// ─── web.search handler integration (logic-only, no WebSocket) ───────────────

describe('web.search handler logic', () => {
  /**
   * Replicates the logic in the new main.ts case 'web.search' handler
   * so we can test the formatting and flow without a live WebSocket server.
   */
  async function runWebSearchHandler(
    queries: string[],
    mockSearch: (q: string) => Promise<SearchResult[]>,
  ): Promise<string> {
    const { routeQuery: route } = await import('../research/engineRouter.js')
    const { scoreResults: score, deduplicateResults: dedup } = await import('../research/resultScorer.js')

    const allEngines: SearchEngine[] = [
      {
        name: 'mock',
        description: 'Mock engine',
        domains: ['general', 'web'],
        search: mockSearch,
        healthCheck: async () => true,
      },
    ]

    const allResults: string[] = []

    for (const query of queries.slice(0, 5)) {
      try {
        const engines = route(query, allEngines)
        const topEngines = engines.slice(0, 2)
        if (topEngines.length === 0) continue

        const searches = topEngines.map(e => e.search(query, 5).catch(() => [] as SearchResult[]))
        const raw = (await Promise.allSettled(searches))
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => (r as PromiseFulfilledResult<SearchResult[]>).value)

        const scored = score(raw, query)
        const results = dedup(scored).slice(0, 5)

        if (results.length === 0) continue

        const formatted = results.map((r, i) => {
          const meta = r.metadata
          const authorLine = meta?.authors?.length ? `\n   Authors: ${meta.authors.join(', ')}` : ''
          const dateLine = meta?.date ? `\n   Date: ${meta.date}` : ''
          const starsLine = meta?.stars != null && meta.stars > 0 ? `\n   Stars: ${meta.stars.toLocaleString()}` : ''
          const scoreLine = r.score != null ? ` (score: ${r.score})` : ''
          return `${i + 1}. ${r.title}${scoreLine}\n   ${r.url}\n   [${r.source}] ${r.snippet}${starsLine}${authorLine}${dateLine}`
        }).join('\n\n')

        allResults.push(`Search: "${query}"\n\n${formatted}`)
      } catch {
        // skip failed query
      }
    }

    return allResults.join('\n\n---\n\n') || 'No search results found.'
  }

  it('formats results with title, URL, source, snippet', async () => {
    const mockResults: SearchResult[] = [
      { title: 'TypeScript Handbook', url: 'https://typescriptlang.org', snippet: 'Official TypeScript docs', source: 'duckduckgo', score: 5 },
    ]
    const output = await runWebSearchHandler(['typescript handbook'], async () => mockResults)
    expect(output).toContain('TypeScript Handbook')
    expect(output).toContain('https://typescriptlang.org')
    expect(output).toContain('[duckduckgo]')
    expect(output).toContain('Official TypeScript docs')
  })

  it('includes score, authors, date when present in metadata', async () => {
    const mockResults: SearchResult[] = [{
      title: 'Research Paper',
      url: 'https://arxiv.org/abs/1234.5678',
      snippet: 'A great paper',
      source: 'arxiv',
      score: 7.5,
      metadata: {
        authors: ['Alice Smith', 'Bob Jones'],
        date: '2024-03-15',
        stars: 0,
      },
    }]
    const output = await runWebSearchHandler(['research paper'], async () => mockResults)
    // Score is recalculated by scoreResults — just verify a score line appears
    expect(output).toMatch(/score: \d/)
    expect(output).toContain('Authors: Alice Smith, Bob Jones')
    expect(output).toContain('Date: 2024-03-15')
  })

  it('includes star count for github results with stars', async () => {
    const mockResults: SearchResult[] = [{
      title: 'Popular Repo',
      url: 'https://github.com/org/repo',
      snippet: 'A popular open source project',
      source: 'github',
      score: 8,
      metadata: { stars: 25000 },
    }]
    const output = await runWebSearchHandler(['open source project'], async () => mockResults)
    expect(output).toContain('Stars: 25,000')
  })

  it('handles multiple queries and separates them', async () => {
    const output = await runWebSearchHandler(
      ['query one', 'query two'],
      async (q) => [{ title: `Result for ${q}`, url: `https://ex.com/${q}`, snippet: 'snippet', source: 'mock' }],
    )
    expect(output).toContain('Search: "query one"')
    expect(output).toContain('Search: "query two"')
  })

  it('caps queries at 5', async () => {
    const queriesSeen: string[] = []
    await runWebSearchHandler(
      ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
      async (q) => { queriesSeen.push(q); return [] },
    )
    expect(queriesSeen.length).toBeLessThanOrEqual(5)
  })

  it('returns fallback message when no results found', async () => {
    const output = await runWebSearchHandler(['nothing matches'], async () => [])
    expect(output).toBe('No search results found.')
  })
})
