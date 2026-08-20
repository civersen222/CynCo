import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProjectFiles } from '../../index/indexer.js'

/**
 * 7115 of the 9765 chunks in the localcode index — 73% — were a vendored sklearn
 * corpus under `benchmark/swebench-workspace`, which `.gitignore` excludes and
 * git does not track. Semantic queries came back half sklearn: "wilson score
 * confidence interval" returned `stats.ts:wilsonInterval` and then three
 * sklearn test files. The index was mostly not the project.
 *
 * `walkFiles` knew about a hand-maintained IGNORE_DIRS list, which cannot keep
 * up with whatever a given repo vendors. Git already answers the question, so
 * ask git: `ls-files --cached --others --exclude-standard` is exactly "tracked,
 * plus untracked files that are not ignored".
 *
 * The old walk also gave up below depth 5, so deeply nested source was silently
 * absent from the index with no error anywhere.
 */
describe('listProjectFiles', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'lpf-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 't')

    writeFileSync(join(repo, '.gitignore'), 'vendored/\nbuild.py\n')
    writeFileSync(join(repo, 'app.py'), 'def main(): pass\n')
    mkdirSync(join(repo, 'vendored'), { recursive: true })
    writeFileSync(join(repo, 'vendored', 'huge.py'), 'def vendored(): pass\n')
    writeFileSync(join(repo, 'build.py'), 'def built(): pass\n')
    writeFileSync(join(repo, 'notes.md'), '# not source\n')
    mkdirSync(join(repo, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
    writeFileSync(join(repo, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.py'), 'def deep(): pass\n')

    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'fresh.py'), 'def fresh(): pass\n')
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  const norm = () => listProjectFiles(repo).map(p => p.replace(/\\/g, '/'))

  it('includes tracked source files', () => {
    expect(norm()).toContain('app.py')
  })

  it('includes untracked source files that are not ignored', () => {
    expect(norm()).toContain('fresh.py')
  })

  it('excludes what .gitignore excludes, without a hand-maintained dir list', () => {
    expect(norm()).not.toContain('vendored/huge.py')
    expect(norm()).not.toContain('build.py')
  })

  it('excludes non-source files', () => {
    expect(norm()).not.toContain('notes.md')
    expect(norm()).not.toContain('.gitignore')
  })

  it('reaches source nested deeper than the old depth-5 walk', () => {
    expect(norm()).toContain('a/b/c/d/e/f/deep.py')
  })

  it('falls back to a filesystem walk outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'lpf-plain-'))
    try {
      writeFileSync(join(plain, 'solo.py'), 'def solo(): pass\n')
      mkdirSync(join(plain, 'node_modules'), { recursive: true })
      writeFileSync(join(plain, 'node_modules', 'dep.js'), 'module.exports = 1\n')
      const files = listProjectFiles(plain).map(p => p.replace(/\\/g, '/'))
      expect(files).toContain('solo.py')
      expect(files).not.toContain('node_modules/dep.js')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
