import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { WorktreeManager, isStaleBestOfNWorktree, parseWorktreeList } from '../../bestOfN/worktreeManager.js'

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
    expect(existsSync(wt1)).toBe(false)
    expect(existsSync(wt2)).toBe(false)
  })

  it('fallback path (review M2): git worktree remove fails, unlock + prune still drop the locked entry', async () => {
    const wt = await manager.create()
    // Replace the tree with an empty directory: `git worktree remove` refuses
    // (validation fails — no `.git` in it). The fallback's rmSync then deletes
    // the directory, and because the entry is LOCKED a plain prune alone would
    // keep it — only the unlock step lets prune drop it.
    rmSync(wt, { recursive: true, force: true })
    mkdirSync(wt)
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try { manager.cleanup(wt) } finally { console.log = orig }
    expect(lines.some(l => l.includes('git worktree remove failed'))).toBe(true)
    expect(manager.registered().map(r => basename(r.path))).not.toContain(basename(wt))
    expect(manager.getActive()).not.toContain(wt)
  })

  it('construction never throws: outside a repo the stale scan is logged and skipped (review M5)', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'cynco-wt-norepo-'))
    tempRepos.push(notRepo)
    expect(() => new WorktreeManager(notRepo)).not.toThrow()
  })

  it('creates each worktree locked with this process pid', async () => {
    const wt = await manager.create()
    const mine = manager.registered().find(r => basename(r.path) === basename(wt))
    expect(mine?.locked).toBe(`cynco-bestofn pid=${process.pid}`)
  })
})

describe('F162: construction prunes stale cynco-bestofn-* worktrees', () => {
  const plant = (name: string, lockReason?: string): string => {
    const p = join(tmpdir(), `${name}${Math.random().toString(36).slice(2, 8)}`)
    const lock = lockReason ? `--lock --reason "${lockReason}" ` : ''
    execSync(`git worktree add --detach ${lock}"${p}"`, { cwd: repoDir, stdio: 'pipe' })
    tempRepos.push(p)
    return p
  }
  const names = () => new WorktreeManager(repoDir, { isAlive: () => false }).registered().map(r => basename(r.path))

  it('an unlocked cynco-bestofn-* worktree (the pre-lock leak) is removed from git and disk', () => {
    const stale = plant('cynco-bestofn-')
    expect(names()).not.toContain(basename(stale))
    expect(existsSync(stale)).toBe(false)
  })

  it('a worktree locked by a pid that is not running is removed', () => {
    const stale = plant('cynco-bestofn-', 'cynco-bestofn pid=999999')
    new WorktreeManager(repoDir, { isAlive: pid => pid !== 999999 })
    const list = execSync('git worktree list --porcelain', { cwd: repoDir, stdio: 'pipe' }).toString()
    expect(list).not.toContain(basename(stale))
    expect(existsSync(stale)).toBe(false)
  })

  it('a live manager\'s in-flight worktree survives a second manager (concurrent engines)', async () => {
    const inflight = await manager.create()
    const second = new WorktreeManager(repoDir)
    expect(second.registered().map(r => basename(r.path))).toContain(basename(inflight))
    expect(existsSync(join(inflight, 'hello.txt'))).toBe(true)
  })

  it('never touches a worktree whose name is not cynco-bestofn-*, or one locked for another reason', () => {
    const foreign = plant('cynco-other-')
    const lockedByUser = plant('cynco-bestofn-', 'operator hold')
    const after = names()
    expect(after).toContain(basename(foreign))
    expect(after).toContain(basename(lockedByUser))
    execSync(`git worktree remove --force --force "${foreign}"`, { cwd: repoDir, stdio: 'pipe' })
    execSync(`git worktree remove --force --force "${lockedByUser}"`, { cwd: repoDir, stdio: 'pipe' })
  })

  it('never touches a cynco-bestofn-* worktree outside the tmp root', () => {
    const outside = join(repoDir, 'cynco-bestofn-nested')
    execSync(`git worktree add --detach "${outside}"`, { cwd: repoDir, stdio: 'pipe' })
    expect(names()).toContain('cynco-bestofn-nested')
    execSync(`git worktree remove --force "${outside}"`, { cwd: repoDir, stdio: 'pipe' })
  })
})

describe('isStaleBestOfNWorktree / parseWorktreeList', () => {
  it('parses paths and lock reasons from porcelain output', () => {
    const porcelain = [
      'worktree C:/repo', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree C:/tmp/cynco-bestofn-a', 'HEAD abc', 'detached', 'locked cynco-bestofn pid=12', '',
      'worktree C:/tmp/cynco-bestofn-b', 'HEAD abc', 'detached', 'locked', '',
    ].join('\n')
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: 'C:/repo', locked: null },
      { path: 'C:/tmp/cynco-bestofn-a', locked: 'cynco-bestofn pid=12' },
      { path: 'C:/tmp/cynco-bestofn-b', locked: '' },
    ])
  })

  it('stale = ours, under the tmp root, and unlocked or owned by a dead pid', () => {
    const root = tmpdir()
    const at = (n: string) => join(root, n)
    expect(isStaleBestOfNWorktree({ path: at('cynco-bestofn-x'), locked: null }, root)).toBe(true)
    expect(isStaleBestOfNWorktree({ path: at('cynco-bestofn-x'), locked: 'cynco-bestofn pid=5' }, root, () => false)).toBe(true)
    expect(isStaleBestOfNWorktree({ path: at('cynco-bestofn-x'), locked: 'cynco-bestofn pid=5' }, root, () => true)).toBe(false)
    expect(isStaleBestOfNWorktree({ path: at('cynco-bestofn-x'), locked: '' }, root)).toBe(false)
    expect(isStaleBestOfNWorktree({ path: at('phase5-evidence-engine'), locked: null }, root)).toBe(false)
    expect(isStaleBestOfNWorktree({ path: join(root, 'sub', 'cynco-bestofn-x'), locked: null }, root)).toBe(false)
  })
})
