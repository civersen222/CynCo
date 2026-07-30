import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { formatToolError, summarizeToolInput } from '../../bridge/toolErrorLog.js'
import { SECRET_MARKER } from '../../training/messageSnapshot.js'

/**
 * Failure log F15. The loop's only record of a tool failure was
 * `[loop] Tool result: Bash isError=true`. The circuit breaker counts three of
 * those and overrides the result — a decision made from a signal the log did
 * not preserve. Reconstructing a trip after the run meant reconstructing it from
 * nothing.
 */
describe('tool error log', () => {
  it('names the command that failed, not just the tool', () => {
    const line = formatToolError(
      'Bash', { command: 'python -m pytest gilded/tests -q' },
      'ModuleNotFoundError: No module named gilded', 'counted')
    expect(line).toContain('Bash')
    expect(line).toContain('python -m pytest gilded/tests -q')
    expect(line).toContain('ModuleNotFoundError')
  })

  it('records the classification, because two of the three are not counted', () => {
    // A red suite and a verification check answering "no" are deliberately not
    // failures (findings from the log). Without the class in the line, a reader
    // cannot tell which errors moved the breaker's counter.
    expect(formatToolError('Bash', {}, 'x', 'counted')).toContain('class=counted')
    expect(formatToolError('Bash', {}, 'x', 'benign:test-failure'))
      .toContain('class=benign:test-failure')
    expect(formatToolError('Bash', {}, 'x', 'benign:verification-check'))
      .toContain('class=benign:verification-check')
  })

  it('redacts a secret in the payload and in the command', () => {
    const secret = 'sk-' + 'A1b2C3d4'.repeat(8)
    const line = formatToolError(
      'Bash', { command: `curl -H "Authorization: Bearer ${secret}" x` },
      `auth failed for ${secret}`, 'counted')
    expect(line).not.toContain(secret)
    expect(line).toContain(SECRET_MARKER)
  })

  /**
   * The order — redact, THEN cap — is load-bearing, and getting it backwards
   * still passes a naive test because SECRET_VALUE's `sk-` floor is 8 characters
   * and a head-truncated key usually keeps more than 8. It leaks only when the
   * cut lands inside those 8, so the arithmetic has to be built deliberately:
   *
   *   prefix 'auth failed for ' is 16 chars; cap 26 keeps 10 more, which is
   *   'sk-' plus SEVEN key characters — one short of the floor.
   *
   * Cap-then-redact leaves `sk-A1b2C3d` verbatim in the log. Redact-then-cap
   * has already replaced the whole span, so the cut falls inside the marker.
   */
  it('redacts BEFORE capping, so a cut inside the length floor leaks nothing', () => {
    const secret = 'sk-' + 'A1b2C3d4'.repeat(8)
    const line = formatToolError('Bash', {}, `auth failed for ${secret}`, 'counted', 26)
    expect(line).not.toContain('sk-')
    expect(line).toContain('[redacted')
  })

  it('redacts the command before capping it too', () => {
    // summarizeToolInput has its own cap, and its own chance to get this wrong.
    const secret = 'sk-' + 'A1b2C3d4'.repeat(8)
    expect(summarizeToolInput({ command: `curl -u ${secret}` }, 15)).not.toContain('sk-')
  })

  it('caps the payload and says how much it dropped', () => {
    const line = formatToolError('Bash', { command: 'x' }, 'E'.repeat(5000), 'counted', 300)
    expect(line.length).toBeLessThan(600)
    expect(line).toMatch(/…\[\+4700 bytes\]/)
  })

  it('collapses newlines so one failure is one log line', () => {
    const line = formatToolError('Bash', { command: 'a\nb' }, 'line1\nline2\nline3', 'counted')
    expect(line).not.toContain('\n')
    expect(line).toContain('line1 line2 line3')
  })

  it('leaves a trace for a tool whose schema it does not know', () => {
    expect(summarizeToolInput({ weirdKey: 1, other: 2 })).toBe('argKeys=weirdKey,other')
    expect(summarizeToolInput(undefined)).toBe('args=none')
    expect(summarizeToolInput({})).toBe('args=none')
  })

  it('prefers the identifying argument over the rest of the schema', () => {
    expect(summarizeToolInput({ file_path: '/a/b.ts', old_string: 'huge' }))
      .toBe('file_path=/a/b.ts')
  })

  /**
   * Wire-check. The formatter having its own green tests is the
   * two-well-tested-halves failure if the loop never calls it — the exact shape
   * of findings (ag) and (aq). Assert the call site, and assert it sits where
   * the classification is already known: logging before `benignTestFailure` is
   * computed would force `class=counted` for every error and misreport a red
   * test suite as a fault.
   */
  it('the loop calls it for every error, after classifying', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', '..', 'bridge', 'conversationLoop.ts'), 'utf-8')
    expect(src).toContain("import { formatToolError } from './toolErrorLog.js'")
    const callAt = src.indexOf('formatToolError(')
    const classifiedAt = src.indexOf('const countsAsFailure =')
    expect(callAt, 'the loop never calls formatToolError').toBeGreaterThan(0)
    expect(classifiedAt).toBeGreaterThan(0)
    expect(callAt, 'formatToolError is called before the failure is classified')
      .toBeGreaterThan(classifiedAt)
    // Guarded by isError, not by countsAsFailure — a benign classification is
    // itself worth logging, since it is the reason the counter did not move.
    expect(src).toMatch(/if \(result\.isError\) \{\s*console\.log\(formatToolError\(/)
  })
})
