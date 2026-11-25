import { execFileSync } from 'child_process'
import { join } from 'path'
import { harnessGitBin, harnessGitEnv, isHarnessRefused } from '../harnessGit.js'
import { listEntries } from '../realPath.js'
import { GIT_TIMEOUT_MS, LINK_WALK_LIMIT } from './worktreeManager.js'

const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB

/**
 * The links in a candidate's worktree that `git add -A` would stage, or why that could not be told.
 *
 * Walked one level at a time by the folders' own listings, never into a link and never into `.git`;
 * git is asked only `check-ignore` about the folders and links of each level (it reads the ignore
 * rules and walks nothing) and `ls-files` about the index (check B4-5). A folder or link is passed
 * over only when git ignores it and the index holds nothing at or under it: `git add -A` never
 * enters such a folder or stages such a name, so the junctions an install makes under an ignored
 * node_modules cannot reach the patch (check C4-2), while a tracked file inside an ignored folder is
 * still staged and its folder still walked. The entry bound counts what is listed (LINK_WALK_LIMIT).
 */
function stagedLinks(cwd: string, env: NodeJS.ProcessEnv): { links: string[]; unread: string | null } {
  const gitIn = (dir: string, e: NodeJS.ProcessEnv, args: string[], input?: string): string =>
    execFileSync(harnessGitBin(e), args, { cwd: dir, env: e, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: 'pipe', ...(input !== undefined ? { input } : {}) }).toString()
  const gitOut = (args: string[], input?: string): string => gitIn(cwd, env, args, input)
  // Check C4-8: a folder git takes for an embedded repository (its own `.git`, with a commit checked
  // out) is staged as one gitlink, and `git add -A` never enters it (measured, git 2.53), so the walk
  // does not either. It is asked of harness git in that folder, which refuses a `.git` that is not
  // the folder's own repository (a file naming another, a link); a `.git` git cannot read as a
  // repository (an empty folder, a file naming nothing) is entered by `git add -A`, which then stages
  // what a link in it leads to (measured), so such a folder is walked as before.
  const embeddedRepo = (dir: string): boolean => {
    const abs = join(cwd, dir)
    const e = harnessGitEnv(process.env, { repo: abs })
    if (isHarnessRefused(e)) return false
    try {
      gitIn(abs, e, ['rev-parse', '--verify', '-q', 'HEAD'])
      return true
    } catch {
      return false
    }
  }
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const first = (e: unknown) => (e as Error).message.split('\n')[0]
  // What the index holds, and every folder above it: such a folder is walked even when ignored.
  const tracked = new Set<string>()
  try {
    for (const p of gitOut(['ls-files', '-z']).split('\0')) {
      if (p === '') continue
      const parts = fold(p).split('/')
      for (let i = 1; i <= parts.length; i++) tracked.add(parts.slice(0, i).join('/'))
    }
  } catch (e) {
    return { links: [], unread: `git could not list its index: ${first(e)}` }
  }
  const ignoredOf = (rels: string[]): Set<string> => {
    try {
      return new Set(gitOut(['check-ignore', '-z', '--stdin'], rels.join('\0') + '\0').split('\0').filter(p => p !== ''))
    } catch (e) {
      // Exit 1: none of them is ignored. Anything else is no answer.
      if ((e as { status?: unknown }).status === 1) return new Set()
      throw e
    }
  }
  const links: string[] = []
  let seen = 0
  let level: string[] = ['']
  while (level.length > 0) {
    const here: Array<{ rel: string; kind: 'link' | 'dir' }> = []
    for (const dir of level) {
      let entries: ReturnType<typeof listEntries>
      try {
        entries = listEntries(dir === '' ? cwd : join(cwd, dir))
      } catch (e) {
        return { links, unread: `${dir || '.'} could not be listed (${first(e)})` }
      }
      if (dir !== '' && entries.some(en => fold(en.name) === '.git') && embeddedRepo(dir)) continue
      for (const { name, kind } of entries) {
        if (++seen > LINK_WALK_LIMIT) return { links, unread: `it holds more than ${LINK_WALK_LIMIT} entries` }
        if (kind === 'file' || (kind === 'dir' && name === '.git')) continue
        here.push({ rel: dir === '' ? name : `${dir}/${name}`, kind })
      }
    }
    if (here.length === 0) break
    let ignored: Set<string>
    try {
      ignored = ignoredOf(here.map(h => h.rel))
    } catch (e) {
      return { links, unread: `git could not say what it ignores: ${first(e)}` }
    }
    const next: string[] = []
    for (const h of here) {
      if (ignored.has(h.rel) && !tracked.has(fold(h.rel))) continue
      if (h.kind === 'link') links.push(h.rel)
      else next.push(h.rel)
    }
    level = next
  }
  return { links, unread: null }
}

/**
 * Captures a unified diff of all changes (tracked modifications + untracked
 * new files) in the given working directory.
 *
 * The sequence is:
 *  1. `git add -A`           — stage everything, including untracked files
 *  2. `git diff --cached HEAD` — produce the staged diff vs HEAD
 *  3. `git reset HEAD`       — unstage so the worktree is left as-is
 *
 * Returns the diff byte-for-byte (NOT trimmed: `git apply` needs the newline
 * after the last hunk line, F162), or an empty string if there are no changes
 * or if any git command fails. `label` names the candidate in the log line
 * that says why one is not applied (`candidate N`); its worktree follows.
 */
export function extractPatch(cwd: string, label?: string): string {
  const who = label ? `${label} (${cwd})` : `candidate ${cwd}`
  // Harness git in a folder a candidate wrote (F242): no hooks, monitor, repository filters or pager.
  const env = harnessGitEnv(process.env, { repo: cwd })
  // One argument vector through harnessGitBin under the package's cap, as the walk's git (wave 19c,
  // check D19b-6): a git that hangs here (a lock held, a slow volume) held the event loop for good.
  const run = (args: string[], opts: { trim?: boolean } = {}): string => {
    const out = execFileSync(harnessGitBin(env), args, { cwd, stdio: 'pipe', maxBuffer: MAX_BUFFER, env, timeout: GIT_TIMEOUT_MS, windowsHide: true }).toString()
    return opts.trim === false ? out : out.trim()
  }

  // A link the candidate made would be staged as the folder it leads to (git treats every junction
  // as a folder, F6), putting files from anywhere into the patch the loop applies to the mission
  // folder. Such a candidate is not applied; one the walk could not read whole is not either. Only
  // what `git add -A` would stage is judged (check C4-2), and the walk comes before any git command
  // that walks the work tree (check B4-5), so git never descends a link the candidate made. A tracked
  // symbolic link checked out as one (Developer Mode) is still refused: git keeps it as a link, but
  // the walk cannot tell it from a junction the candidate made.
  const { links, unread } = stagedLinks(cwd, env)
  if (links.length > 0 || unread !== null) {
    const why = links.length > 0
      ? `made a link (${links.slice(0, 3).join(', ')}${links.length > 3 ? ` and ${links.length - 3} more` : ''})`
      : `could not be read whole (${unread})`
    console.log(`[bestOfN] ${who} ${why}; it is not applied`)
    return ''
  }

  try {
    run(['add', '-A'])
    // A patch-producing diff: no external diff or textconv driver the folder names (HARNESS_DIFF_FLAGS).
    const diff = run(['diff', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD'], { trim: false })
    run(['reset', 'HEAD'])
    // A diff with no changes is empty; one with changes starts with "diff --git"
    // and ends with the newline git apply requires — never trim it (F162).
    return diff.trim().length ? diff : ''
  } catch {
    // Any git failure (not a repo, no commits, etc.) → return empty
    return ''
  }
}
