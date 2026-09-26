import { execSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { basename, dirname, resolve, join } from 'path'
import { tmpdir } from 'os'

/** Every worktree this manager creates lives at `<tmpdir>/cynco-bestofn-XXXXXX`. */
export const WORKTREE_PREFIX = 'cynco-bestofn-'
/** Lock reason carried by a worktree this manager created: names the owning pid. */
const LOCK_TAG = 'cynco-bestofn pid='

export interface RegisteredWorktree {
  path: string
  /** `null` when unlocked; the lock reason ('' for a bare `locked` line) otherwise. */
  locked: string | null
}

/** Parse `git worktree list --porcelain` into path + lock reason per worktree. */
export function parseWorktreeList(porcelain: string): RegisteredWorktree[] {
  const out: RegisteredWorktree[] = []
  let cur: RegisteredWorktree | null = null
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), locked: null }
      out.push(cur)
    } else if (cur && (line === 'locked' || line.startsWith('locked '))) {
      cur.locked = line.slice('locked'.length).trim()
    }
  }
  return out
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * A registered worktree is stale when it is one of ours (basename starts with
 * `cynco-bestofn-`, parent is the tmp root) and no live process owns it: it is
 * unlocked (pre-lock leaks, F162) or its lock names a pid that is not running.
 * Anything else — the main tree, a phase worktree, another tool's — is never
 * touched.
 */
export function isStaleBestOfNWorktree(
  wt: RegisteredWorktree,
  tmpRoot: string,
  isAlive: (pid: number) => boolean = pidAlive,
): boolean {
  if (!basename(wt.path).startsWith(WORKTREE_PREFIX)) return false
  if (!samePath(dirname(wt.path), tmpRoot)) return false
  if (wt.locked === null) return true
  const m = wt.locked.match(/cynco-bestofn pid=(\d+)/)
  if (!m) return false // locked by someone else, for their own reason
  return !isAlive(Number(m[1]))
}

export interface WorktreeManagerOptions {
  /** Where worktrees are created and stale ones looked for; default `os.tmpdir()`. */
  tmpRoot?: string
  /** Liveness probe for a lock's pid; default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
}

/**
 * Manages temporary git worktrees for best-of-N sandboxing.
 *
 * Each worktree is a detached checkout from HEAD in the OS tmpdir,
 * isolated from the main workspace so parallel candidates can diverge
 * without interfering with each other or the user's working tree.
 *
 * Construction prunes the repo's stale `cynco-bestofn-*` worktrees (F162: two
 * leaked in May stayed registered for four months). Each worktree is created
 * locked with this process's pid, so a concurrent engine's in-flight candidate
 * is never pruned.
 */
export class WorktreeManager {
  private readonly repoRoot: string
  private readonly tmpRoot: string
  private readonly active: string[] = []

  constructor(repoRoot: string, opts: WorktreeManagerOptions = {}) {
    this.repoRoot = repoRoot
    this.tmpRoot = opts.tmpRoot ?? tmpdir()
    this.pruneStale(opts.isAlive ?? pidAlive)
  }

  /**
   * Create a detached worktree from HEAD, locked with this process's pid.
   * Returns the absolute path to the new worktree directory.
   */
  async create(): Promise<string> {
    const tmpPath = mkdtempSync(join(this.tmpRoot, WORKTREE_PREFIX))

    // mkdtempSync creates the dir but `git worktree add` requires it NOT to exist
    // Remove the directory so git can create it itself
    rmSync(tmpPath, { recursive: true, force: true })

    this.git(`worktree add --detach --lock --reason "${LOCK_TAG}${process.pid}" "${tmpPath}"`)
    this.active.push(tmpPath)
    return tmpPath
  }

  /**
   * Remove a specific managed worktree.
   * `git worktree remove --force --force` (the second force removes a locked
   * one); on failure (Windows: a process still holds a file in it) falls back
   * to a retried rmSync + prune, and logs what it could not remove rather than
   * swallowing it — the swallowed failure is how two worktrees leaked (F162).
   */
  cleanup(wtPath: string): void {
    this.remove(wtPath)
    const idx = this.active.indexOf(wtPath)
    if (idx !== -1) this.active.splice(idx, 1)
  }

  /**
   * Remove all worktrees created by this manager instance.
   */
  cleanupAll(): void {
    // Copy the list before iterating since cleanup() mutates it
    for (const wtPath of [...this.active]) {
      this.cleanup(wtPath)
    }
  }

  /**
   * Return the list of worktree paths currently managed by this instance.
   */
  getActive(): string[] {
    return [...this.active]
  }

  /** Worktrees git currently has registered for this repo. */
  registered(): RegisteredWorktree[] {
    return parseWorktreeList(this.git('worktree list --porcelain'))
  }

  // ── private ────────────────────────────────────────────────────────────

  private pruneStale(isAlive: (pid: number) => boolean): void {
    let stale: RegisteredWorktree[]
    try {
      this.git('worktree prune')
      stale = this.registered().filter(wt => isStaleBestOfNWorktree(wt, this.tmpRoot, isAlive))
    } catch (e) {
      // Not a repo / git missing: create() will fail loudly; nothing to prune.
      console.log(`[bestOfN] stale worktree scan skipped in ${this.repoRoot}: ${(e as Error).message}`)
      return
    }
    for (const wt of stale) {
      console.log(`[bestOfN] pruning stale worktree ${wt.path}${wt.locked ? ` (${wt.locked}, owner not running)` : ' (unlocked)'}`)
      this.remove(wt.path)
    }
  }

  private remove(wtPath: string): void {
    try {
      this.git(`worktree remove --force --force "${wtPath}"`)
      return
    } catch (e) {
      console.log(`[bestOfN] git worktree remove failed for ${wtPath}: ${(e as Error).message.split('\n')[0]} — falling back to rmSync + prune`)
    }
    try {
      rmSync(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (e) {
      console.log(`[bestOfN] could not delete ${wtPath}: ${(e as Error).message}`)
    }
    try {
      // A locked entry survives a plain prune even with its directory gone.
      this.git(`worktree unlock "${wtPath}"`)
    } catch (e) {
      console.log(`[bestOfN] worktree unlock ${wtPath}: ${(e as Error).message.split('\n')[0]}`)
    }
    try {
      this.git('worktree prune')
    } catch (e) {
      console.log(`[bestOfN] git worktree prune failed: ${(e as Error).message}`)
    }
    if (existsSync(wtPath)) {
      console.log(`[bestOfN] LEAK: ${wtPath} is still on disk; the next WorktreeManager will retry it`)
    }
  }

  private git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.repoRoot,
      stdio: 'pipe',
    })
      .toString()
      .trim()
  }
}
