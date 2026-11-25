/**
 * setup/cyncoHome.ts: which CynCo home a test file runs with (F58). A CYNCO_HOME the suite did not make, the
 * launching shell's included (a scratch engine's home exported in the terminal), is never used: the suite would
 * write its sessions, databases and journals into it. Everything here happens under a folder of this file's own.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { suiteHome } from './cyncoHome.js'

const ROOT = mkdtempSync(join(tmpdir(), 'cynco-home-test-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('suiteHome', () => {
  it('no CYNCO_HOME: a new cynco-test-home-* in the temp folder', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const r = suiteHome(undefined, temp)
    expect(dirname(r.home)).toBe(temp)
    expect(basename(r.home)).toMatch(/^cynco-test-home-/)
    expect(existsSync(r.home)).toBe(true)
    expect(r.replaced).toBeNull()
  })

  it('a CYNCO_HOME inside the temp folder (this worker\'s own, made for an earlier file) is kept and nothing is made', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const own = mkdtempSync(join(temp, 'cynco-test-home-'))
    const r = suiteHome(own, temp)
    expect(r).toEqual({ home: own, replaced: null })
    expect(readdirSync(temp)).toEqual([basename(own)])
  })

  it('a CYNCO_HOME from outside the temp folder (the shell\'s) is replaced by a new one, and said', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const shells = join(ROOT, 'a-scratch-engine-home')
    const r = suiteHome(shells, temp)
    expect(dirname(r.home)).toBe(temp)
    expect(r.replaced).toBe(shells)
    expect(existsSync(shells), 'the inherited home is not made or touched').toBe(false)
  })

  it('the temp folder itself, or a sibling whose name starts with it, is not inside it', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    expect(suiteHome(temp, temp).replaced).toBe(temp)
    expect(suiteHome(`${temp}-x`, temp).replaced).toBe(`${temp}-x`)
    expect(suiteHome(join(temp, '..', 'elsewhere'), temp).replaced).toBe(join(temp, '..', 'elsewhere'))
  })

  it.skipIf(process.platform !== 'win32')('Windows: the same folder in another letter case is inside', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const own = mkdtempSync(join(temp, 'cynco-test-home-'))
    expect(suiteHome(own.toUpperCase(), temp)).toEqual({ home: own.toUpperCase(), replaced: null })
  })

  // B5-2 (wave 15c): on Windows path.relative between two drives returns the target itself ('D:\\elsewhere\\home'),
  // which does not start with '..': only the isAbsolute check keeps a home on another volume (the camera drive, a
  // share) out. Nothing is made or read on either drive: `make` is the seam, and no path here is touched.
  it.skipIf(process.platform !== 'win32')('Windows: a CYNCO_HOME on another drive is not inside (skipped elsewhere: no drive letters)', () => {
    expect(suiteHome('D:\\elsewhere\\home', 'C:\\t', () => 'C:\\t\\made')).toEqual({ home: 'C:\\t\\made', replaced: 'D:\\elsewhere\\home' })
  })
})

describe('this run', () => {
  it('the CynCo home this file runs with is inside its temp folder', () => {
    expect(dirname(process.env.CYNCO_HOME!)).toBe(tmpdir())
  })
})
