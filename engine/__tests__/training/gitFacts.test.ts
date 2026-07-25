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

  it('returns null outside a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'notgit-'))
    expect(collectGitFacts(notRepo, null)).toBeNull()
  })

  it('returns null when the base sha is unknown', () => {
    expect(collectGitFacts(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })
})
