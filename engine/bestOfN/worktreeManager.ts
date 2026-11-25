import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmdirSync, rmSync, unlinkSync } from 'fs'
import { basename, dirname, relative, resolve, join } from 'path'
import { tmpdir } from 'os'
import { harnessGitBin, harnessGitEnv } from '../harnessGit.js'
import { listEntries } from '../realPath.js'

/** A candidate worktree with more entries than this is not read whole, and so not applied. */
export const LINK_WALK_LIMIT = 200_000

/**
 * Every link under `root`, relative to it, by the folders' own listings (`listEntries`): any reparse
 * point, a junction a low-integrity process made among them, which `lstat` calls a folder (F242). A
 * link is never entered, and no `.git` folder is walked. `unread` names why the walk could not see
 * everything (a folder it could not list, or more than `limit` entries); a caller that must not miss
 * a link treats it as one. `skip` names entries (by their path relative to `root`, with `/`) that are
 * neither reported nor entered nor counted.
 */
export function linksIn(
  root: string,
  limit = LINK_WALK_LIMIT,
  skip: (rel: string) => boolean = () => false,
): { links: string[]; unread: string | null } {
  const links: string[] = []
  const queue = [root]
  let seen = 0
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries: ReturnType<typeof listEntries>
    try {
      entries = listEntries(dir)
    } catch (e) {
      return { links, unread: `${relative(root, dir) || '.'} could not be listed (${(e as Error).message})` }
    }
    for (const { name, kind } of entries) {
      const p = join(dir, name)
      if (skip(relative(root, p).replace(/\\/g, '/'))) continue
      if (++seen > limit) return { links, unread: `it holds more than ${limit} entries` }
      if (kind === 'link') links.push(relative(root, p))
      else if (kind === 'dir' && name !== '.git') queue.push(p)
    }
  }
  return { links, unread: null }
}

/**
 * Remove every link under `root` as an entry, never entering one (`rmdirSync`, then `unlinkSync` when
 * that fails: neither follows a link), so that a removal of the worktree afterwards cannot reach
 * through one. The names it could not remove are returned. The walk has no entry bound:
 * LINK_WALK_LIMIT bounds what extractPatch will apply, and a worktree too big to apply must still be
 * removed (F162: never leave a worktree behind; check C4-1). Only a folder it cannot list stops it.
 */
function unlinkLinksIn(root: string): string[] {
  const left: string[] = []
  const { links, unread } = linksIn(root, Number.POSITIVE_INFINITY)
  for (const rel of links) {
    const p = join(root, rel)
    try {
      rmdirSync(p)
    } catch {
      try { unlinkSync(p) } catch (e) { left.push(`${rel} (${(e as Error).message.split('\n')[0]})`) }
    }
  }
  if (unread !== null) left.push(`the walk did not see everything: ${unread}`)
  return left
}

/** Every worktree this manager creates lives at `<tmpdir>/cynco-bestofn-XXXXXX`. */
export const WORKTREE_PREFIX = 'cynco-bestofn-'
/** Lock reason carried by a worktree this manager created: names the owning pid. */
const LOCK_TAG = 'cynco-bestofn pid='
/** Cap on one git call; worktree add of a large repo is the slowest (seconds). */
export const GIT_TIMEOUT_MS = 60_000

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

/**
 * A registered worktree of ours (basename `cynco-bestofn-`) whose folder no longer exists, wherever
 * it was, and that no live process owns (unlocked, or its `cynco-bestofn pid=N` lock names a pid
 * that is not running). Lifting its lock and pruning it touches git's metadata only. One locked for
 * another reason is never touched.
 */
export function isGoneBestOfNWorktree(
  wt: RegisteredWorktree,
  isAlive: (pid: number) => boolean = pidAlive,
  exists: (p: string) => boolean = existsSync,
): boolean {
  if (!basename(wt.path).startsWith(WORKTREE_PREFIX)) return false
  if (exists(wt.path)) return false
  if (wt.locked === null) return true
  const m = wt.locked.match(/cynco-bestofn pid=(\d+)/)
  return m !== null && !isAlive(Number(m[1]))
}

export interface WorktreeManagerOptions {
  /** Where worktrees are created and stale ones looked for; default `os.tmpdir()`. */
  tmpRoot?: string
  /** Liveness probe for a lock's pid; default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
  /** Test seam: runs git (`file`, `harnessGitBin`) with one argument vector, no shell; default `child_process.execFileSync`. */
  exec?: (file: string, args: string[], options: { cwd: string; stdio: 'pipe'; timeout: number; env?: Record<string, string | undefined>; windowsHide: boolean }) => Buffer | string
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
  private readonly exec: NonNullable<WorktreeManagerOptions['exec']>

  constructor(repoRoot: string, opts: WorktreeManagerOptions = {}) {
    this.repoRoot = repoRoot
    this.tmpRoot = opts.tmpRoot ?? tmpdir()
    this.exec = opts.exec ?? execFileSync
    this.pruneStale(opts.isAlive ?? pidAlive)
  }

  /**
   * Create a detached worktree from HEAD, locked with this process's pid.
   * Returns the absolute path to the new worktree directory.
   */
  async create(): Promise<string> {
    // git checks out into this empty folder: `git worktree add` refuses an existing folder only when it
    // is not empty (measured on git 2.53, wave 19b, check D19-5). The folder used to be removed first,
    // which opened a window for a link to be made at the path before git's checkout (check D19-2).
    const tmpPath = mkdtempSync(join(this.tmpRoot, WORKTREE_PREFIX))

    try {
      this.git(['worktree', 'add', '--detach', '--lock', '--reason', `${LOCK_TAG}${process.pid}`, tmpPath])
    } catch (e) {
      // A failed add leaves mkdtemp's folder, which nothing prunes: it was never registered and is not
      // active (wave 19c, check D19b-1). rmdirSync never recurses: a folder git wrote into, or a link
      // put in its place (removed as an entry on Windows, refused on POSIX), is left as it is.
      try { rmdirSync(tmpPath) } catch (re) { console.log(`[bestOfN] ${tmpPath} was not removed after the failed worktree add (not empty, or gone): ${(re as Error).message.split('\n')[0]}`) }
      throw e
    }
    // git checks out into an empty folder a junction made at this path leads to (measured, wave 19),
    // and in a contained run the tmp root is the sandbox's scratch, which a low process may write:
    // a low process that may delete in that folder can swap the empty folder above for a link before
    // git's checkout, and the candidate would work wherever it leads. The new worktree must be listed by its folder as a folder; otherwise the
    // candidate is not run, and the link is removed as an entry (never entered). git registered the
    // worktree at the folder the link led to (measured) and wrote its checkout there: neither is
    // deleted (a remove would delete that folder whole, and it is not the harness's), the
    // registration is unlocked so that `git worktree prune` drops it once that folder is gone, and
    // the log names the folder.
    const listed = (() => {
      try { return listEntries(dirname(tmpPath)).find(e => e.name === basename(tmpPath))?.kind ?? 'gone' } catch (e) { return `unlisted (${(e as Error).message.split('\n')[0]})` }
    })()
    if (listed !== 'dir') {
      const why = `is not a folder at its own path (its folder lists it as ${listed})`
      let led = tmpPath
      try { led = realpathSync.native(tmpPath) } catch (re) { console.log(`[bestOfN] ${tmpPath} leads nowhere (${(re as Error).message.split('\n')[0]}); the path itself is named`) }
      console.log(`[bestOfN] the new worktree ${tmpPath} ${why}: git checked it out into ${led}, which is left as it is; the worktree is not used`)
      try { rmdirSync(tmpPath) } catch { try { unlinkSync(tmpPath) } catch (e) { console.log(`[bestOfN] ${tmpPath} could not be removed: ${(e as Error).message.split('\n')[0]}`) } }
      try { this.git(['worktree', 'unlock', led], { retry: true }) } catch (e) { console.log(`[bestOfN] worktree unlock ${led}: ${(e as Error).message.split('\n')[0]}`) }
      throw new Error(`the new worktree ${tmpPath} ${why}`)
    }
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
    return parseWorktreeList(this.git(['worktree', 'list', '--porcelain'], { retry: true }))
  }

  // ── private ────────────────────────────────────────────────────────────

  private pruneStale(isAlive: (pid: number) => boolean): void {
    let stale: RegisteredWorktree[]
    try {
      // Bare `git worktree prune`: drops the admin entry (.git/worktrees/<name>)
      // of every UNLOCKED worktree in this repo whose directory is missing, of
      // any name — metadata only; it never deletes a directory. A worktree on a
      // drive that is briefly unreachable loses its registration and needs
      // `git worktree repair` (review M1).
      this.git(['worktree', 'prune'], { retry: true })
      const registered = this.registered()
      // A candidate worktree of ours whose folder is gone, wherever it was: in a contained run it
      // lived in a sandbox's scratch folder, which the sweep deletes, and its registration (locked,
      // so a plain prune keeps it) was never under this manager's tmp root, so it stayed for good
      // (NOW.md, containment backlog). Its lock is lifted and the entry pruned: metadata only.
      const gone = registered.filter(wt => isGoneBestOfNWorktree(wt, isAlive))
      for (const wt of gone) {
        console.log(`[bestOfN] pruning the registration of ${wt.path}: its folder is gone${wt.locked ? ` (${wt.locked}, owner not running)` : ''}`)
        try {
          if (wt.locked !== null) this.git(['worktree', 'unlock', wt.path], { retry: true })
        } catch (e) {
          console.log(`[bestOfN] worktree unlock ${wt.path}: ${(e as Error).message.split('\n')[0]}`)
        }
      }
      if (gone.length > 0) this.git(['worktree', 'prune'], { retry: true })
      stale = (gone.length > 0 ? this.registered() : registered).filter(wt => isStaleBestOfNWorktree(wt, this.tmpRoot, isAlive))
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
    // A candidate's link is removed as an entry first, so neither git's removal nor the rmSync
    // fallback below can reach through it: rmSync trusts lstat, which calls a junction a
    // low-integrity process made a folder and follows it (F242). A worktree whose links could not
    // all be removed is not deleted at all: it is left in place, named in the log (in a contained
    // run it lies in the sandbox's scratch, whose sweep never follows a link).
    if (existsSync(wtPath)) {
      const left = unlinkLinksIn(wtPath)
      if (left.length > 0) {
        console.log(`[bestOfN] ${wtPath} is not removed: a link in it could not be removed first (${left.join('; ')})`)
        return
      }
    }
    try {
      this.git(['worktree', 'remove', '--force', '--force', wtPath])
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
      this.git(['worktree', 'unlock', wtPath], { retry: true })
    } catch (e) {
      console.log(`[bestOfN] worktree unlock ${wtPath}: ${(e as Error).message.split('\n')[0]}`)
    }
    try {
      this.git(['worktree', 'prune'], { retry: true })
    } catch (e) {
      console.log(`[bestOfN] git worktree prune failed: ${(e as Error).message}`)
    }
    if (existsSync(wtPath)) {
      console.log(`[bestOfN] LEAK: ${wtPath} is still on disk; the next WorktreeManager will retry it`)
    }
  }

  /**
   * Every git call is bounded (review M5): a hung git reports as an error the
   * callers catch and log, never a hung best-of-N turn. An ETIMEDOUT that did
   * not spend its cap is bun's stale deadline (F155) — retried once, but ONLY
   * for the idempotent calls that opt in (`retry: true`: list, prune, unlock).
   * `worktree add --lock` is attempted once: a retry after a real partial
   * create would fail "already exists" (final review M3, T1-N1).
   */
  private git(args: string[], { retry = false }: { retry?: boolean } = {}): string {
    // Harness git in a folder a run may have written (F242): `worktree add` checks files out, which
    // would run a repository-defined smudge filter and a post-checkout hook. An argument vector, no
    // shell (wave 19b, check D19-1): a path git registered, or one a link a lower process made led
    // to, is one argument, never shell text a POSIX shell or cmd would read.
    const env = harnessGitEnv(process.env, { repo: this.repoRoot })
    const run = () => this.exec(harnessGitBin(env), args, {
      cwd: this.repoRoot,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
      env,
      windowsHide: true,
    })
      .toString()
      .trim()
    const started = Date.now()
    try {
      return run()
    } catch (e) {
      const elapsed = Date.now() - started
      if (!retry || (e as NodeJS.ErrnoException).code !== 'ETIMEDOUT' || elapsed >= GIT_TIMEOUT_MS / 2) throw e
      console.log(`[bestOfN] git ${args[0]}…: impossible ETIMEDOUT after ${elapsed} ms (cap ${GIT_TIMEOUT_MS} ms) — retrying once (F155)`)
      return run()
    }
  }
}
