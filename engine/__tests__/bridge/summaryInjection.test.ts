import { describe, expect, it } from 'bun:test'
import { shouldInjectSummary, buildSummaryInjectionMessage } from '../../bridge/summaryInjection.js'

describe('shouldInjectSummary', () => {
  const toolsUsed = ['Edit', 'Bash']
  const emptyAssistantText = ''
  const shortAssistantText = 'Done.'
  const longAssistantText = 'I read the config file, updated the temperature setting to 0.5, and verified the change took effect.'

  it('returns true when end_turn + tools used + empty text + not already injected', () => {
    expect(shouldInjectSummary(emptyAssistantText, 'end_turn', toolsUsed, false)).toBe(true)
  })

  it('returns true when end_turn + tools used + short text (< 40 chars) + not already injected', () => {
    expect(shouldInjectSummary(shortAssistantText, 'end_turn', toolsUsed, false)).toBe(true)
  })

  it('returns false when model already narrated (>= 40 chars)', () => {
    expect(shouldInjectSummary(longAssistantText, 'end_turn', toolsUsed, false)).toBe(false)
  })

  it('returns false when no tools were used this session', () => {
    expect(shouldInjectSummary(emptyAssistantText, 'end_turn', [], false)).toBe(false)
  })

  it('returns false when stopReason is not end_turn', () => {
    expect(shouldInjectSummary(emptyAssistantText, 'tool_use', toolsUsed, false)).toBe(false)
    expect(shouldInjectSummary(emptyAssistantText, 'max_tokens', toolsUsed, false)).toBe(false)
    expect(shouldInjectSummary(emptyAssistantText, 'error', toolsUsed, false)).toBe(false)
  })

  it('returns false when already injected (single-shot guard)', () => {
    expect(shouldInjectSummary(emptyAssistantText, 'end_turn', toolsUsed, true)).toBe(false)
  })

  it('treats whitespace-only text as empty', () => {
    expect(shouldInjectSummary('   \n\t  ', 'end_turn', toolsUsed, false)).toBe(true)
  })

  it('counts characters after whitespace strip for threshold', () => {
    expect(shouldInjectSummary('                                        Hi', 'end_turn', toolsUsed, false)).toBe(true)
  })
})

describe('buildSummaryInjectionMessage', () => {
  it('produces a user message with role and text content', () => {
    const msg = buildSummaryInjectionMessage(['Edit'])
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    expect(msg.content[0]).toMatchObject({ type: 'text' })
    expect(typeof (msg.content[0] as any).text).toBe('string')
  })

  it('mentions each unique tool name exactly once in the message', () => {
    const msg = buildSummaryInjectionMessage(['Edit', 'Bash', 'Edit'])
    const text = (msg.content[0] as any).text as string
    expect(text).toContain('Edit')
    expect(text).toContain('Bash')
    const editCount = (text.match(/\bEdit\b/g) ?? []).length
    expect(editCount).toBe(1)
  })

  it('uses singular phrasing for a single tool', () => {
    const text = (buildSummaryInjectionMessage(['Read']).content[0] as any).text as string
    expect(text.toLowerCase()).toContain('tool')
    expect(text.toLowerCase()).not.toContain('tools')
  })

  it('uses plural phrasing for multiple tools', () => {
    const text = (buildSummaryInjectionMessage(['Read', 'Edit']).content[0] as any).text as string
    expect(text.toLowerCase()).toContain('tools')
  })

  it('handles empty tool list gracefully (generic phrasing)', () => {
    const msg = buildSummaryInjectionMessage([])
    const text = (msg.content[0] as any).text as string
    expect(text.length).toBeGreaterThan(10)
  })
})
