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

  // NOW.md 247b: the cut was positional. In-loop compaction (conversationLoop.ts, "compact before
  // overflow") runs after the model's assistant message with its tool calls is pushed and before
  // their results, so the conversation ends on a pending tool_use, and four messages back from
  // there is a user message of results whose assistant tool_use was summarized away: an orphan
  // tool_result that a strict chat-completions endpoint rejects.
  it('never starts the kept tail on a tool_result whose tool_use was summarized', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'the task' }] }]
    const call = (i: number) => ({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: `call${i}`, name: 'Read', input: { file_path: `f${i}.ts` } }] })
    for (let i = 0; i < 6; i++) {
      messages.push(call(i))
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call${i}`, content: [{ type: 'text', text: `result ${i}` }] }] })
    }
    messages.push(call(6)) // the batch whose results are not in yet
    let prompt = ''
    const result = await c.runCompaction(messages, new FileOperationTracker(), {
      keepRecentPairs: 2,
      summarize: async (p) => { prompt = p; return 'THE SUMMARY' },
      journal: () => {},
    })
    const textOf = (m: any) => String(m.content[0]?.text ?? '')
    const tail = result.filter(m => !/^\[(Context Summary|Pinned |Committed so far)/.test(textOf(m)))
    // Every tool_result kept has its tool_use kept before it.
    const usesSeen = new Set<string>()
    for (const m of tail) {
      for (const b of m.content as any[]) {
        if (b.type === 'tool_use') usesSeen.add(b.id)
        if (b.type === 'tool_result') expect(usesSeen.has(b.tool_use_id), `orphan ${b.tool_use_id}`).toBe(true)
      }
    }
    // The cut moved back by one, to the call: five messages kept, the call first.
    expect(tail).toEqual(messages.slice(-5))
    expect(tail[0].role).toBe('assistant')
    // And what is kept is not also summarized.
    expect(prompt).not.toContain('step 4')
    expect(prompt).toContain('step 3')
  })

  // NOW.md 247c: a recent user request that is also in the kept tail was pinned as an anchor
  // too, so in a text chat it reached the model twice.
  it('does not pin a user request that the kept tail already holds', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const messages = convo(12) // users at 0, 2, ..., 10
    const result = await c.runCompaction(messages, new FileOperationTracker(), {
      keepRecentPairs: 2,
      summarize: async () => 'THE SUMMARY',
      journal: () => {},
    })
    const texts = result.map(m => String(m.content[0].text ?? ''))
    for (const i of [8, 10]) {
      // Kept verbatim in the tail, and nowhere else.
      expect(texts.filter(t => t.includes(`msg ${i}`)), `msg ${i}`).toEqual([`msg ${i}`])
    }
    // The requests that were summarized are still pinned (the cap of six reaches back to msg 0,
    // which is the original task and pinned as such).
    for (const i of [2, 4, 6]) expect(texts).toContain(`[Pinned user request]\nmsg ${i}`)
    expect(texts).toContain('[Pinned original task]\nmsg 0')
  })

  // Wave 15b, check C4-6: the original task was pinned unconditionally, so when the kept tail already
  // held it (a short conversation, or a tail moved back by keptTailStart) it reached the model twice.
  it('does not pin the original task when the kept tail already holds it', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const text = (role: 'user' | 'assistant', t: string) => ({ role, content: [{ type: 'text', text: t }] })
    // A resumed conversation that opens on the assistant's own notes; the task is the first user text.
    const messages: any[] = [text('assistant', 'note a'), text('assistant', 'note b'), text('assistant', 'note c'),
      text('user', 'the task'), text('assistant', 'working'), text('user', 'and also this'), text('assistant', 'done')]
    const result = await c.runCompaction(messages, new FileOperationTracker(), {
      keepRecentPairs: 2,
      summarize: async () => 'THE SUMMARY',
      journal: () => {},
    })
    const texts = result.map(m => String(m.content[0].text ?? ''))
    expect(texts.filter(t => t.includes('the task'))).toEqual(['the task'])
    expect(texts.filter(t => t.includes('and also this'))).toEqual(['and also this'])
    // A user turn is still there for a template that looks for one: the tail's own.
    expect(result.some(m => m.role === 'user' && String(m.content[0].text) === 'the task')).toBe(true)
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
