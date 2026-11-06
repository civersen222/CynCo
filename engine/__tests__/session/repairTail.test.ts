// engine/__tests__/session/repairTail.test.ts
import { describe, expect, it } from 'bun:test'
import { danglingToolResults, INTERRUPTED_TOOL_RESULT } from '../../session/repairTail.js'
import type { Message } from '../../types.js'

const user: Message = { role: 'user', content: [{ type: 'text', text: 'go' }] }

describe('danglingToolResults', () => {
  it('closes an assistant turn whose tool calls never got results', () => {
    const msgs: Message[] = [user, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking the lineup.' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'python x.py' } },
        { type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'a.md' } },
      ],
    }]
    const fix = danglingToolResults(msgs)
    expect(fix?.role).toBe('user')
    expect(fix?.content.map((b) => (b as any).tool_use_id)).toEqual(['call-1', 'call-2'])
    expect(fix?.content.every((b) => (b as any).type === 'tool_result' && (b as any).is_error === true)).toBe(true)
    expect((fix?.content[0] as any).content).toBe(INTERRUPTED_TOOL_RESULT)
  })

  it('leaves a clean tail alone', () => {
    expect(danglingToolResults([user, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }])).toBeNull()
    expect(danglingToolResults([user, { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }] }])).toBeNull()
    expect(danglingToolResults([])).toBeNull()
  })
})
