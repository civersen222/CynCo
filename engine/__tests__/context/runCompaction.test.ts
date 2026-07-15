import { describe, expect, it } from 'bun:test'
import { ContextCompressor, FileOperationTracker } from '../../context/compressor.js'

function convo(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text', text: `msg ${i}` }],
  }))
}

describe('runCompaction', () => {
  it('journals BEFORE replacing messages (write-before-compact) and resets tracker', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const tracker = new FileOperationTracker()
    tracker.record('a.ts', 'Edit')
    const journaled: { summary: string; fileOps?: string }[] = []
    const messages = convo(20)

    const result = await c.runCompaction(messages, tracker, {
      summarize: async () => 'THE SUMMARY',
      journal: (summary, fileOps) => journaled.push({ summary, fileOps }),
    })

    // journaled exactly once, and it captured the file ops recorded pre-reset
    expect(journaled).toHaveLength(1)
    expect(journaled[0].summary).toBe('THE SUMMARY')
    expect(journaled[0].fileOps).toContain('a.ts')
    // messages replaced: the summary system message is present
    expect(result.some(m => m.role === 'system' && (m.content[0].text as string).includes('THE SUMMARY'))).toBe(true)
    expect(result[0].role).toBe('system')
    expect(result[0].content[0].text as string).toContain('THE SUMMARY')
    // tracker reset after compaction
    expect(tracker.getModifiedFiles()).toEqual([])
  })

  it('returns the original messages unchanged when nothing to compress', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const tracker = new FileOperationTracker()
    const messages = convo(3)
    const result = await c.runCompaction(messages, tracker, {
      summarize: async () => 'unused',
      journal: () => { throw new Error('should not journal') },
    })
    expect(result).toBe(messages)
  })
})
