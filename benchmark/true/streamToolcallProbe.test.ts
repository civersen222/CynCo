import { describe, test, expect } from 'bun:test'
import { classifyStream } from './streamToolcallProbe.js'

describe('classifyStream', () => {
  test('PASS: structured tool_use with valid JSON args, no leaked markup', () => {
    const c = classifyStream({ toolCalls: [{ name: 'read_file', args: '{"path":"/etc/hosts"}' }], text: '' })
    expect(c.verdict).toBe('PASS')
    expect(c.why).toContain('read_file')
  })

  test('PASS: empty args string is treated as {}', () => {
    expect(classifyStream({ toolCalls: [{ name: 'run_shell', args: '' }], text: '' }).verdict).toBe('PASS')
  })

  test('PASS: text alongside a valid tool call is fine (some models narrate)', () => {
    const c = classifyStream({ toolCalls: [{ name: 'calculate', args: '{"expression":"2+2"}' }], text: 'Let me compute that.' })
    expect(c.verdict).toBe('PASS')
  })

  test('DROP: tool-call markup leaked into content, no structured call (the #145 signature)', () => {
    const c = classifyStream({ toolCalls: [], text: '<tool_call>{"name":"read_file"}</tool_call>' })
    expect(c.verdict).toBe('DROP')
    expect(c.why).toContain('leaked')
  })

  test('DROP: silent empty turn — no text, no tool_use (the 0-token incident signature)', () => {
    const c = classifyStream({ toolCalls: [], text: '' })
    expect(c.verdict).toBe('DROP')
    expect(c.why).toContain('empty')
  })

  test('DROP: whitespace-only turn still counts as empty', () => {
    expect(classifyStream({ toolCalls: [], text: '   \n\t ' }).verdict).toBe('DROP')
  })

  test('OTHER: model produced real text but called no tool', () => {
    const c = classifyStream({ toolCalls: [], text: 'The root filesystem is usually mounted at /.' })
    expect(c.verdict).toBe('OTHER')
    expect(c.why).toContain('no tool call')
  })

  test('OTHER: tool call emitted but args are not valid JSON', () => {
    const c = classifyStream({ toolCalls: [{ name: 'read_file', args: '{path: /etc/hosts' }], text: '' })
    expect(c.verdict).toBe('OTHER')
    expect(c.why).toContain('not valid JSON')
  })

  test('OTHER: valid call but markup also leaked into content', () => {
    const c = classifyStream({ toolCalls: [{ name: 'read_file', args: '{"path":"/x"}' }], text: 'oops </tool_call>' })
    expect(c.verdict).toBe('OTHER')
    expect(c.why).toContain('leaked')
  })

  test('ERROR: a thrown/streamed error short-circuits classification', () => {
    const c = classifyStream({ toolCalls: [], text: '', errored: 'llama-server HTTP 400: context overflow' })
    expect(c.verdict).toBe('ERROR')
    expect(c.why).toContain('400')
  })

  test('tool call with only whitespace name is not counted as a call → DROP on empty text', () => {
    expect(classifyStream({ toolCalls: [{ name: '  ', args: '{}' }], text: '' }).verdict).toBe('DROP')
  })
})
