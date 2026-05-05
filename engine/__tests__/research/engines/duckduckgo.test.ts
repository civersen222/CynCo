import { describe, it, expect } from 'bun:test'
import { DuckDuckGoEngine } from '../../../research/engines/duckduckgo.js'

const SAMPLE_HTML = `
<div class="results">
  <div class="result">
    <a class="result__a" href="https://example.com/page1">Example Page One</a>
    <a class="result__url" href="https://example.com/page1">example.com/page1</a>
    <a class="result__snippet" href="#">This is the first search result snippet with enough text to pass the filter.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://example.com/page2">Example Page Two</a>
    <a class="result__url" href="https://example.com/page2">example.com/page2</a>
    <a class="result__snippet" href="#">Second result snippet with &#x27;entities&#x27; and &amp; symbols decoded properly.</a>
  </div>
</div>
`

describe('DuckDuckGoEngine', () => {
  it('has correct metadata', () => {
    const engine = new DuckDuckGoEngine()
    expect(engine.name).toBe('duckduckgo')
    expect(engine.domains).toContain('general')
    expect(engine.domains).toContain('web')
  })

  it('parses HTML results', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 5)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Example Page One')
    expect(results[0].source).toBe('duckduckgo')
    expect(results[0].url).toBe('https://example.com/page1')
  })

  it('decodes HTML entities in snippets', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 5)
    expect(results[1].snippet).toContain("'entities'")
    expect(results[1].snippet).toContain('& symbols')
  })

  it('respects maxResults limit', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults(SAMPLE_HTML, 1)
    expect(results.length).toBe(1)
  })

  it('returns empty array for no results', () => {
    const engine = new DuckDuckGoEngine()
    const results = engine.parseResults('<html><body>No results</body></html>', 5)
    expect(results).toEqual([])
  })
})
