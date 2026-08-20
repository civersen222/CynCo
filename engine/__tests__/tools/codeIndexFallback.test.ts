import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { regexFallback } from '../../tools/impl/codeIndex.js'

/**
 * The fallback used to build a shell command line by interpolating the model's
 * query into a quoted string:
 *
 *   `rg ... -e "${query}" ...`
 *   `powershell -Command "... Select-String -Pattern '${query}' ..."`
 *
 * and hand it to `exec`, which runs it through a shell. A query containing a
 * matching quote closes the string and everything after it is a command. The
 * query is model-authored text, and the model is the least trusted input in the
 * system, so this was arbitrary command execution one search away.
 *
 * The fix is structural — argv instead of a command line — so these tests pin
 * the behaviour that proves it: a query full of shell metacharacters is treated
 * as a search term, and searching still works when it contains quotes.
 */
describe('regexFallback', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeindex-'))
    writeFileSync(join(dir, 'sample.py'), 'def greet():\n    return "hello world"\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a match whose text contains quotes', async () => {
    const out = await regexFallback('"hello world"', dir)
    expect(out).toContain('hello world')
  })

  it('does not execute a query that tries to break out of the command', async () => {
    for (const attack of [
      'x"; echo PWNED; "',
      "x'; echo PWNED; '",
      'x`echo PWNED`',
      'x$(echo PWNED)',
      'x | echo PWNED',
      'x; echo PWNED',
      'x && echo PWNED',
    ]) {
      const out = await regexFallback(attack, dir)
      expect(out).not.toContain('PWNED')
    }
  }, 60000)

  it('returns empty rather than throwing when nothing matches', async () => {
    const out = await regexFallback('zzz_no_such_symbol_zzz', dir)
    expect(out).toBe('')
  })
})
