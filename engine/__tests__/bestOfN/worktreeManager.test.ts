import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync, execSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, rmdirSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { WorktreeManager, isStaleBestOfNWorktree, parseWorktreeList } from '../../bestOfN/worktreeManager.js'
import { harnessGitBin, harnessGitEnv } from '../../harnessGit.js'

// The manager's git seam takes an argument vector, no shell (wave 19b, check D19-1); the cases read
// it as the command line it stands for, and the path `worktree add` is given is its last argument.
const line = (args: string[]) => ['git', ...args].join(' ')
const addPath = (args: string[]) => (args[0] === 'worktree' && args[1] === 'add' ? args[args.length - 1] : undefined)

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

// Final review M3 (T1-N1): the F155 retry on an early ETIMEDOUT is opt-in —
// list/prune/unlock only. `worktree add --lock` is attempted once: a retry
// after a real partial create would only fail "already exists".
describe('the early-ETIMEDOUT retry is for idempotent git calls only', () => {
  const earlyTimeout = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' })

  it('worktree add is attempted once on a fake early ETIMEDOUT', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cynco-wt-retry-'))
    tempRepos.push(tmpRoot)
    const calls: string[] = []
    const m = new WorktreeManager('C:/nowhere', { tmpRoot, exec: (_file, args) => {
      const cmd = line(args)
      calls.push(cmd)
      if (cmd.startsWith('git worktree add')) throw earlyTimeout()
      return ''
    } })
    await expect(m.create()).rejects.toThrow('ETIMEDOUT')
    expect(calls.filter(c => c.startsWith('git worktree add'))).toHaveLength(1)
    expect(m.getActive()).toHaveLength(0)
    // The empty folder mkdtemp made for the failed add is removed with it (wave 19c, check D19b-1):
    // nothing prunes it later, since it was never registered and never active.
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('every git call starts harnessGitBin of the harness environment, by argument vector (wave 19c, check D19b-5)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cynco-wt-bin-'))
    tempRepos.push(tmpRoot)
    const files: string[] = []
    const m = new WorktreeManager(repoDir, { tmpRoot, exec: (file, args, options) => {
      files.push(file)
      return execFileSync(file, args, options)
    } })
    const wt = await m.create()
    m.cleanup(wt)
    const expected = harnessGitBin(harnessGitEnv(process.env, { repo: repoDir }))
    expect(files.length).toBeGreaterThan(3)
    expect(new Set(files)).toEqual(new Set([expected]))
  })

  it('list and prune are retried once on a fake early ETIMEDOUT', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cynco-wt-retry-'))
    tempRepos.push(tmpRoot)
    const calls: string[] = []
    const failedOnce = new Set<string>()
    const m = new WorktreeManager('C:/nowhere', { tmpRoot, exec: (_file, args) => {
      const cmd = line(args)
      calls.push(cmd)
      if (!failedOnce.has(cmd)) { failedOnce.add(cmd); throw earlyTimeout() }
      return ''
    } })
    // The constructor's prune + list each failed once and succeeded on the retry.
    expect(calls).toEqual(['git worktree prune', 'git worktree prune', 'git worktree list --porcelain', 'git worktree list --porcelain'])
    expect(m.registered()).toEqual([])
  })

  it('a non-ETIMEDOUT failure is never retried, even on an opted-in call', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cynco-wt-retry-'))
    tempRepos.push(tmpRoot)
    const calls: string[] = []
    new WorktreeManager('C:/nowhere', { tmpRoot, exec: (_file, args) => { calls.push(line(args)); throw new Error('not a git repository') } })
    expect(calls).toEqual(['git worktree prune'])
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

  // NOW.md, containment backlog: in a contained run the worktrees live in the sandbox's scratch
  // folder. When the sweep deleted that folder the registration stayed, locked (a plain prune keeps
  // a locked entry) and outside every later manager's tmp root, so nothing ever pruned it.
  it('a locked cynco-bestofn-* registration whose folder is gone, outside the tmp root, is pruned', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cynco-wt-oldscratch-'))
    tempRepos.push(elsewhere)
    const p = join(elsewhere, 'cynco-bestofn-swept')
    execSync(`git worktree add --detach --lock --reason "cynco-bestofn pid=999999" "${p}"`, { cwd: repoDir, stdio: 'pipe' })
    rmSync(p, { recursive: true, force: true })
    const list = () => execSync('git worktree list --porcelain', { cwd: repoDir, stdio: 'pipe' }).toString()
    expect(list()).toContain('cynco-bestofn-swept')
    new WorktreeManager(repoDir, { isAlive: pid => pid !== 999999 })
    expect(list()).not.toContain('cynco-bestofn-swept')
  })

  it('a gone registration locked by a live pid, or for another reason, is kept', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cynco-wt-oldscratch-'))
    tempRepos.push(elsewhere)
    const live = join(elsewhere, 'cynco-bestofn-live')
    const held = join(elsewhere, 'cynco-bestofn-held')
    execSync(`git worktree add --detach --lock --reason "cynco-bestofn pid=4242" "${live}"`, { cwd: repoDir, stdio: 'pipe' })
    execSync(`git worktree add --detach --lock --reason "operator hold" "${held}"`, { cwd: repoDir, stdio: 'pipe' })
    rmSync(live, { recursive: true, force: true })
    rmSync(held, { recursive: true, force: true })
    new WorktreeManager(repoDir, { isAlive: pid => pid === 4242 })
    const list = execSync('git worktree list --porcelain', { cwd: repoDir, stdio: 'pipe' }).toString()
    expect(list).toContain('cynco-bestofn-live')
    expect(list).toContain('cynco-bestofn-held')
    for (const p of [live, held]) {
      execSync(`git worktree unlock "${p}"`, { cwd: repoDir, stdio: 'pipe' })
    }
    execSync('git worktree prune', { cwd: repoDir, stdio: 'pipe' })
  })

  it('removing a worktree removes a link in it as an entry and never what it leads to, even when git cannot remove it', async () => {
    const wt = await manager.create()
    const victim = mkdtempSync(join(tmpdir(), 'cynco-wt-victim-'))
    tempRepos.push(victim)
    writeFileSync(join(victim, 'keep.txt'), 'keep\n')
    symlinkSync(victim, join(wt, 'lead-out'), 'junction')
    // git's removal fails (a file held, say), so the rmSync fallback runs.
    const real = execFileSync
    const m = new WorktreeManager(repoDir, {
      isAlive: () => true,
      exec: (file, args, opts) => {
        if (line(args).startsWith('git worktree remove')) throw new Error('simulated: a file is held')
        return real(file, args, opts)
      },
    })
    ;(m as any).active.push(wt)
    m.cleanupAll()
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
    expect(existsSync(wt)).toBe(false)
  })

  // Wave 19 (found by package D, measured: `out\wtprobe.txt`): `git worktree add` checks out into an
  // empty folder that a junction made at its path leads to. In a contained run the worktrees live in
  // the sandbox's scratch folder, which a low process may write, so a link made at the new path
  // between the removal of mkdtemp's folder and git's checkout put the checkout wherever it led, and
  // the candidate then worked in that folder. The new worktree is now refused unless its folder's
  // listing shows it as a folder: the link is removed as an entry, the registration git made (at the
  // folder the link led to) is unlocked, nothing there is deleted, and create() throws, so the loop
  // falls back to a single pass.
  // A link is planted at the new worktree's path the moment `worktree add` is asked for (the empty
  // folder mkdtemp made is removed first, as a low process with delete rights in the scratch folder
  // would), and create() is run against it.
  const linkAtAdd = async (outside: string) => {
    const root = mkdtempSync(join(tmpdir(), 'cynco-wt-root-'))
    tempRepos.push(root)
    const real = execFileSync
    let planted = ''
    const m = new WorktreeManager(repoDir, {
      tmpRoot: root,
      isAlive: () => true,
      exec: (file, args, opts) => {
        const at = addPath(args)
        if (at) {
          if (existsSync(at)) rmdirSync(at)
          symlinkSync(outside, at, 'junction'); planted = at
        }
        return real(file, args, opts)
      },
    })
    let thrown = ''
    try {
      await m.create()
    } catch (e) {
      thrown = (e as Error).message
    } finally {
      if (planted && existsSync(planted)) { try { rmdirSync(planted) } catch { /* removed by the manager */ } }
    }
    return { m, root, planted, thrown }
  }

  it('a worktree whose path became a link before git checked it out is not used; the link goes and the registration is unlocked', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cynco-wt-outside-'))
    tempRepos.push(outside)
    const { m, root, planted, thrown } = await linkAtAdd(outside)
    expect(planted).not.toBe('')
    expect(thrown).toMatch(/is not a folder at its own path/)
    expect(m.getActive()).toEqual([])
    // What git checked out through the link stays where it went (git wrote it before the look); the
    // folder the link led to is not deleted, and the link is gone.
    expect(existsSync(join(outside, 'hello.txt'))).toBe(true)
    expect(readdirSync(root)).toEqual([])
    // git registered the worktree at the folder the link led to; that registration is unlocked, so a
    // prune drops it once the folder is gone.
    const regs = parseWorktreeList(execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf-8' }))
    const there = regs.filter(w => basename(w.path) === basename(outside))
    expect(there, JSON.stringify(regs)).toHaveLength(1)
    expect(there[0].locked).toBeNull()
  })

  // Wave 19b, check D19-1: the unlock of that registration named the folder the link led to, a name
  // a lower process chose, inside shell text (`git worktree unlock "<path>"`): a POSIX shell ran a
  // `$(...)` in it at the engine's level, and cmd expanded a `%NAME%`, so the unlock missed and the
  // registration stayed locked. Every git call of the manager is now an argument vector, no shell.
  it('the unlock of a registration whose folder name holds shell syntax reaches that registration, and the name runs nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cynco-wt-outside-'))
    tempRepos.push(parent)
    const name = process.platform === 'win32' ? 'led-%OS%-x' : 'led-$(echo ran)-`echo ran`-x'
    const outside = join(parent, name)
    mkdirSync(outside)
    const { planted, thrown } = await linkAtAdd(outside)
    expect(planted).not.toBe('')
    expect(thrown).toMatch(/is not a folder at its own path/)
    const regs = parseWorktreeList(execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf-8' }))
    const there = regs.filter(w => basename(w.path) === name)
    expect(there, JSON.stringify(regs)).toHaveLength(1)
    expect(there[0].locked).toBeNull()
  })

  // Wave 19b, checks D19-2 and D19-5 (measured, `phase3\w19\scratch\d\out-b\wtempty.txt`, git 2.53):
  // `git worktree add` checks out into an existing EMPTY folder and refuses a non-empty one ("already
  // exists"). The folder mkdtemp made is now the one git checks out into: removing it first opened a
  // window in which a link could be made at the path. A low process that may delete in the scratch
  // folder can still swap the folder, which the look after the add sees (the case above).
  it('git checks out into the empty folder mkdtemp made, which is never removed first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cynco-wt-root-'))
    tempRepos.push(root)
    const real = execFileSync
    const atAdd: string[] = []
    const m = new WorktreeManager(repoDir, {
      tmpRoot: root,
      isAlive: () => true,
      exec: (file, args, opts) => {
        const at = addPath(args)
        if (at) atAdd.push(existsSync(at) ? `folder holding ${readdirSync(at).length}` : 'gone')
        return real(file, args, opts)
      },
    })
    const wt = await m.create()
    expect(atAdd).toEqual(['folder holding 0'])
    expect(existsSync(join(wt, 'hello.txt'))).toBe(true)
    m.cleanupAll()
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
