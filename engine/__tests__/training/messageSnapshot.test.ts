import { describe, it, expect } from 'vitest'
import { sanitizeMessages, RESULT_CAP_BYTES } from '../../training/messageSnapshot.js'
import type { Message } from '../../types.js'

function toolUse(id: string, name: string, input: Record<string, unknown>): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
}

function toolResult(id: string, text: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

describe('sanitizeMessages', () => {
  it('leaves ordinary text and small results untouched', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'add a test' }] },
      toolUse('t1', 'Read', { file_path: 'src/app.ts' }),
      toolResult('t1', 'export const x = 1'),
    ]
    const out = sanitizeMessages(msgs)
    expect(out.messages).toEqual(msgs)
    expect(out.truncatedMessages).toBe(0)
  })

  it('truncates a tool result over the cap with an elision marker', () => {
    const big = 'x'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([toolUse('t1', 'Read', { file_path: 'big.txt' }), toolResult('t1', big)])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content.length).toBeLessThan(big.length)
    expect(block.content).toContain('bytes elided')
    expect(block.content.startsWith('xxx')).toBe(true)
    expect(block.content.endsWith('xxx')).toBe(true)
  })

  it('redacts a result whose tool input points at a sensitive path', () => {
    const out = sanitizeMessages([
      toolUse('t1', 'Read', { file_path: '/repo/.env' }),
      toolResult('t1', 'OPENAI_API_KEY=sk-realsecret'),
    ])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content).toBe('[redacted: sensitive path]')
    expect(JSON.stringify(out.messages)).not.toContain('sk-realsecret')
  })

  it('redacts credentials, secrets, .pem and id_rsa paths', () => {
    for (const p of ['/a/credentials.json', '/a/secrets.yml', '/a/key.pem', '/home/u/.ssh/id_rsa']) {
      const out = sanitizeMessages([toolUse('t1', 'Read', { file_path: p }), toolResult('t1', 'SECRETVALUE')])
      expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
    }
  })

  it('redacts a sensitive path given as a Bash command argument', () => {
    const out = sanitizeMessages([
      toolUse('t1', 'Bash', { command: 'cat .env' }),
      toolResult('t1', 'TOKEN=ghp_realsecret'),
    ])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content).toBe('[redacted: sensitive path]')
  })

  it('drops oldest non-system messages when the whole snapshot exceeds the file cap', () => {
    const filler = (i: number): Message => ({ role: 'user', content: [{ type: 'text', text: `${i}:` + 'y'.repeat(50_000) }] })
    const msgs: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
      ...Array.from({ length: 60 }, (_, i) => filler(i)),
    ]
    const out = sanitizeMessages(msgs, { fileCapBytes: 500_000 })
    expect(out.truncatedMessages).toBeGreaterThan(0)
    expect(JSON.stringify(out.messages).length).toBeLessThanOrEqual(500_000)
    // The system message survives regardless of age
    expect(out.messages[0].role).toBe('system')
    // The most recent message survives
    expect(JSON.stringify(out.messages)).toContain('59:')
  })

  it('handles a tool_result whose content is a block array, not a string', () => {
    const msgs: Message[] = [
      toolUse('t1', 'Read', { file_path: '/repo/.env' }),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'SECRETVALUE' }] }] },
    ]
    const out = sanitizeMessages(msgs)
    expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
  })

  it('does not mutate the input array', () => {
    const msgs: Message[] = [toolUse('t1', 'Read', { file_path: '/repo/.env' }), toolResult('t1', 'SECRETVALUE')]
    const before = JSON.stringify(msgs)
    sanitizeMessages(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
  })
})

describe('sanitizeMessages — the tool call input, not just its result', () => {
  it('redacts the input of a call that names a sensitive path', () => {
    // Write puts the payload in the INPUT. Capping only results let a whole
    // .env file, secrets and all, through to the exported corpus untouched.
    const [m] = sanitizeMessages([
      toolUse('t1', 'Write', { file_path: '.env', content: 'OPENAI_API_KEY=sk-live-abc123' }),
    ]).messages
    const block = m.content[0] as { type: string; name: string; input: Record<string, unknown> }
    expect(JSON.stringify(block.input)).not.toContain('sk-live-abc123')
    expect(block.name).toBe('Write')
  })

  it('truncates a large input payload while keeping the short arguments', () => {
    const big = 'y'.repeat(RESULT_CAP_BYTES + 5000)
    const [m] = sanitizeMessages([
      toolUse('t1', 'Write', { file_path: 'src/big.ts', content: big }),
    ]).messages
    const input = (m.content[0] as { input: Record<string, string> }).input
    expect(input.file_path).toBe('src/big.ts')
    expect(input.content.length).toBeLessThan(big.length)
    expect(input.content).toContain('bytes elided')
  })

  it('leaves an ordinary small input untouched', () => {
    const [m] = sanitizeMessages([toolUse('t1', 'Read', { file_path: 'a.ts' })]).messages
    expect((m.content[0] as { input: unknown }).input).toEqual({ file_path: 'a.ts' })
  })
})
