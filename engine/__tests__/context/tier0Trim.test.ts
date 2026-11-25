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

  // NOW.md 247a: the loop builds every tool result as `content: [{ type: 'text', text }]`
  // (conversationLoop.ts, executeOneTool), never with a top-level `text`, so the case above was
  // the only shape that was ever trimmed and no real tool result was.
  it('trims a tool_result in the shape the loop builds: content is an array of text blocks', () => {
    const big = 'y'.repeat(20000)
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big }] }] },
    ]
    const trimmed = c.tier0Trim(messages)
    const block = trimmed[0].content[0] as { type: string; tool_use_id: string; content: { type: string; text: string }[] }
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('t1')
    expect(block.content).toHaveLength(1)
    expect(block.content[0].type).toBe('text')
    expect(block.content[0].text.length).toBeLessThan(big.length)
    expect(block.content[0].text).toContain('[trimmed 16000 chars]')
    expect(block.content[0].text.startsWith('y'.repeat(2000))).toBe(true)
    // The input is not changed in place: the loop's own messages stay as they were.
    expect((messages[0].content[0] as any).content[0].text).toBe(big)
  })

  it('trims a tool_result whose content is a string, and leaves its other blocks alone', () => {
    const big = 'z'.repeat(9000)
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const messages = [
      { role: 'user' as const, content: [
        { type: 'tool_result', tool_use_id: 't2', content: big },
        { type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: 'small' }, image] },
      ] },
    ]
    const trimmed = c.tier0Trim(messages)
    expect(String((trimmed[0].content[0] as any).content)).toContain('[trimmed 5000 chars]')
    expect((trimmed[0].content[1] as any).content).toEqual([{ type: 'text', text: 'small' }, image])
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
