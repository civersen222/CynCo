import { describe, it, expect } from 'vitest'
import { pruneRedundantReads } from '../../bridge/contextHygiene.js'

const sigOf = (name: string, input: any) => name === 'Read' ? `read:${input.file_path}` : null

describe('pruneRedundantReads', () => {
  it('prunes certified-redundant Read+DENIED pairs, keeps the most recent, inserts one marker', () => {
    const mk = (i: number) => ([
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: 'a.csv' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'DENIED' }], is_error: true }] },
    ])
    const messages = [
      { role: 'user', content: 'write the budget script' },       // task — must survive
      ...mk(1), ...mk(2), ...mk(3), ...mk(4),
    ]
    const out = pruneRedundantReads(messages as any, new Set(['read:a.csv']), sigOf)
    // task message survives
    expect(out[0]).toEqual(messages[0])
    // exactly one marker inserted
    const markers = out.filter((m: any) => typeof m.content === 'string' && m.content.includes('[context-hygiene]'))
    expect(markers.length).toBe(1)
    // most-recent exchange (t4) retained
    const ids = JSON.stringify(out)
    expect(ids).toContain('t4')
    expect(ids).not.toContain('t1')
    // no orphaned tool_use / tool_result
    const useIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id) : [])
    const resIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) : [])
    expect(new Set(useIds)).toEqual(new Set(resIds))
  })

  it('prunes reasoning-model turns where the tool_use is preceded by a thinking block', () => {
    // qwen3.6 and other reasoning models emit [thinking, tool_use] in one
    // assistant turn — content.length > 1. The single redundant tool_use must
    // still be recognized and pruned.
    const mk = (i: number) => ([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `let me re-read a.csv (attempt ${i})` },
          { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: 'a.csv' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'DENIED' }], is_error: true }] },
    ])
    const messages = [
      { role: 'user', content: 'write the budget script' },
      ...mk(1), ...mk(2), ...mk(3), ...mk(4),
    ]
    const out = pruneRedundantReads(messages as any, new Set(['read:a.csv']), sigOf)
    // task message survives
    expect(out[0]).toEqual(messages[0])
    // fewer messages than input — pruning actually happened
    expect(out.length).toBeLessThan(messages.length)
    // exactly one marker inserted
    const markers = out.filter((m: any) => typeof m.content === 'string' && m.content.includes('[context-hygiene]'))
    expect(markers.length).toBe(1)
    // most-recent exchange (t4) retained, earliest (t1) pruned
    const ids = JSON.stringify(out)
    expect(ids).toContain('t4')
    expect(ids).not.toContain('t1')
    // no orphaned tool_use / tool_result
    const useIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id) : [])
    const resIds = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) : [])
    expect(new Set(useIds)).toEqual(new Set(resIds))
  })

  it('does NOT prune assistant turns that contain more than one tool_use (multi-tool turn)', () => {
    // A turn that reads AND does something else must not be collapsed — the
    // redundancy guarantee only holds for a lone redundant read.
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: 'a.csv' } },
        { type: 'tool_use', id: 'x2', name: 'Grep', input: { pattern: 'foo' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: [], is_error: true }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'x3', name: 'Read', input: { file_path: 'a.csv' } },
        { type: 'tool_use', id: 'x4', name: 'Grep', input: { pattern: 'bar' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x3', content: [], is_error: true }] },
    ]
    const out = pruneRedundantReads(messages as any, new Set(['read:a.csv']), sigOf)
    expect(out).toEqual(messages)
  })

  it('does not touch messages when nothing is certified redundant', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(pruneRedundantReads(messages as any, new Set(), sigOf)).toEqual(messages)
  })
})
