import { describe, it, expect } from 'bun:test'
import { ArXivEngine } from '../../../research/engines/arxiv.js'

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>Attention Is All You Need Revisited</title>
    <summary>We revisit the transformer architecture and propose improvements for long-context scenarios.</summary>
    <published>2023-01-01T00:00:00Z</published>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/example</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00002v1</id>
    <title>Scaling Laws for
    Neural Language Models</title>
    <summary>We study the scaling behavior of language models across different sizes.</summary>
    <published>2023-01-02T00:00:00Z</published>
    <author><name>Carol Davis</name></author>
  </entry>
</feed>`

describe('ArXivEngine', () => {
  it('has correct metadata', () => {
    const engine = new ArXivEngine()
    expect(engine.name).toBe('arxiv')
    expect(engine.domains).toContain('academic')
    expect(engine.domains).toContain('cs')
  })

  it('parses Atom XML entries', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Attention Is All You Need Revisited')
    expect(results[0].url).toBe('http://arxiv.org/abs/2301.00001v1')
    expect(results[0].source).toBe('arxiv')
  })

  it('extracts authors and date', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[0].metadata?.authors).toEqual(['Alice Smith', 'Bob Jones'])
    expect(results[0].metadata?.date).toBe('2023-01-01T00:00:00Z')
  })

  it('extracts DOI when present', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[0].metadata?.doi).toBe('10.1234/example')
    expect(results[1].metadata?.doi).toBeUndefined()
  })

  it('normalizes multi-line titles', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom(SAMPLE_ATOM)
    expect(results[1].title).toBe('Scaling Laws for Neural Language Models')
  })

  it('handles empty feed', () => {
    const engine = new ArXivEngine()
    const results = engine.parseAtom('<feed></feed>')
    expect(results).toEqual([])
  })
})
