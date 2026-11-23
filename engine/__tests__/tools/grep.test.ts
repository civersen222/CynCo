import { describe, expect, it } from 'bun:test'
import { grepArgv, grepFailure, grepTool } from '../../tools/impl/grep.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-grep-' + Date.now())

describe('Grep tool', () => {
  it('has correct metadata', () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.tier).toBe('auto')
  })

  it('finds content matches', async () => {
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

// F242: the pattern and the glob are the model's. As a bare positional, a pattern such as
// `--pre=<program>` made ripgrep run that program on every file it searched, outside the
// containment, at the engine's integrity and with the real home.
describe('grepArgv (the model\'s pattern is never an option)', () => {
  it('passes the pattern after -e and the folder after --', () => {
    const argv = grepArgv('rg', '--pre=C:/m/evil.cmd', 'C:/m')
    const e = argv.indexOf('-e')
    expect(e).toBeGreaterThan(0)
    expect(argv[e + 1]).toBe('--pre=C:/m/evil.cmd')
    expect(argv.slice(e + 2)).toEqual(['--', 'C:/m'])
    expect(argv.filter(a => a.startsWith('--pre'))).toEqual(['--pre=C:/m/evil.cmd'])
  })

  it('joins the glob to its option', () => {
    const argv = grepArgv('rg', 'x', 'C:/m', '--pre=evil', 2)
    expect(argv).toContain('--glob=--pre=evil')
    expect(argv).not.toContain('--pre=evil')
    expect(argv.slice(argv.indexOf('-C'), argv.indexOf('-C') + 2)).toEqual(['-C', '2'])
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
