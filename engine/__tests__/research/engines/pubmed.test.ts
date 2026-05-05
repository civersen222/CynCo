import { describe, it, expect } from 'bun:test'
import { PubMedEngine } from '../../../research/engines/pubmed.js'

const SAMPLE_SUMMARY = {
  result: {
    '12345': {
      title: 'Effects of exercise on cognitive function in older adults.',
      authors: [{ name: 'Smith J' }, { name: 'Jones A' }],
      pubdate: '2023 Jan',
      elocationid: 'doi: 10.1234/test.123',
    },
    '67890': {
      title: 'A meta-analysis of dietary interventions.',
      authors: [{ name: 'Davis C' }],
      pubdate: '2023 Mar',
    },
  },
}

describe('PubMedEngine', () => {
  it('has correct metadata', () => {
    const engine = new PubMedEngine()
    expect(engine.name).toBe('pubmed')
    expect(engine.domains).toContain('biomedical')
    expect(engine.domains).toContain('health')
  })
  it('parses summary response', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345', '67890'], SAMPLE_SUMMARY)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Effects of exercise on cognitive function in older adults.')
    expect(results[0].url).toBe('https://pubmed.ncbi.nlm.nih.gov/12345/')
    expect(results[0].source).toBe('pubmed')
  })
  it('extracts authors and date', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345'], SAMPLE_SUMMARY)
    expect(results[0].metadata?.authors).toEqual(['Smith J', 'Jones A'])
    expect(results[0].metadata?.date).toBe('2023 Jan')
  })
  it('extracts DOI when present', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['12345', '67890'], SAMPLE_SUMMARY)
    expect(results[0].metadata?.doi).toBe('doi: 10.1234/test.123')
    expect(results[1].metadata?.doi).toBeUndefined()
  })
  it('skips missing IDs', () => {
    const engine = new PubMedEngine()
    const results = engine.parseSummary(['99999'], SAMPLE_SUMMARY)
    expect(results).toEqual([])
  })
})
