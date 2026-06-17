import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRepo, checkoutRef, applyPatch } from './isolate.js'

let srcRepo: string
let firstSha: string

beforeAll(() => {
  // Build a tiny throwaway git repo with two commits.
  srcRepo = mkdtempSync(join(tmpdir(), 'truebench-src-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(srcRepo, 'a.txt'), 'one')
  git('add', '.'); git('commit', '-q', '-m', 'first')
  firstSha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  writeFileSync(join(srcRepo, 'a.txt'), 'two')
  git('add', '.'); git('commit', '-q', '-m', 'second')
})

afterAll(() => { rmSync(srcRepo, { recursive: true, force: true }) })

describe('isolate', () => {
  it('clones into a fresh dir with the working tree present', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    expect(existsSync(join(dest, 'a.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('two')
    rmSync(dest, { recursive: true, force: true })
  })

  it('checks out an earlier ref', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    checkoutRef(dest, firstSha)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('one')
    rmSync(dest, { recursive: true, force: true })
  })

  it('applies a patch to the working tree', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    const patch = mkdtempSync(join(tmpdir(), 'truebench-patch-'))
    const patchFile = join(patch, 'p.patch')
    // patch that changes a.txt from "two" to "three"
    writeFileSync(
      patchFile,
      ['diff --git a/a.txt b/a.txt',
       'index 0000000..0000000 100644',
       '--- a/a.txt',
       '+++ b/a.txt',
       '@@ -1 +1 @@',
       '-two',
       '\\ No newline at end of file',
       '+three',
       '\\ No newline at end of file',
       ''].join('\n'),
    )
    applyPatch(dest, patchFile)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('three')
    rmSync(dest, { recursive: true, force: true })
    rmSync(patch, { recursive: true, force: true })
  })
})
