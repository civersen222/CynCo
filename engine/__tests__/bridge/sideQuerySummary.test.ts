import { describe, it, expect } from 'vitest'
import { buildSideQueryBody, readSideQueryContent } from '../../bridge/sideQuery.js'

describe('side query request shape', () => {
  it('gives a summarization call a real token budget, not 200', () => {
    const body = buildSideQueryBody({ prompt: 'summarize this', maxTokens: 4000, model: 'm' })
    expect(body.max_tokens).toBe(4000)
  })

  it('does not send the dead /no_think prefix', () => {
    const body = buildSideQueryBody({ prompt: 'summarize this', maxTokens: 4000, model: 'm' })
    expect(body.messages[body.messages.length - 1].content).toBe('summarize this')
  })

  it('turns thinking off the way this chat template actually reads it', () => {
    // Verified against the live server's own /props template: the switch is
    // `enable_thinking`, checked at template lines 46 and 174. Sending
    // `reasoning_effort: 'none'` instead returns HTTP 400 — reasoning_effort is
    // only read inside the `enable_thinking is true` branch and accepts only
    // xhigh/medium/low, so 'none' raises from the jinja itself.
    const body = buildSideQueryBody({ prompt: 'p', maxTokens: 4000, model: 'm' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: false })
  })

  it('never sends reasoning_effort: none, which this template rejects with a 400', () => {
    const body = buildSideQueryBody({ prompt: 'p', maxTokens: 4000, model: 'm' })
    expect((body.chat_template_kwargs as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })
})

describe('side query response reading', () => {
  it('returns content when content is present', () => {
    expect(readSideQueryContent({ choices: [{ message: { content: 'the summary' } }] })).toBe('the summary')
  })

  it('falls back to reasoning_content when the model put it all in reasoning', () => {
    expect(readSideQueryContent({
      choices: [{ message: { content: '', reasoning_content: 'the summary lived here' } }],
    })).toBe('the summary lived here')
  })

  it('returns empty string when neither is present', () => {
    expect(readSideQueryContent({ choices: [{ message: {} }] })).toBe('')
  })
})
