import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorktreeManager } from '../../bestOfN/worktreeManager.js'

// Track temp repos created across tests for guaranteed cleanup
const tempRepos: string[] = []

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-wt-repo-'))
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

let repoDir: string
let manager: WorktreeManager

beforeEach(() => {
  repoDir = makeGitRepo()
  manager = new WorktreeManager(repoDir)
})

afterEach(() => {
  manager.cleanupAll()
  for (const dir of tempRepos.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

describe('WorktreeManager', () => {
  it('creates a worktree and returns a valid path containing repo files', async () => {
    const wtPath = await manager.create()

    expect(typeof wtPath).toBe('string')
    expect(wtPath.length).toBeGreaterThan(0)

    // The worktree should contain the file committed in HEAD
    expect(existsSync(join(wtPath, 'hello.txt'))).toBe(true)
  })

  it('creates multiple worktrees at different paths', async () => {
    const wt1 = await manager.create()
    const wt2 = await manager.create()

    expect(wt1).not.toBe(wt2)
    expect(existsSync(join(wt1, 'hello.txt'))).toBe(true)
    expect(existsSync(join(wt2, 'hello.txt'))).toBe(true)
    expect(manager.getActive()).toHaveLength(2)
  })

  it('cleanupAll removes all worktrees', async () => {
    const wt1 = await manager.create()
    const wt2 = await manager.create()

    manager.cleanupAll()

    expect(manager.getActive()).toHaveLength(0)

    // Verify git itself no longer lists the worktrees
    const list = execSync('git worktree list', { cwd: repoDir, stdio: 'pipe' })
      .toString()
    // Only the main worktree (repoDir) should remain; the temp ones should be gone
    expect(list).not.toContain('cynco-bestofn-')
  })
})
