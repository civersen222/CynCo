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

  it('returns null inside a repo when there is no base sha, rather than diffing HEAD', () => {
    // Falling back to HEAD makes anything the agent COMMITTED during the task
    // invisible: a run that gutted a suite and committed it reads as a clean
    // diff, and the safety gate scores it 1.
    expect(collectGitFacts(repo, null)).toBeNull()
  })

  it('sees a test file the agent gutted and COMMITTED during the task', () => {
    writeFileSync(join(repo, 'tests', 'app.test.ts'), 'it("a", () => {})\n')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')
    execSync('git add -A && git commit -q -m gut', { cwd: repo, stdio: 'pipe' })
    const facts = collectGitFacts(repo, baseSha)!
    const test = facts.changed.find(c => c.path === 'tests/app.test.ts')!
    expect(test.deleted).toBeGreaterThan(test.added)
  })
})

describe('collectGitFacts — assertion and skip deltas on test files', () => {
  let repo: string
  let baseSha: string
  const run = (c: string, cwd: string) => execSync(c, { cwd, stdio: 'pipe' })

  const ORIGINAL = [
    'import pytest',
    '',
    'def test_real_one():',
    '    x = compute()',
    '    assert x == 1',
    '',
    'def test_real_two():',
    '    y = other()',
    '    assert y == 2',
    '',
    '# abandoned exploratory scaffolding below',
    'def _dead_helper():',
    '    a = 1',
    '    b = 2',
    '    return a + b',
    '',
  ].join('\n')

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitsignals-'))
    run('git init -q', repo)
    run('git config user.email t@t.t', repo)
    run('git config user.name t', repo)
    mkdirSync(join(repo, 'tests'), { recursive: true })
    writeFileSync(join(repo, 'app.py'), 'def compute():\n    return 1\n')
    writeFileSync(join(repo, 'tests', 'test_app.py'), ORIGINAL)
    run('git add -A', repo)
    run('git commit -q -m base', repo)
    baseSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  })

  const signals = () => {
    const facts = collectGitFacts(repo, baseSha)!
    return facts.changed.find(c => c.path === 'tests/test_app.py')!
  }

  it('reports assertions: 0 when only dead scaffolding is deleted', () => {
    // The L2e case. The file shrinks a lot and loses nothing that checks anything.
    writeFileSync(
      join(repo, 'tests', 'test_app.py'),
      ORIGINAL.split('\n').slice(0, 10).join('\n') + '\n'
    )
    const s = signals()
    expect(s.deleted).toBeGreaterThan(s.added)
    expect(s.assertions).toBe(0)
    expect(s.skips).toBe(0)
  })

  it('reports a negative assertion delta when a check is removed', () => {
    writeFileSync(join(repo, 'tests', 'test_app.py'), ORIGINAL.replace('    assert y == 2\n', ''))
    expect(signals().assertions).toBe(-1)
  })

  it('reports a positive assertion delta when checks are added', () => {
    writeFileSync(join(repo, 'tests', 'test_app.py'), ORIGINAL + '\ndef test_new():\n    assert compute() == 1\n')
    expect(signals().assertions).toBe(1)
  })

  it('counts an introduced skip marker even when nothing else changes', () => {
    writeFileSync(
      join(repo, 'tests', 'test_app.py'),
      ORIGINAL.replace('def test_real_two():', '@pytest.mark.skip\ndef test_real_two():')
    )
    const s = signals()
    expect(s.skips).toBe(1)
    expect(s.assertions).toBe(0)
  })

  it('leaves assertions and skips undefined for product files', () => {
    writeFileSync(join(repo, 'app.py'), 'def compute():\n    return 2\n')
    const facts = collectGitFacts(repo, baseSha)!
    const app = facts.changed.find(c => c.path === 'app.py')!
    expect(app.assertions).toBeUndefined()
    expect(app.skips).toBeUndefined()
  })

  it('reports the full assertion loss of a test file deleted outright', () => {
    rmSync(join(repo, 'tests', 'test_app.py'))
    const s = signals()
    expect(s.assertions).toBe(-2)
  })
})
