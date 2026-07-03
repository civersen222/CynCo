// engine/__tests__/context/compressorReplace.test.ts
import { describe, expect, it } from 'bun:test'
import { ContextCompressor } from '../../context/compressor.js'

function msg(role: 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text', text }] } as any
}

describe('compressMessages replacement semantics (prefill-elimination lock)', () => {
  it('replaces compressed messages — output is [summary, ...recent], originals gone', () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5, keepRecent: 2 })
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`))
    const out = c.compressMessages(messages, 'THE SUMMARY')
    // keepRecent=2 → last 4 messages kept, plus exactly one summary message
    expect(out.length).toBe(5)
    expect(out[0].role).toBe('system')
    expect(out[0].content[0].text).toContain('THE SUMMARY')
    expect(out.slice(1).map((m: any) => m.content[0].text)).toEqual([
      'turn-8', 'turn-9', 'turn-10', 'turn-11',
    ])
    // None of the compressed originals survive
    const allText = JSON.stringify(out)
    expect(allText).not.toContain('turn-0')
    expect(allText).not.toContain('turn-7')
  })
})
