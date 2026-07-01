import { describe, expect, it, afterEach } from 'bun:test'
import { generateReflection, withReflexion } from '../../vsm/reflexionFeedback.js'

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

describe('withReflexion', () => {
  afterEach(() => {
    delete process.env.LOCALCODE_REFLEXION
  })

  it('appends a reflexion note to errored tool output by default', () => {
    delete process.env.LOCALCODE_REFLEXION
    const out = withReflexion('Edit', true, 'old_string not found', 'BASE')
    expect(out).toContain('BASE')
    expect(out).toContain('[reflexion]')
    expect(out).toContain('Read')
  })

  it('leaves output untouched on success', () => {
    expect(withReflexion('Read', false, 'contents', 'BASE')).toBe('BASE')
  })

  it('is a no-op when LOCALCODE_REFLEXION=0', () => {
    process.env.LOCALCODE_REFLEXION = '0'
    expect(withReflexion('Edit', true, 'old_string not found', 'BASE')).toBe('BASE')
  })
})
