import { describe, expect, it } from 'bun:test'
import { generateReflection } from '../../vsm/reflexionFeedback.js'

describe('generateReflection', () => {
  it('generates Edit feedback for match failure', () => {
    const r = generateReflection('Edit', true, 'old_string not found in file')
    expect(r).toContain('Read')
    expect(r).toContain('exact')
  })

  it('generates Bash feedback for command not found', () => {
    const r = generateReflection('Bash', true, 'command not found: pytest')
    expect(r).toContain('not installed')
  })

  it('generates Bash feedback for test failure', () => {
    const r = generateReflection('Bash', true, '3 fail\nAssertionError: expected 5 got 4')
    expect(r).toContain('test')
  })

  it('generates Write feedback for permission error', () => {
    const r = generateReflection('Write', true, 'EACCES: permission denied')
    expect(r).toContain('permission')
  })

  it('returns empty for success', () => {
    expect(generateReflection('Read', false, 'file contents')).toBe('')
  })

  it('generates generic feedback for unknown errors', () => {
    const r = generateReflection('Glob', true, 'some error')
    expect(r.length).toBeGreaterThan(0)
  })
})
