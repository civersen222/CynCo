import { describe, expect, it } from 'bun:test'
import { capToolResult } from '../tools/resultCap.js'

describe('capToolResult', () => {
  it('returns short output unchanged', () => {
    const output = 'hello world'
    expect(capToolResult(output, 32768)).toBe(output)
  })

  it('returns output unchanged when exactly at cap for small context', () => {
    const output = 'x'.repeat(2000)
    expect(capToolResult(output, 32768)).toBe(output)
  })

  it('caps at 2000 for context < 64000', () => {
    const output = 'a'.repeat(5000)
    const result = capToolResult(output, 32768)
    // head = 2000 - 500 = 1500, tail = 300, plus the truncation marker
    expect(result.length).toBeLessThan(output.length)
    expect(result).toContain('...(truncated')
    // cap is 2000, so truncated = 5000 - 2000 = 3000
    expect(result).toContain('3000 chars')
  })

  it('caps at 4000 for context >= 64000', () => {
    const output = 'b'.repeat(8000)
    const result = capToolResult(output, 64000)
    expect(result.length).toBeLessThan(output.length)
    expect(result).toContain('...(truncated')
    // cap is 4000, so truncated = 8000 - 4000 = 4000
    expect(result).toContain('4000 chars')
  })

  it('does not cap when output equals cap for large context', () => {
    const output = 'c'.repeat(4000)
    expect(capToolResult(output, 128000)).toBe(output)
  })

  it('preserves start of output', () => {
    const prefix = 'START_MARKER'
    const output = prefix + 'x'.repeat(5000)
    const result = capToolResult(output, 32768)
    expect(result.startsWith(prefix)).toBe(true)
  })

  it('preserves end of output', () => {
    const suffix = 'END_MARKER'
    const output = 'x'.repeat(5000) + suffix
    const result = capToolResult(output, 32768)
    expect(result.endsWith(suffix)).toBe(true)
  })

  it('shows correct truncated char count', () => {
    const output = 'z'.repeat(3500)
    // context < 64000, cap = 2000, truncated = 3500 - 2000 = 1500
    const result = capToolResult(output, 16000)
    expect(result).toContain('(truncated 1500 chars)')
  })

  it('uses 64000 boundary correctly: 63999 uses 2000 cap', () => {
    const output = 'x'.repeat(3000)
    const result = capToolResult(output, 63999)
    // cap=2000, truncated=3000-2000=1000
    expect(result).toContain('(truncated 1000 chars)')
  })

  it('uses 64000 boundary correctly: 64000 uses 4000 cap', () => {
    const output = 'x'.repeat(5000)
    const result = capToolResult(output, 64000)
    // cap=4000, truncated=5000-4000=1000
    expect(result).toContain('(truncated 1000 chars)')
  })
})
