import { describe, expect, it } from 'bun:test'
const SKIP_ENV = !process.env.CYNCO_INTEGRATION
import { grepFailure, grepTool } from '../../tools/impl/grep.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-grep-' + Date.now())

describe('Grep tool', () => {
  it('has correct metadata', () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.tier).toBe('auto')
  })

  it.skipIf(SKIP_ENV)('finds content matches', async () => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'a.ts'), 'function hello() {}\nfunction world() {}')
    writeFileSync(join(TMP, 'b.ts'), 'const x = 1')
    const result = await grepTool.execute({ pattern: 'function', path: TMP }, TMP)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
    expect(result.output).toContain('world')
    rmSync(TMP, { recursive: true, force: true })
  })
})

// Gilded I4d2b3g. Five Grep calls in a row returned the literal string
// "Grep error: " with nothing after it — ripgrep had exited without writing to
// stderr, and the tool reported the empty stderr verbatim. The run had no way
// to tell "your pattern is bad" from "ripgrep never ran", so it varied the
// pattern four times and then gave up on the tool.
describe('grepFailure (an error message that says nothing is not an error message)', () => {
  const ARGV = ['C:/rg.exe', '--no-heading', 'buy_shares', 'C:/proj/gilded']

  it('reports what ripgrep said, when ripgrep said anything', () => {
    expect(grepFailure(ARGV, 2, null, 'regex parse error\n')).toContain('regex parse error')
  })

  it('never returns a message that is empty after the prefix', () => {
    const out = grepFailure(ARGV, 2, null, '')
    expect(out.replace('Grep error:', '').trim().length).toBeGreaterThan(0)
  })

  it('reports the exit code when ripgrep said nothing', () => {
    expect(grepFailure(ARGV, 2, null, '')).toContain('2')
  })

  it('reports the signal, not "null", when ripgrep was killed', () => {
    const out = grepFailure(ARGV, null, 'SIGKILL', '')
    expect(out).toContain('SIGKILL')
    expect(out).not.toContain('null')
  })

  it('names the command it ran, so the fault can be reproduced by hand', () => {
    expect(grepFailure(ARGV, 2, null, '')).toContain('C:/proj/gilded')
  })

  it('says a silent failure is not the pattern, so the pattern is not rewritten', () => {
    expect(grepFailure(ARGV, 2, null, '')).toContain('not the pattern')
  })
})
