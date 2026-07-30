import { describe, expect, it } from 'bun:test'
import { ContextCompressor, FileOperationTracker } from '../../context/compressor.js'

const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })

describe('tier0Trim', () => {
  it('truncates oversized tool_result blocks but preserves message shape', () => {
    const big = 'x'.repeat(20000)
    const messages = [
      { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] },
      { role: 'user' as const, content: [{ type: 'tool_result', text: big }] },
    ]
    const trimmed = c.tier0Trim(messages)
    expect(trimmed).toHaveLength(2)
    const block = trimmed[1].content[0]
    expect((block.text as string).length).toBeLessThan(big.length)
    expect(block.text as string).toContain('[trimmed')
  })

  it('leaves small text blocks untouched', () => {
    const messages = [{ role: 'assistant' as const, content: [{ type: 'text', text: 'short' }] }]
    const trimmed = c.tier0Trim(messages)
    expect(trimmed[0].content[0].text).toBe('short')
  })
})

describe('FileOperationTracker.reset', () => {
  it('closes the summary window without discarding the task record', () => {
    // This test used to assert getModifiedFiles() went empty. That was the
    // defect, not the contract — see finding (i) in trackerSurvivesCompaction:
    // filesTouched read 0 for every training row after a compaction. reset()
    // ends the window the summary prompt describes; the task record persists.
    const t = new FileOperationTracker()
    t.record('a.ts', 'Edit')
    expect(t.getModifiedFiles()).toEqual(['a.ts'])
    t.reset()
    expect(t.getModifiedFilesThisWindow()).toEqual([])
    expect(t.getModifiedFiles()).toEqual(['a.ts'])
  })
})
