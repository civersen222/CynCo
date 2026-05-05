import { describe, it, expect } from 'bun:test'
import { indexResearchReport } from '../../research/indexer.js'
import type { Chunk } from '../../index/types.js'

class MockStore {
  chunks: { chunk: Chunk; embedding: number[] }[] = []
  insertChunk(chunk: Chunk, embedding: number[]): number {
    this.chunks.push({ chunk, embedding })
    return this.chunks.length
  }
  close() {}
}

class MockEmbedClient {
  callCount = 0
  async embed(text: string): Promise<number[]> {
    this.callCount++
    return [0.1, 0.2, 0.3]
  }
}

describe('indexResearchReport', () => {
  it('chunks and embeds a research report', async () => {
    const store = new MockStore()
    const embedClient = new MockEmbedClient()
    const report = `# Research: Test Topic\n\n## Summary\nThis is a test research report with enough content to pass the minimum chunk size threshold.\n\n## Findings\nWe found that testing is important and should always be done with sufficient detail and context.\n`

    const count = await indexResearchReport(
      report,
      '.cynco/research/test.md',
      store as any,
      embedClient as any,
    )

    expect(count).toBeGreaterThan(0)
    expect(store.chunks.length).toBe(count)
    expect(embedClient.callCount).toBe(count)
    expect(store.chunks[0].chunk.chunkType).toBe('research')
  })
  it('returns 0 for empty content', async () => {
    const store = new MockStore()
    const embedClient = new MockEmbedClient()
    const count = await indexResearchReport('', 'test.md', store as any, embedClient as any)
    expect(count).toBe(0)
  })
  it('continues indexing if one chunk fails', async () => {
    const store = new MockStore()
    let callIdx = 0
    const embedClient = {
      async embed(text: string) {
        callIdx++
        if (callIdx === 1) throw new Error('Embedding failed')
        return [0.1, 0.2, 0.3]
      },
    }
    const report = `# Research: Test\n\n## Section A\nFirst section with enough content to be chunked properly by the research chunker.\n\n## Section B\nSecond section also with enough content to be chunked properly by the research chunker.\n`

    const count = await indexResearchReport(report, 'test.md', store as any, embedClient as any)
    expect(count).toBe(1)
  })
})
