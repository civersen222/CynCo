import { describe, it, expect } from 'bun:test'
import { chunkResearchReport } from '../../index/researchChunker.js'

const SAMPLE_REPORT = `# Research: WebSocket Patterns
Date: 2026-05-05
Query: WebSocket connection pooling in Bun

## Summary
WebSocket pooling is essential for high-performance servers. Multiple approaches exist with different trade-offs for memory and throughput.

## Findings

### Connection Pooling Strategies
- Round-robin pooling distributes connections evenly — Source: [Pool Patterns](https://example.com/pools)
- Least-connections routing minimizes latency — Source: [Load Balancing](https://example.com/lb)

### Bun-Specific Implementation
- Bun's native WebSocket API supports per-message compression — Source: [Bun Docs](https://bun.sh/docs/ws)
- Connection backpressure is handled via the drain event — Source: [Bun WS](https://bun.sh/docs/ws)

## Sources
1. [Pool Patterns](https://example.com/pools) — duckduckgo
2. [Load Balancing](https://example.com/lb) — github

## Gaps
- No benchmarks found for Bun vs Node.js WebSocket performance
`

describe('Research chunker', () => {
  it('splits report into chunks by headings', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(c => c.chunkType === 'research')).toBe(true)
  })
  it('assigns heading names to chunks', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    const names = chunks.map(c => c.name).filter(Boolean)
    expect(names).toContain('Summary')
    expect(names).toContain('Connection Pooling Strategies')
    expect(names).toContain('Bun-Specific Implementation')
  })
  it('preserves file path on all chunks', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    expect(chunks.every(c => c.filePath === '.cynco/research/test.md')).toBe(true)
  })
  it('sets consistent fileHash', () => {
    const chunks = chunkResearchReport('.cynco/research/test.md', SAMPLE_REPORT)
    const hashes = new Set(chunks.map(c => c.fileHash))
    expect(hashes.size).toBe(1)
  })
  it('skips tiny sections under 50 chars', () => {
    const tiny = `# Title\n\n## Big Section\nThis section has enough content to pass the minimum length threshold for chunking.\n\n## Tiny\nNo.`
    const chunks = chunkResearchReport('test.md', tiny)
    const names = chunks.map(c => c.name)
    expect(names).not.toContain('Tiny')
  })
  it('handles empty content', () => {
    const chunks = chunkResearchReport('test.md', '')
    expect(chunks).toEqual([])
  })
})
