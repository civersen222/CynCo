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
    // Summary window closed after compaction — but the task record survives it.
    // The original assertion here was `getModifiedFiles()).toEqual([])`, which
    // pinned finding (i): every measurement consumer reads that method, and each
    // one is asking about the whole task rather than the last window.
    expect(tracker.getModifiedFilesThisWindow()).toEqual([])
    expect(tracker.getModifiedFiles()).toEqual(['a.ts'])
  })

  // The selection and the kept tail once took different counts: the loop asks
  // for 2 pairs, the selection honoured it and compressMessages kept its own
  // default of 4, so four messages were both summarized and kept verbatim.
  // Whatever count rules, the kept tail and the summarized part must not overlap
  // and must together be the whole conversation.
  it.each([
    { label: 'the caller asks for 2 pairs on a compressor whose default is 4', keepRecent: undefined, keepRecentPairs: 2, kept: 4 },
    { label: 'the caller names no count: the compressor\'s own keepRecent', keepRecent: 3, keepRecentPairs: undefined, kept: 6 },
  ])('keeps verbatim exactly what it left out of the summary when $label', async ({ keepRecent, keepRecentPairs, kept }) => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5, keepRecent })
    const messages = convo(20)
    let prompt = ''
    const result = await c.runCompaction(messages, new FileOperationTracker(), {
      keepRecentPairs,
      summarize: async (p) => { prompt = p; return 'THE SUMMARY' },
      journal: () => {},
    })
    const textOf = (m: { content: { text?: unknown }[] }) => String(m.content[0].text ?? '')
    // Everything that is neither the summary nor a pinned anchor is a message
    // kept as it was; it must be the requested tail and nothing more.
    const verbatim = result.filter(m => !/^\[(Context Summary|Pinned |Committed so far)/.test(textOf(m)))
    expect(verbatim).toEqual(messages.slice(-kept))
    // And the summary prompt covered every message before that tail, and none in it.
    const lines = prompt.split('\n')
    messages.forEach((m, i) => {
      const line = `${m.role === 'user' ? 'User' : 'Assistant'}: msg ${i}`
      expect(lines.includes(line), line).toBe(i < messages.length - kept)
    })
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
