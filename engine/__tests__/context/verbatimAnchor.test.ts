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
  it('pins the last <=6 user messages plus the DoD contract', () => {
    const anchors = c.selectVerbatimAnchors(convo(), '## DoD\n- ship it')
    const texts = anchors.map(m => m.content[0].text as string).join('\n')
    expect(texts).toContain('## DoD')
    expect(texts).toContain('u9') // most recent user msg kept
    expect(texts).toContain('[Pinned original task]\nu0') // first = the task, always pinned (F129)
    expect(texts).not.toContain('u1') // middle history dropped (cap 6)
  })

  it('works with no contract (user anchoring only)', () => {
    const anchors = c.selectVerbatimAnchors(convo(), undefined)
    const texts = anchors.map(m => m.content[0].text as string).join('\n')
    expect(texts).toContain('u9')
    expect(texts).not.toContain('## DoD')
  })

  // Qwen3.8's template raises 'No user query found in messages.' — a hard 400
  // from llama-server, mid-run — when every surviving user message is a bare
  // <tool_response>. Compaction is the only place that can produce that shape,
  // so it is the only place that can guarantee it doesn't.
  it('keeps the contract as system but restores user requests as real user turns', () => {
    const anchors = c.selectVerbatimAnchors(convo(), '## DoD\n- ship it')
    expect(anchors[0].role).toBe('system')
    expect(anchors.some(m => m.role === 'user')).toBe(true)
    // first message (the original task) + the last 6
    expect(anchors.filter(m => m.role === 'user')).toHaveLength(7)
  })

  // F129: the mission brief is user message #1; slice(-6) can never reach it
  // once tool traffic exists. Three CivKings C3 missions drifted off-goal after
  // compaction paraphrased the brief away.
  it('always pins the FIRST user message as the original task', () => {
    const anchors = c.selectVerbatimAnchors(convo(), undefined)
    const texts = anchors.map(m => m.content[0].text as string).join('\n')
    expect(texts).toContain('[Pinned original task]\nu0')
    expect(texts).toContain('u9')
  })

  it('does not emit the first user message twice when it is also recent', () => {
    const short: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'the mission' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const anchors = c.selectVerbatimAnchors(short, undefined)
    expect(anchors.filter(m => (m.content[0].text as string).includes('the mission'))).toHaveLength(1)
  })

  // A contract carrying the brief must NOT suppress the user-turn pin: a
  // compacted conversation whose only user content is a system-role anchor is
  // the "no user query" shape that 400s Qwen's template mid-run.
  it('keeps a real user turn even when the contract carries the same text', () => {
    const short: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'the mission' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
    ]
    const anchors = c.selectVerbatimAnchors(short, 'the mission')
    expect(anchors.filter(m => m.role === 'user')).toHaveLength(1)
    expect(anchors.find(m => m.role === 'user')!.content[0].text).toContain('the mission')
  })

  it('ignores tool_result-only user messages, which carry no query text', () => {
    const msgs: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'the real ask' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
    ]
    const anchors = c.selectVerbatimAnchors(msgs, undefined)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].role).toBe('user')
    expect(anchors[0].content[0].text).toContain('the real ask')
  })
})
