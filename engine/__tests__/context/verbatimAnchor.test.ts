import { describe, expect, it } from 'bun:test'
import { ContextCompressor } from '../../context/compressor.js'

const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })

function convo() {
  const msgs: any[] = []
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }] })
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })
  }
  return msgs
}

describe('selectVerbatimAnchors', () => {
  it('pins the last <=6 user messages plus the DoD contract as system messages', () => {
    const anchors = c.selectVerbatimAnchors(convo(), '## DoD\n- ship it')
    const texts = anchors.map(m => m.content[0].text as string).join('\n')
    expect(texts).toContain('## DoD')
    expect(texts).toContain('u9') // most recent user msg kept
    expect(texts).not.toContain('u0') // oldest dropped (cap 6)
    expect(anchors.every(m => m.role === 'system')).toBe(true)
  })

  it('works with no contract (user anchoring only)', () => {
    const anchors = c.selectVerbatimAnchors(convo(), undefined)
    const texts = anchors.map(m => m.content[0].text as string).join('\n')
    expect(texts).toContain('u9')
    expect(texts).not.toContain('## DoD')
  })
})
