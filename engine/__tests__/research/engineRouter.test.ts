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
  // Keywords are whole words or phrases, not substrings (2026-10-28: fantasy news searches went to GitHub
  // because 'repo' is inside 'report', and to Hugging Face because 'ai' is inside 'Raiders').
  it('a keyword inside a longer word does not route: "injury report" is not a code query', () => {
    const result = routeQuery('Deebo Samuel injury report', engines)
    expect(result.map(e => e.name)).not.toContain('github')
    expect(result.map(e => e.name)).toEqual(['wikipedia', 'duckduckgo'])   // general engines only, in listed order
  })
  it('"Raiders" does not match the ai keyword', () => {
    const withHf = [...engines, mockEngine('huggingface', ['models', 'datasets', 'ml', 'ai'])]
    expect(routeQuery('Raiders RB depth chart', withHf).map(e => e.name)).not.toContain('huggingface')
    expect(routeQuery('best AI coding model', withHf).map(e => e.name)).toContain('huggingface')
  })
  it('phrases and hyphenated keywords still match as whole phrases', () => {
    const withHf = [...engines, mockEngine('huggingface', ['models', 'datasets', 'ml', 'ai'])]
    expect(routeQuery('how to fine-tune with lora', withHf)[0].name).toBe('huggingface')
    expect(routeQuery('what is a monad', engines)[0].name).toBe('wikipedia')
  })

  // Whole words, but plurals, -ed forms and a trailing version number still count (the overcorrection the
  // 2026-10-28 review caught: 'papers', 'datasets', 'libraries', 'llama3' had stopped routing).
  it('plural and inflected keyword forms still route', () => {
    const all = [...engines, mockEngine('huggingface', ['models', 'datasets', 'ml', 'ai']), mockEngine('pubmed', ['biomedical', 'medicine'])]
    expect(routeQuery('recent papers on diffusion', all)[0].name).toBe('arxiv')
    expect(routeQuery('datasets for named entity recognition', all)[0].name).toBe('huggingface')
    expect(routeQuery('best python libraries for scraping', all)[0].name).toBe('github')
    expect(routeQuery('drugs for hypertension', all)[0].name).toBe('pubmed')
    expect(routeQuery('fine-tuned checkpoints', all)[0].name).toBe('huggingface')
  })
  it('a version number right after a keyword still matches', () => {
    expect(routeQuery('llama3 release notes', engines)[0].name).toBe('github')
  })
  it('the inflection allowance does not reopen the substring bugs', () => {
    const all = [...engines, mockEngine('huggingface', ['models', 'datasets', 'ml', 'ai'])]
    for (const q of ['Deebo Samuel injury report', 'Raiders RB depth chart', 'first aid kit', 'again and again'])
      expect(routeQuery(q, all).map(e => e.name)).toEqual(['wikipedia', 'duckduckgo'])
  })

  it('returns empty for empty engine list', () => {
    expect(routeQuery('test', [])).toEqual([])
  })
})
