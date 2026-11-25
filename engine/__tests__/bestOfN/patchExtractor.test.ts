import { describe, it, expect, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, symlinkSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractPatch } from '../../bestOfN/patchExtractor.js'

const tempRepos: string[] = []

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-patch-repo-'))
  tempRepos.push(dir)

  const run = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: 'pipe' })

  run('git init')
  run('git config user.email "test@test.com"')
  run('git config user.name "Test"')
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n')
  run('git add hello.txt')
  run('git commit -m "init"')

  return dir
}

afterEach(() => {
  for (const dir of tempRepos.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

// NOW.md, containment backlog: `git add -A` stages what a junction leads to as if it were a folder of
// the candidate's (F6), so a candidate's link put files from anywhere into the patch the loop applies to
// the mission folder. A candidate that made a link is not applied: no patch, and a line that says why.
describe('extractPatch: a candidate that made a link is not applied', () => {
  const outside: string[] = []
  afterEach(() => {
    for (const d of outside.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('a junction to a folder outside the worktree gives no patch, and nothing is staged', () => {
    const repo = makeGitRepo()
    const victim = mkdtempSync(join(tmpdir(), 'cynco-patch-outside-'))
    outside.push(victim)
    writeFileSync(join(victim, 'secret.txt'), 'not the candidate\'s\n')
    writeFileSync(join(repo, 'hello.txt'), 'hello world\nchanged\n')
    mkdirSync(join(repo, 'sub'))
    symlinkSync(victim, join(repo, 'sub', 'lead-out'), 'junction')
    const said: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')) }
    let patch: string
    try {
      patch = extractPatch(repo)
    } finally {
      console.log = log
    }
    expect(patch).toBe('')
    expect(said.some(l => l.startsWith('[bestOfN] candidate ') && l.includes('made a link') && l.includes('lead-out') && l.includes('it is not applied')), said.join('\n')).toBe(true)
    // Nothing was staged, so the worktree is as the candidate left it.
    expect(execSync('git diff --cached --name-only', { cwd: repo, stdio: 'pipe' }).toString().trim()).toBe('')
    // The junction is removed by the test itself as an entry, never entered.
    rmdirSync(join(repo, 'sub', 'lead-out'))
    expect(existsSync(join(victim, 'secret.txt'))).toBe(true)
  })

  // Wave 15b, check C4-2: only what git would stage is judged. An install makes junctions under the
  // ignored node_modules; `git add -A` never enters an ignored folder or stages an ignored name, so such
  // a link cannot put anything into the patch, and the honest candidate is applied.
  function junctionOut(repo: string, rel: string): string {
    const victim = mkdtempSync(join(tmpdir(), 'cynco-patch-outside-'))
    outside.push(victim)
    writeFileSync(join(victim, 'secret.txt'), 'not the candidate\'s\n')
    symlinkSync(victim, join(repo, rel), 'junction')
    return victim
  }
  function commitIgnore(repo: string, text: string): void {
    writeFileSync(join(repo, '.gitignore'), text)
    execSync('git add .gitignore', { cwd: repo, stdio: 'pipe' })
    execSync('git commit -m ignore', { cwd: repo, stdio: 'pipe' })
  }

  it('a link under a folder git ignores is not staged, so the candidate still gives its patch', () => {
    const repo = makeGitRepo()
    commitIgnore(repo, 'node_modules/\n')
    mkdirSync(join(repo, 'node_modules'))
    junctionOut(repo, join('node_modules', 'pkg'))
    writeFileSync(join(repo, 'hello.txt'), 'hello world\nchanged\n')
    const patch = extractPatch(repo)
    rmdirSync(join(repo, 'node_modules', 'pkg'))
    expect(patch).toContain('+changed')
    expect(patch).not.toContain('secret.txt')
    expect(patch).not.toContain('node_modules')
  })

  it('a link whose own name git ignores is not staged either', () => {
    const repo = makeGitRepo()
    commitIgnore(repo, 'cache-link\n')
    junctionOut(repo, 'cache-link')
    writeFileSync(join(repo, 'hello.txt'), 'hello world\nchanged\n')
    const patch = extractPatch(repo)
    rmdirSync(join(repo, 'cache-link'))
    expect(patch).toContain('+changed')
    expect(patch).not.toContain('secret.txt')
  })

  it('a link git would stage is still refused when an ignore file covers other folders', () => {
    const repo = makeGitRepo()
    commitIgnore(repo, 'node_modules/\n')
    mkdirSync(join(repo, 'vendor'))
    junctionOut(repo, join('vendor', 'lead-out'))
    writeFileSync(join(repo, 'hello.txt'), 'hello world\nchanged\n')
    const patch = extractPatch(repo)
    rmdirSync(join(repo, 'vendor', 'lead-out'))
    expect(patch).toBe('')
  })

  it('a candidate with no link still gives its patch', () => {
    const repo = makeGitRepo()
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'new.txt'), 'new\n')
    expect(extractPatch(repo)).toContain('sub/new.txt')
  })
})

describe('extractPatch', () => {
  it('returns a diff containing the filename and changed lines for a modified file', () => {
    const repo = makeGitRepo()

    // Modify the tracked file
    writeFileSync(join(repo, 'hello.txt'), 'hello world\ngoodbye world\n')

    const patch = extractPatch(repo)

    expect(patch.length).toBeGreaterThan(0)
    expect(patch).toContain('hello.txt')
    // The diff should contain a '+' line for the new content
    expect(patch).toContain('+goodbye world')
  })

  it('returns a diff containing a newly added untracked file', () => {
    const repo = makeGitRepo()

    // Add a brand-new, previously untracked file
    writeFileSync(join(repo, 'newfile.ts'), 'export const answer = 42\n')

    const patch = extractPatch(repo)

    expect(patch.length).toBeGreaterThan(0)
    expect(patch).toContain('newfile.ts')
    expect(patch).toContain('+export const answer = 42')
  })

  it('returns an empty string when there are no changes', () => {
    const repo = makeGitRepo()

    // No modifications made — clean working tree
    const patch = extractPatch(repo)

    expect(patch).toBe('')
  })

  it('leaves the worktree unstaged after extraction', () => {
    const repo = makeGitRepo()
    writeFileSync(join(repo, 'hello.txt'), 'changed\n')

    extractPatch(repo)

    // After extraction the index should be clean (nothing staged)
    const staged = execSync('git diff --cached --name-only', {
      cwd: repo,
      stdio: 'pipe',
    })
      .toString()
      .trim()

    expect(staged).toBe('')
  })
})
