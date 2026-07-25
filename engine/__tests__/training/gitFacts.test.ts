import { describe, it, expect, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectGitFacts, isTestPath } from '../../training/gitFacts.js'

describe('isTestPath', () => {
  it('recognizes common test layouts', () => {
    expect(isTestPath('engine/__tests__/foo.test.ts')).toBe(true)
    expect(isTestPath('src/foo.spec.tsx')).toBe(true)
    expect(isTestPath('gilded/tests/test_realm.py')).toBe(true)
    expect(isTestPath('pkg/thing_test.go')).toBe(true)
    expect(isTestPath('test/helper.rb')).toBe(true)
  })

  it('does not flag product code', () => {
    expect(isTestPath('engine/bridge/conversationLoop.ts')).toBe(false)
    expect(isTestPath('gilded/society/characters.py')).toBe(false)
    expect(isTestPath('src/latest.ts')).toBe(false)
  })
})

describe('collectGitFacts', () => {
  let repo: string
  let baseSha: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfacts-'))
    const run = (c: string) => execSync(c, { cwd: repo, stdio: 'pipe' })
    run('git init -q')
    run('git config user.email t@t.t')
    run('git config user.name t')
    mkdirSync(join(repo, 'tests'), { recursive: true })
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(repo, 'tests', 'app.test.ts'), 'it("a", () => {})\nit("b", () => {})\nit("c", () => {})\n')
    run('git add -A')
    run('git commit -q -m base')
    baseSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  })

  it('reports added and deleted line counts per changed file', () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 2\n')
    const facts = collectGitFacts(repo, baseSha)!
    const app = facts.changed.find(c => c.path === 'app.ts')!
    expect(app.added).toBe(1)
    expect(app.deleted).toBe(0)
  })

  it('reports outright deletions', () => {
    rmSync(join(repo, 'tests', 'app.test.ts'))
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.removed).toContain('tests/app.test.ts')
  })

  it('reports dirty working-tree paths', () => {
    writeFileSync(join(repo, 'scratch.txt'), 'junk\n')
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.dirty).toContain('scratch.txt')
  })

  it('flags binary files instead of claiming zero lines changed', () => {
    writeFileSync(join(repo, 'fixture.bin'), Buffer.from([0, 1, 2, 0, 255]))
    execSync('git add -A && git commit -q -m bin', { cwd: repo, stdio: 'pipe' })
    writeFileSync(join(repo, 'fixture.bin'), Buffer.from([0, 9, 9, 9, 0, 7]))
    const facts = collectGitFacts(repo, baseSha)!
    const bin = facts.changed.find(c => c.path === 'fixture.bin')!
    expect(bin.binary).toBe(true)
  })

  it('reports the destination path of a rename, not the raw arrow line', () => {
    execSync('git mv app.ts renamed.ts', { cwd: repo, stdio: 'pipe' })
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.dirty).toContain('renamed.ts')
    expect(facts.dirty.some(p => p.includes('->'))).toBe(false)
  })

  it('unquotes paths that git C-quotes', () => {
    writeFileSync(join(repo, 'a file with spaces.txt'), 'x\n')
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.dirty).toContain('a file with spaces.txt')
  })

  it('decodes octal-escaped non-ASCII paths back to UTF-8', () => {
    writeFileSync(join(repo, 'café.txt'), 'x\n')
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.dirty).toContain('café.txt')
  })

  it('returns null outside a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'notgit-'))
    expect(collectGitFacts(notRepo, null)).toBeNull()
  })

  it('returns null when the base sha is unknown', () => {
    expect(collectGitFacts(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })
})
