/**
 * F162: `extractPatch` used to `.trim()` the diff, which strips the final
 * newline `git apply` needs after the last hunk line ("corrupt patch at line
 * N"). Every best-of-N winner whose diff ended in a normal hunk line was
 * rejected by `applyPatch` and the engine fell back to single-pass every time.
 * The one shape that survived was a file with no trailing newline (the diff
 * then ends in "\ No newline at end of file", and trimming only removed the
 * newline after the marker). Both shapes must round-trip through `git apply`.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractPatch } from '../../bestOfN/patchExtractor.js'

const tempRepos: string[] = []

afterEach(() => {
  for (const dir of tempRepos.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-patch-applies-'))
  tempRepos.push(dir)
  const git = (args: string) => execSync(`git -c user.name=t -c user.email=t@t -c core.autocrlf=false ${args}`, { cwd: dir, stdio: 'pipe' })
  git('init -q')
  // Repo-local, so extractPatch's own git calls and the checkout below see it
  // too (a global autocrlf=true would rewrite the file on checkout).
  git('config core.autocrlf false')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git('add a.txt')
  git('commit -q -m base')
  return dir
}

function roundTrip(repo: string): string {
  const patch = extractPatch(repo)
  expect(patch.length).toBeGreaterThan(0)
  const patchFile = join(repo, '..', `${repo.split(/[\\/]/).pop()}.diff`)
  tempRepos.push(patchFile)
  writeFileSync(patchFile, patch)
  execSync('git checkout -- .', { cwd: repo, stdio: 'pipe' })
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
  // Throws (non-zero exit) when git rejects the patch.
  execSync(`git -c core.autocrlf=false apply "${patchFile}"`, { cwd: repo, stdio: 'pipe' })
  return readFileSync(join(repo, 'a.txt'), 'utf8')
}

describe('F162: extractPatch output applies with git apply', () => {
  it('an appended line WITHOUT a trailing newline round-trips', () => {
    const repo = makeRepo()
    appendFileSync(join(repo, 'a.txt'), 'three')
    expect(roundTrip(repo)).toBe('one\ntwo\nthree')
  })

  it('a normal edit WITH a trailing newline round-trips (the case .trim() broke)', () => {
    const repo = makeRepo()
    appendFileSync(join(repo, 'a.txt'), 'three\n')
    expect(roundTrip(repo)).toBe('one\ntwo\nthree\n')
  })

  it('the diff ends with the newline after its last hunk line', () => {
    const repo = makeRepo()
    appendFileSync(join(repo, 'a.txt'), 'three\n')
    expect(extractPatch(repo).endsWith('+three\n')).toBe(true)
  })
})
