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
    // Each filler is capped to RESULT_CAP_BYTES by the per-block cap before the
    // file cap sees it, so the file cap has to be below 60 * ~4 KB to bite.
    const out = sanitizeMessages(msgs, { fileCapBytes: 50_000 })
    expect(out.truncatedMessages).toBeGreaterThan(0)
    expect(JSON.stringify(out.messages).length).toBeLessThanOrEqual(50_000)
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

// ─── Fix 1: orphaned tool results fail closed ─────────────────────

describe('sanitizeMessages — orphaned tool results', () => {
  it('redacts a tool_result whose tool_use is absent from the array', () => {
    // Compaction (conversationLoop.compactNow) replaces this.messages wholesale
    // and can drop the assistant turn holding Read({file_path: '.env'}) while
    // keeping its result. Provenance is then unknowable, so it must not be kept.
    const out = sanitizeMessages([toolResult('gone', 'OPENAI_API_KEY=SECRETVALUE')])
    const block = (out.messages[0].content as any[])[0]
    expect(block.content).toBe('[redacted: orphaned tool result]')
    expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
  })

  it('uses a marker distinct from the sensitive-path one', () => {
    const orphan = sanitizeMessages([toolResult('gone', 'x')]).messages
    const pathed = sanitizeMessages([
      toolUse('t1', 'Read', { file_path: '.env' }),
      toolResult('t1', 'x'),
    ]).messages
    const a = (orphan[0].content as any[])[0].content
    const b = (pathed[1].content as any[])[0].content
    expect(a).not.toBe(b)
  })

  it('still keeps a result whose tool_use appears LATER in the array', () => {
    // Order is not provenance — the pair exists, so the result is provenanced.
    const out = sanitizeMessages([toolResult('t1', 'fine'), toolUse('t1', 'Read', { file_path: 'a.ts' })])
    expect((out.messages[0].content as any[])[0].content).toBe('fine')
  })

  it('redacts a tool_result with a missing or non-string tool_use_id', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', content: 'SECRETVALUE' } as any] },
    ]
    const out = sanitizeMessages(msgs)
    expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
  })
})

// ─── Fix 2: non-tool blocks are capped, binary payloads dropped ───

describe('sanitizeMessages — non-tool blocks', () => {
  it('caps a long text block at the same cap as a tool result', () => {
    const big = 'z'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([{ role: 'assistant', content: [{ type: 'text', text: big }] }])
    const block = (out.messages[0].content as any[])[0]
    expect(block.text.length).toBeLessThan(big.length)
    expect(block.text).toContain('bytes elided')
  })

  it('caps a long thinking block', () => {
    const big = 'q'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([{ role: 'assistant', content: [{ type: 'thinking', text: big }] }])
    expect(((out.messages[0].content as any[])[0]).text).toContain('bytes elided')
  })

  it('caps a long connector_text block', () => {
    const big = 'c'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([{ role: 'user', content: [{ type: 'connector_text', text: big }] }])
    expect(((out.messages[0].content as any[])[0]).text).toContain('bytes elided')
  })

  it('replaces an image base64 payload with a marker, keeping the media type', () => {
    const data = 'A'.repeat(200_000)
    const out = sanitizeMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
    ])
    const block = (out.messages[0].content as any[])[0]
    expect(block.source.data).not.toContain('AAAA')
    expect(block.source.media_type).toBe('image/png')
    expect(JSON.stringify(out.messages).length).toBeLessThan(1000)
  })

  it('replaces a base64 document payload with a marker', () => {
    const data = 'B'.repeat(200_000)
    const out = sanitizeMessages([
      {
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }],
      },
    ])
    expect(JSON.stringify(out.messages).length).toBeLessThan(1000)
  })

  it('caps a text document source rather than dropping it', () => {
    const big = 'd'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([
      { role: 'user', content: [{ type: 'document', source: { type: 'text', text: big } }] },
    ])
    const src = (out.messages[0].content as any[])[0].source
    expect(src.type).toBe('text')
    expect(src.text).toContain('bytes elided')
  })

  it('replaces redacted_thinking data with a marker', () => {
    const out = sanitizeMessages([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'E'.repeat(100_000) }] },
    ])
    expect(JSON.stringify(out.messages)).not.toContain('EEEE')
  })

  it('leaves a short text block byte-identical', () => {
    const msgs: Message[] = [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }]
    expect(sanitizeMessages(msgs).messages).toEqual(msgs)
  })
})

// ─── Fix 3: value-shaped secrets, independent of the path check ───

describe('sanitizeMessages — secret-shaped values', () => {
  const secrets: [string, string][] = [
    ['openai', 'sk-proj-abcdefghijklmnop0123456789'],
    ['github classic', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github fine-grained', 'github_pat_11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOP'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    // The two Slack fixtures are assembled from segments instead of written as
    // literals. They are synthetic — sequential digits, alphabet tail, no real
    // workspace — but GitHub's push protection matches the Slack token SHAPE
    // and, unlike the OpenAI/GitHub/AWS patterns above, has no checksum to
    // reject a fake with. A literal here therefore blocks every push of this
    // branch. `join('-')` yields a byte-identical string, so the redactor is
    // still exercised against the exact shape it has to catch.
    ['slack bot', ['xoxb', '123456789012', '1234567890123',
      'abcdefghijklmnopqrstuvwx'].join('-')],
    ['slack user', ['xoxp', '123456789012', '1234567890123',
      'abcdefghijklmnopqrstuvwx'].join('-')],
  ]

  for (const [label, secret] of secrets) {
    it(`redacts a ${label} token in a tool INPUT under a non-sensitive path`, () => {
      const out = sanitizeMessages([
        toolUse('t1', 'Write', { file_path: 'src/config.ts', content: `const KEY = "${secret}"` }),
      ])
      const input = (out.messages[0].content as any[])[0].input
      expect(JSON.stringify(input)).not.toContain(secret)
      expect(JSON.stringify(input)).toContain('[redacted: secret]')
      // The span, not the message: the surrounding text is the training signal.
      expect(input.content).toContain('const KEY =')
      expect(input.file_path).toBe('src/config.ts')
    })

    it(`redacts a ${label} token in a tool RESULT under a non-sensitive path`, () => {
      const out = sanitizeMessages([
        toolUse('t1', 'Bash', { command: 'printenv' }),
        toolResult('t1', `SOME_KEY=${secret}\nHOME=/root`),
      ])
      const content = (out.messages[1].content as any[])[0].content
      expect(content).not.toContain(secret)
      expect(content).toContain('[redacted: secret]')
      expect(content).toContain('HOME=/root')
    })
  }

  it('redacts a PEM private key body', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyzSECRETBODY\n-----END RSA PRIVATE KEY-----'
    const out = sanitizeMessages([
      toolUse('t1', 'Write', { file_path: 'src/key.ts', content: `const K = \`${pem}\`` }),
    ])
    const s = JSON.stringify(out.messages)
    expect(s).not.toContain('SECRETBODY')
    expect(s).toContain('[redacted: secret]')
  })

  it('redacts an unterminated PEM block through to the end of the string', () => {
    const out = sanitizeMessages([
      toolUse('t1', 'Bash', { command: 'cat k' }),
      toolResult('t1', '-----BEGIN PRIVATE KEY-----\nMIIEvSECRETTAIL'),
    ])
    expect(JSON.stringify(out.messages)).not.toContain('SECRETTAIL')
  })

  it('redacts a secret in a plain text block', () => {
    const out = sanitizeMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for auth' }] },
    ])
    const text = (out.messages[0].content as any[])[0].text
    expect(text).not.toContain('ghp_abcdef')
    expect(text).toContain('for auth')
  })

  it('redacts a secret sitting past the truncation head of an oversized result', () => {
    // Redaction must run BEFORE truncation, or a secret in the retained tail
    // survives verbatim.
    const secret = 'sk-proj-tailsecret0123456789abcdef'
    const body = 'x'.repeat(RESULT_CAP_BYTES) + '\nKEY=' + secret
    const out = sanitizeMessages([toolUse('t1', 'Read', { file_path: 'a.ts' }), toolResult('t1', body)])
    expect(JSON.stringify(out.messages)).not.toContain(secret)
  })

  it('leaves ordinary code that merely mentions a key NAME alone', () => {
    const text = 'read process.env.OPENAI_API_KEY at startup'
    const out = sanitizeMessages([{ role: 'assistant', content: [{ type: 'text', text }] }])
    expect((out.messages[0].content as any[])[0].text).toBe(text)
  })
})
