import { describe, it, expect, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectGitFacts, isTestPath, collectUntrackedPaths, repoToplevel, canonicalPath } from '../../training/gitFacts.js'

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

  /**
   * The assertion delta answers "did checks go away", and that is not the
   * question. It came out negative on both L2e and L2f, and both times the
   * deleted half was a copy-pasted duplicate of the half that stayed — coverage
   * was identical before and after. `casesLost` asks the question that actually
   * separates them: how many NAMED cases can no longer fail.
   */
  describe('casesLost — what can no longer fail', () => {
    it('is 0 when dead scaffolding is deleted and every case survives', () => {
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.split('\n').slice(0, 10).join('\n') + '\n'
      )
      const s = signals()
      expect(s.deleted).toBeGreaterThan(s.added)
      expect(s.casesLost).toBe(0)
    })

    it('is 0 when a case loses one of two checks and keeps the other (the L2f shape)', () => {
      // A copy-pasted duplicate check is collapsed. The assertion delta goes
      // negative; the case can still fail. This is the exact pair of readings
      // that made L2f a -1.0 — assertions -3, cases 19 -> 19.
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        'def test_pair():\n    assert a == 1\n    assert b == 2\n'
      )
      run('git add -A', repo)
      run('git commit -q -m two-checks', repo)
      const sha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()

      writeFileSync(join(repo, 'tests', 'test_app.py'), 'def test_pair():\n    assert a == 1\n')
      const s = collectGitFacts(repo, sha)!.changed.find(c => c.path === 'tests/test_app.py')!
      expect(s.assertions).toBe(-1)
      expect(s.casesLost).toBe(0)
    })

    it('is 1 when a case is deleted outright', () => {
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.replace('def test_real_two():\n    y = other()\n    assert y == 2\n', '')
      )
      expect(signals().casesLost).toBe(1)
    })

    it('is 1 when a case survives by name but nothing in it checks anything', () => {
      // The evasion a line count and an assertion count both miss on their own:
      // the case is still collected, still green, and can never fail again.
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.replace('    assert y == 2', '    pass')
      )
      expect(signals().casesLost).toBe(1)
    })

    it('is 0 when a case is only renamed', () => {
      // A rename makes the old name vanish without losing an ounce of coverage.
      // Vetoing it would be the same false negative in a new costume.
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.replace('def test_real_two():', 'def test_real_two_renamed():')
      )
      const s = signals()
      expect(s.casesLost).toBe(0)
      expect(s.assertions).toBe(0)
    })

    it('counts every case when the file is deleted outright', () => {
      rmSync(join(repo, 'tests', 'test_app.py'))
      expect(signals().casesLost).toBe(2)
    })

    it('is left undefined for product files', () => {
      writeFileSync(join(repo, 'app.py'), 'def compute():\n    return 2\n')
      const facts = collectGitFacts(repo, baseSha)!
      expect(facts.changed.find(c => c.path === 'app.py')!.casesLost).toBeUndefined()
    })

    it('is 0 for a test file the task created, which lost nothing', () => {
      writeFileSync(join(repo, 'tests', 'test_new.py'), 'def test_fresh():\n    assert 1 == 1\n')
      const facts = collectGitFacts(repo, baseSha)!
      const fresh = facts.changed.find(c => c.path === 'tests/test_new.py')
      // Untracked, so it is not in the numstat diff at all — nothing to report.
      expect(fresh).toBeUndefined()
    })
  })

  /**
   * `casesLost` already computed the cases that APPEARED, in order to net them
   * against the ones that went so a rename would not read as a loss — and then
   * threw the number away. It is the measurement `assessTestsPass` needs to tell
   * "this task wrote a test" from "this task edited a line in a test file", and
   * finding (q) is what happens without it.
   */
  describe('casesAdded — coverage that was not there before', () => {
    it('is 0 when an existing assertion is rewritten in place', () => {
      // The finding (q) shape: a product change forces a one-line update to the
      // assertion that pins it. Lines change; no case is added.
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.replace('assert y == 2', 'assert y == 3')
      )
      const s = signals()
      expect(s.added).toBe(1)
      expect(s.casesAdded).toBe(0)
    })

    it('counts a case that did not exist before', () => {
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL + 'def test_brand_new():\n    assert z == 3\n'
      )
      expect(signals().casesAdded).toBe(1)
    })

    it('is 0 when a case is only renamed', () => {
      // Symmetric with casesLost: a rename adds no coverage and loses none.
      writeFileSync(
        join(repo, 'tests', 'test_app.py'),
        ORIGINAL.replace('def test_real_two():', 'def test_real_two_renamed():')
      )
      const s = signals()
      expect(s.casesAdded).toBe(0)
      expect(s.casesLost).toBe(0)
    })

    it('counts every case in a test file the task created and committed', () => {
      // The ordinary TDD run. The before-version cannot be read because the file
      // did not exist, and reporting "unmeasurable" there would deny credit to
      // the most legitimate way there is to add coverage.
      writeFileSync(
        join(repo, 'tests', 'test_added.py'),
        'def test_one():\n    assert a == 1\n\n\ndef test_two():\n    assert b == 2\n'
      )
      run('git add -A', repo)
      run('git commit -q -m adds-tests', repo)
      const fresh = collectGitFacts(repo, baseSha)!.changed
        .find(c => c.path === 'tests/test_added.py')!
      expect(fresh.casesAdded).toBe(2)
      expect(fresh.casesLost).toBe(0)
    })

    it('is left undefined for product files', () => {
      writeFileSync(join(repo, 'app.py'), 'def compute():\n    return 2\n')
      const facts = collectGitFacts(repo, baseSha)!
      expect(facts.changed.find(c => c.path === 'app.py')!.casesAdded).toBeUndefined()
    })
  })
})

describe('untracked paths a task created', () => {
  let repo: string
  const run = (c: string, cwd: string) => execSync(c, { cwd, stdio: 'pipe' })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gituntracked-'))
    run('git init -q', repo)
    run('git config user.email t@t.t', repo)
    run('git config user.name t', repo)
    mkdirSync(join(repo, 'tests'), { recursive: true })
    writeFileSync(join(repo, 'app.py'), 'def a():\n    return 1\n')
    run('git add -A', repo)
    run('git commit -q -m base', repo)
  })

  it('reports only paths git has never seen, not modified tracked ones', () => {
    writeFileSync(join(repo, 'app.py'), 'def a():\n    return 2\n')
    writeFileSync(join(repo, 'tests', 'test_new.py'), 'def test_x():\n    assert True\n')
    const untracked = collectUntrackedPaths(repo)!
    expect(untracked).toEqual(['tests/test_new.py'])
    expect(untracked).not.toContain('app.py')
  })

  // The exact shape of Gilded L4.6b. The agent asked `git diff --name-only`
  // what it had changed, staged that answer, and committed — leaving the file
  // it had CREATED untracked, because a new file cannot appear in a diff.
  it('catches the file a commit left behind because diff --name-only cannot name it', () => {
    writeFileSync(join(repo, 'app.py'), 'def a():\n    return 2\n')
    writeFileSync(join(repo, 'tests', 'test_new.py'), 'def test_x():\n    assert True\n')

    const staged = execSync('git diff --name-only', { cwd: repo }).toString().trim().split('\n')
    expect(staged).toEqual(['app.py'])          // the blind spot itself
    run(`git add ${staged.join(' ')}`, repo)
    run('git commit -q -m partial', repo)

    // What the file tracker knows: both paths were written by this task.
    const tracked = ['app.py', 'tests/test_new.py']
    const top = repoToplevel(repo)!
    const wrote = new Set(tracked.map(p => canonicalPath(p, repo)))
    const orphans = collectUntrackedPaths(repo)!.filter(p => wrote.has(canonicalPath(p, top)))

    expect(orphans).toEqual(['tests/test_new.py'])
  })

  it('stays silent about untracked files the task did not write', () => {
    writeFileSync(join(repo, 'scratch.log'), 'noise\n')
    const top = repoToplevel(repo)!
    const wrote = new Set(['app.py'].map(p => canonicalPath(p, repo)))
    const orphans = collectUntrackedPaths(repo)!.filter(p => wrote.has(canonicalPath(p, top)))
    expect(orphans).toEqual([])
  })

  it('matches a tracker path spelled absolutely against git\'s repo-relative one', () => {
    writeFileSync(join(repo, 'tests', 'test_new.py'), 'def test_x():\n    assert True\n')
    const top = repoToplevel(repo)!
    const wrote = new Set([join(repo, 'tests', 'test_new.py')].map(p => canonicalPath(p, repo)))
    const orphans = collectUntrackedPaths(repo)!.filter(p => wrote.has(canonicalPath(p, top)))
    expect(orphans).toEqual(['tests/test_new.py'])
  })

  it('returns null when git cannot answer, never an empty list', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'nogit-'))
    expect(collectUntrackedPaths(notARepo)).toBeNull()
    expect(repoToplevel(notARepo)).toBeNull()
    rmSync(notARepo, { recursive: true, force: true })
  })
})
