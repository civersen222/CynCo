import { describe, expect, it } from 'vitest'
import { ContextCompressor, FileOperationTracker } from '../../context/compressor.js'

// Finding (x): the compaction summary carried the brief and the pinned user
// requests, and nothing about what the task had already committed. The agent
// came out of a compaction and set about redoing finished work.

function convo(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text', text: `msg ${i}` }],
  }))
}

const systemText = (msgs: { role: string; content: { text?: unknown }[] }[]) =>
  msgs.filter(m => m.role === 'system').map(m => String(m.content[0].text ?? '')).join('\n---\n')

describe('compaction pins the task\'s own commits', () => {
  it('carries the commit log through as a verbatim anchor, not a summarized claim', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const result = await c.runCompaction(convo(20), new FileOperationTracker(), {
      summarize: async () => 'THE SUMMARY',
      journal: () => {},
      commitLog: 'abc1234 restore the deleted cases\ngilded/tests/test_ui_broadsheet.py',
    })

    const text = systemText(result)
    expect(text).toContain('abc1234 restore the deleted cases')
    expect(text).toContain('gilded/tests/test_ui_broadsheet.py')
  })

  it('says nothing when the commit log could not be measured', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const result = await c.runCompaction(convo(20), new FileOperationTracker(), {
      summarize: async () => 'THE SUMMARY',
      journal: () => {},
    })

    // Not "no commits yet" — an absent measurement must not print as an empty
    // list, which reads as permission to start over.
    expect(systemText(result).toLowerCase()).not.toContain('commit')
  })

  it('states plainly that the task has committed nothing when that is measured', async () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const result = await c.runCompaction(convo(20), new FileOperationTracker(), {
      summarize: async () => 'THE SUMMARY',
      journal: () => {},
      commitLog: '',
    })

    expect(systemText(result)).toContain('no commits')
  })
})
