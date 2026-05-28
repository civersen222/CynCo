import { describe, it, expect, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
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
