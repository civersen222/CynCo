import { describe, it, expect } from 'vitest'
import {
  repairToolCall, parseNativeToolCalls, isMalformedInput, MALFORMED_KEY,
} from '../../engine/toolCallRepair.js'

describe('repairToolCall', () => {
  it('parses valid JSON without marking repaired', () => {
    const r = repairToolCall('{"file_path": "a.ts"}')
    expect(r).toEqual({ ok: true, input: { file_path: 'a.ts' }, repaired: false })
  })

  it('salvages trailing commas via jsonrepair and marks repaired', () => {
    const r = repairToolCall('{"file_path": "a.ts",}')
    expect(r).toEqual({ ok: true, input: { file_path: 'a.ts' }, repaired: true })
  })

  it('salvages single quotes and unquoted keys', () => {
    const r = repairToolCall("{file_path: 'a.ts'}")
    expect(r).toEqual({ ok: true, input: { file_path: 'a.ts' }, repaired: true })
  })

  it('treats empty/whitespace string as empty input (zero-arg tools)', () => {
    expect(repairToolCall('')).toEqual({ ok: true, input: {}, repaired: false })
    expect(repairToolCall('  ')).toEqual({ ok: true, input: {}, repaired: false })
  })

  it('rejects non-object JSON (arrays, scalars) as malformed', () => {
    // [1,2] is valid JSON but not a plain object — ok:false
    const r = repairToolCall('[1,2]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.raw).toBe('[1,2]')
  })

  it('returns ok:false with error + raw for unrepairable garbage', () => {
    // <tool_call>...</tool_call> is genuinely unrepairable by jsonrepair
    const garbage = '<tool_call>blah</tool_call>'
    const r = repairToolCall(garbage)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0)
      expect(r.raw).toBe(garbage)
    }
  })
})

describe('parseNativeToolCalls', () => {
  it('converts well-formed OpenAI tool_calls to tool_use blocks', () => {
    const blocks = parseNativeToolCalls([
      { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
    ])
    expect(blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
  })

  it('marks unparseable arguments as malformed instead of dropping', () => {
    // <tool_call>...</tool_call> is genuinely unrepairable — exercises the ok:false path
    const blocks = parseNativeToolCalls([
      { id: 'call_2', type: 'function', function: { name: 'Write', arguments: '<tool_call>blah</tool_call>' } },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].name).toBe('Write')
    expect(isMalformedInput(blocks[0].input)).toBe(true)
    expect((blocks[0].input as any).raw).toBe('<tool_call>blah</tool_call>')
  })

  it('generates an id when missing', () => {
    const blocks = parseNativeToolCalls([
      { type: 'function', function: { name: 'Read', arguments: '{}' } } as any,
    ])
    expect(blocks[0].id).toBeTruthy()
  })
})

describe('isMalformedInput', () => {
  it('detects the marker', () => {
    expect(isMalformedInput({ [MALFORMED_KEY]: true, raw: 'x', error: 'e' })).toBe(true)
    expect(isMalformedInput({ file_path: 'a.ts' })).toBe(false)
    expect(isMalformedInput(undefined)).toBe(false)
    expect(isMalformedInput(null)).toBe(false)
  })
})
