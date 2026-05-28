import { describe, it, expect } from 'vitest'
import { diagnoseError } from '../tools/errorDiagnosis.js'

describe('diagnoseError', () => {
  it('classifies SyntaxError', () => {
    const result = diagnoseError('SyntaxError: Unexpected token } at line 10')
    expect(result.type).toBe('syntax')
    expect(result.hint).toBe('Check syntax near the indicated line')
  })

  it('classifies parse error as syntax', () => {
    const result = diagnoseError('parse error: unexpected token near "end"')
    expect(result.type).toBe('syntax')
  })

  it('classifies ModuleNotFoundError as dependency', () => {
    const result = diagnoseError('ModuleNotFoundError: No module named "requests"')
    expect(result.type).toBe('dependency')
    expect(result.hint).toBe('Install the missing package first')
  })

  it('classifies Cannot find module as dependency', () => {
    const result = diagnoseError("Error: Cannot find module './missing'")
    expect(result.type).toBe('dependency')
  })

  it('classifies Permission denied as permission', () => {
    const result = diagnoseError('bash: /etc/shadow: Permission denied')
    expect(result.type).toBe('permission')
    expect(result.hint).toBe('Check file permissions or run with elevated access')
  })

  it('classifies EACCES as permission', () => {
    const result = diagnoseError('Error: EACCES: permission denied, open "/root/file"')
    expect(result.type).toBe('permission')
  })

  it('classifies command not found as not_found', () => {
    const result = diagnoseError('bash: foobar: command not found')
    expect(result.type).toBe('not_found')
    expect(result.hint).toBe('Check the command/path exists and is spelled correctly')
  })

  it('classifies ENOENT as not_found', () => {
    const result = diagnoseError('Error: ENOENT: no such file or directory, open "/missing/path"')
    expect(result.type).toBe('not_found')
  })

  it('classifies TypeError as runtime', () => {
    const result = diagnoseError("TypeError: Cannot read properties of undefined (reading 'foo')")
    expect(result.type).toBe('runtime')
    expect(result.hint).toBe('Variable or function may be undefined or wrong type')
  })

  it('classifies ReferenceError as runtime', () => {
    const result = diagnoseError('ReferenceError: myVar is not defined')
    expect(result.type).toBe('runtime')
  })

  it('classifies AttributeError as runtime', () => {
    const result = diagnoseError("AttributeError: 'NoneType' object has no attribute 'foo'")
    expect(result.type).toBe('runtime')
  })

  it('classifies timeout patterns', () => {
    const result = diagnoseError('Error: Command timed out after 30000ms')
    expect(result.type).toBe('timeout')
    expect(result.hint).toContain('too long')
  })

  it('classifies SIGKILL as timeout', () => {
    const result = diagnoseError('Process killed: SIGKILL')
    expect(result.type).toBe('timeout')
  })

  it('classifies unknown errors', () => {
    const result = diagnoseError('Some random error message with no pattern')
    expect(result.type).toBe('unknown')
    expect(result.hint).toBe('Check the error output above')
  })

  it('includes original stderr in formatted output', () => {
    const stderr = 'SyntaxError: unexpected token at line 5'
    const result = diagnoseError(stderr)
    expect(result.formatted).toContain(stderr)
    expect(result.formatted).toContain('[ERROR: syntax]')
  })

  it('formats unknown with prefix and original message', () => {
    const stderr = 'some weird error'
    const result = diagnoseError(stderr)
    expect(result.formatted).toBe(`[ERROR: unknown] Check the error output above\n\n${stderr}`)
  })

  it('returns type, hint, and formatted fields', () => {
    const result = diagnoseError('TypeError: oops')
    expect(result).toHaveProperty('type')
    expect(result).toHaveProperty('hint')
    expect(result).toHaveProperty('formatted')
  })

  it('matches first pattern when multiple could match', () => {
    // syntax comes before runtime in PATTERNS — SyntaxError matches syntax first
    const result = diagnoseError('SyntaxError: unexpected token')
    expect(result.type).toBe('syntax')
  })
})
