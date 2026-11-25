/**
 * engine/harnessGit.ts: the ONE helper for git the harness runs in a folder a contained run may
 * have written (F242, directive 7).
 *
 * A contained run can write `<mission>/.git/config`, `.git/hooks`, `.gitattributes` and any file
 * in its mission folder. The harness then runs git there at medium integrity with the real home
 * (the contract's git reads, the indexer, the snapshot, the driver's `git checkout -- .`, the
 * campaign runner's readers, the authoring commit). Four things in that folder can make such a
 * call run a program or write somewhere else:
 *
 * 1. configuration that names a program: hooks and `core.hooksPath`, `core.fsmonitor`, a filter
 *    driver with `.gitattributes`, an external diff or textconv driver, a pager, an editor, a
 *    signing program, a credential helper, an ssh command;
 * 2. `core.worktree`, which would aim a harness `git checkout -- .` or `git status` at another
 *    folder;
 * 3. a `git.cmd`, `git.bat` or `git.exe` in the folder: `cmd.exe` looks in the current directory
 *    before PATH, and every `execSync('git ...', { cwd })` goes through `cmd.exe` on Windows;
 * 4. whether a runtime's argv spawn of a bare `git` also looks in the child's working folder.
 *
 * `harnessGitEnv` answers 1 with git's command-scope configuration (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, which outrank the repository's own, as `-c` does)
 * and the plain variables git documents as overriding their keys. Signature verification belongs
 * to 1: a `git log` or `git show` verifies a signed commit with the program the repository names
 * for the signature's format (`gpg.ssh.program`, `gpg.x509.program`), whatever `gpg.program` says,
 * when `log.showSignature` is on or a format asks for `%G?`; those programs are pinned and the SSH
 * allowed-signers file is a path that is never created. 2 is answered, for a call given
 * `{ repo }`, by naming the repository outright, `GIT_DIR` and `GIT_WORK_TREE` (a command-scope
 * `core.worktree` does NOT outrank the repository's own: git reads that key from the repository's
 * config file while it finds the repository, before any override is applied, measured with git
 * 2.53 and pinned by `__tests__/harnessGit.test.ts`), after checking that `<repo>/.git` is the
 * repository's own folder and not a redirect (a `.git` file naming another repository, a
 * `commondir` file, a link), or a linked worktree whose administrative folder names it back. A
 * redirect refuses the call: git is given a `GIT_DIR` it can neither open nor create and exits
 * 128, which every caller already reads as a git failure. A `{ repo }` with no `.git` at all gets
 * `GIT_CEILING_DIRECTORIES`, so git cannot walk up to a repository that contains it (with
 * `nested: true`, for the indexer, which may be given a subfolder, the walk is made here and the
 * repository it finds is judged the same way). A `GIT_DIR` the caller set itself (the workspace
 * snapshot's store) is judged the same way. 3 is answered with
 * `NoDefaultCurrentDirectoryInExePath`; `harnessGitBin` answers 4 with the absolute path of the
 * real git.
 *
 * Not set, on purpose: `diff.external` and `diff.<n>.textconv` / `.command`, because an empty
 * value is not documented to mean "none". Every harness `git diff` that produces a patch carries
 * `HARNESS_DIFF_FLAGS` instead. Filter drivers defined in the owner's global or system config
 * (git-lfs) are the owner's own programs and are left alone; only the ones the repository itself
 * defines are blanked.
 *
 * Not checked: an `objects/<xx>` folder inside `.git` that is a link (a commit then writes object
 * files elsewhere, never a branch tip), and `objects/info/alternates` (read only).
 *
 * It reads no run context: the folder decides, not the process (the campaign runner and the index
 * builder have no context and still run git in a folder a run wrote).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { engineCheckout, linkLeadingOut } from './containment.js'
import { realPathOf } from './realPath.js'

/** Every harness `git diff` (or `show`, `log -p`) that produces a patch carries these. */
export const HARNESS_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv'] as const

type Env = Record<string, string | undefined>

const FILTER_LIST_CAP_MS = 10_000
const FILTER_KEY_RE = '^filter\\..*\\.(clean|smudge|process)$'

/** The fixed command-scope pairs, in order. `core.hooksPath` names a folder that is never created. */
function fixedPairs(): Array<[string, string]> {
  return [
    ['core.hooksPath', `${engineCheckout().replace(/\\/g, '/')}/.no-git-hooks`],
    ['core.fsmonitor', 'false'],
    ['core.pager', 'cat'],
    ['core.editor', 'true'],
    ['sequence.editor', 'true'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['gpg.program', 'gpg'],
    // A signed commit is verified by the program named for its format, not by `gpg.program`.
    ['log.showSignature', 'false'],
    ['gpg.ssh.program', 'ssh-keygen'],
    ['gpg.x509.program', 'gpgsm'],
    ['gpg.ssh.allowedSignersFile', `${engineCheckout().replace(/\\/g, '/')}/.no-git-allowed-signers`],
    // git documents that an empty value resets the helper list.
    ['credential.helper', ''],
    // C4-2 (wave 19): git's own refusal of a path Windows reads as another (`out./x.txt` is `out\x.txt`,
    // through a junction `out`), which a repository's `core.protectNTFS=false` turns off (measured
    // 2026-11-25: a harness `git apply` then wrote through the junction). protectHFS beside it refuses
    // only names HFS+ reads as `.git`, which no honest repository holds.
    ['core.protectNTFS', 'true'],
    ['core.protectHFS', 'true'],
  ]
}

function startCount(base: Env): number {
  const n = Number(base.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? 0)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

function pathKeyOf(env: Env): string | undefined {
  return Object.keys(env).find(k => k.toUpperCase() === 'PATH')
}

/**
 * `base` plus the variables and command-scope configuration that keep a git call from running a
 * program the folder names. With `o.repo`, the repository is named outright (`GIT_DIR`,
 * `GIT_WORK_TREE`) once its `.git` has been checked, or the call is refused (a `GIT_DIR` git
 * cannot open: exit 128), and the filter drivers the repository itself defines are blanked (one
 * `git config` call). `o.nested` lets `repo` be a subfolder of the repository. `o.worktreeLinks`
 * (for a call that writes the work tree or reads it into a commit or a patch) also walks the work
 * tree and refuses the call when a link in it leads outside it (NOW.md:76). Never throws.
 *
 * A caller whose spawn helper lays `env` over the process's own (`scripts/cynco-spawn.mjs`
 * `runSync` / `runAsync`) passes `harnessGitEnv({}, ...)`: the keys alone.
 */
export function harnessGitEnv(base: Env = process.env, o: { repo?: string; nested?: boolean; worktreeLinks?: boolean } = {}): Env {
  // B3 (wave 19): a refusal stays a refusal when a site hands it to the helper again.
  if (isHarnessRefused(base)) return { ...base }
  const env: Env = { ...base }
  env.GIT_PAGER = 'cat'
  env.GIT_EDITOR = 'true'
  env.GIT_TERMINAL_PROMPT = '0'
  // git documents that this variable overrides `core.sshCommand`.
  env.GIT_SSH_COMMAND = base.GIT_SSH_COMMAND ?? 'ssh'
  // With it set, `cmd.exe` does not look in the current directory for a command with no path.
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1'

  let n = startCount(base)
  const add = (key: string, value: string): void => {
    env[`GIT_CONFIG_KEY_${n}`] = key
    env[`GIT_CONFIG_VALUE_${n}`] = value
    n++
    env.GIT_CONFIG_COUNT = String(n)
  }
  for (const [k, v] of fixedPairs()) add(k, v)

  // A repository the caller named itself (the snapshot store) must be what it says it is too.
  if (base.GIT_DIR !== undefined && base.GIT_DIR !== '' && existsSync(base.GIT_DIR)) {
    const why = gitDirProblem(base.GIT_DIR)
    if (why !== null) return refused(env, base.GIT_DIR, why)
  }

  if (o.repo !== undefined && o.repo !== '') {
    if (base.GIT_DIR === undefined && base.GIT_WORK_TREE === undefined) {
      const pin = repositoryOf(o.repo, o.nested === true)
      if ('refused' in pin) return refused(env, o.repo, pin.refused)
      if ('gitDir' in pin) {
        env.GIT_DIR = slash(pin.gitDir)
        env.GIT_WORK_TREE = slash(pin.workTree)
      } else if (pin.ceiling !== undefined) {
        env.GIT_CEILING_DIRECTORIES = slash(pin.ceiling)
      }
    }
    // NOW.md:76: a harness git that writes the work tree (`checkout -- .`, `git apply`) follows a
    // junction in it, and one that reads it into a commit or a patch copies what is behind one (git
    // takes every junction for a folder, F6). The sites that do either pass `worktreeLinks`; the work
    // tree is walked as rule M walks a mission folder (`linkLeadingOut`, never entering a link), and a
    // link that leads out of it, or a tree that could not be read, refuses the call.
    if (o.worktreeLinks === true) {
      const top = realPathOf(env.GIT_WORK_TREE ?? o.repo, { quiet: true })
      const hit = linkLeadingOut(top)
      if (hit !== null) return refused(env, top, 'why' in hit ? `the work tree ${hit.why}` : `${hit.link} leads outside ${top} (to ${hit.target})`)
    }
    for (const name of repoFilterDrivers(o.repo, env, base)) {
      add(`filter.${name}.clean`, '')
      add(`filter.${name}.smudge`, '')
      add(`filter.${name}.process`, '')
      add(`filter.${name}.required`, 'false')
    }
  }
  return env
}

const slash = (p: string): string => p.replace(/\\/g, '/')

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** The `GIT_DIR` of a refused call: a path under a file, which git can neither open nor create. */
export function refusedGitDir(): string {
  return slash(join(process.execPath, 'harness-git-refused'))
}

/**
 * B3 (wave 19): what a refused call's command-scope count and parameters say. A `GIT_DIR` git cannot
 * open stops a command that needs a repository, but `git apply`, `apply --check`, `diff --no-index`
 * and `hash-object` run outside one and ran anyway (measured 2026-11-25). git parses its command-scope
 * configuration before any command reads anything, and a count it cannot parse is fatal to every one
 * of them (`error: bogus count in GIT_CONFIG_COUNT`, exit 128; `git --version` alone still answers).
 */
const REFUSED_CONFIG = 'harness-git-refused'

/**
 * Is `env` a refused harness environment (`harnessGitEnv` named a repository git may not touch)? The one
 * test for a site that must not run git at all then, instead of comparing `GIT_DIR` itself.
 */
export function isHarnessRefused(env: Env): boolean {
  return env.GIT_DIR === refusedGitDir() || env.GIT_CONFIG_COUNT === REFUSED_CONFIG || env.GIT_CONFIG_PARAMETERS === REFUSED_CONFIG
}

const refusalsLogged = new Set<string>()

function refused(env: Env, where: string, why: string): Env {
  env.GIT_DIR = refusedGitDir()
  delete env.GIT_WORK_TREE
  delete env.GIT_CEILING_DIRECTORIES
  env.GIT_CONFIG_COUNT = REFUSED_CONFIG
  env.GIT_CONFIG_PARAMETERS = REFUSED_CONFIG
  const key = `${where}|${why}`
  if (!refusalsLogged.has(key)) {
    refusalsLogged.add(key)
    console.log(`[harness-git] git refused in ${where}: ${why}`)
  }
  return env
}

type Pin = { gitDir: string; workTree: string } | { refused: string } | { ceiling?: string }

/**
 * Which repository a harness call in `repo` may touch. `<top>/.git` must be a real folder with no
 * `commondir` or `gitdir` file and no link among its entries, or a `.git` file naming a linked
 * worktree's administrative folder under another such repository that names `<top>/.git` back.
 * No `.git`: without `nested`, a ceiling at the folder's parent, so git finds no repository; with
 * it, the nearest folder above that has one, judged the same way.
 */
function repositoryOf(repo: string, nested: boolean): Pin {
  const real = realPathOf(repo, { quiet: true })
  let top = real
  for (;;) {
    let present = false
    try {
      lstatSync(join(top, '.git'))
      present = true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { refused: `${join(top, '.git')} could not be read (${code ?? (e as Error).message})` }
    }
    if (present) return judge(top)
    if (!nested) return { ceiling: dirname(real) }
    const up = dirname(top)
    if (up === top) return {}
    top = up
  }
}

function judge(top: string): Pin {
  const dotGit = join(top, '.git')
  const st = lstatSync(dotGit)
  if (st.isSymbolicLink()) return { refused: `${dotGit} is a link` }
  if (st.isDirectory()) {
    const why = gitDirProblem(dotGit)
    return why === null ? { gitDir: dotGit, workTree: top } : { refused: why }
  }
  if (!st.isFile()) return { refused: `${dotGit} is neither a folder nor a file` }
  // A linked worktree: `.git` reads `gitdir: <main>/.git/worktrees/<name>`.
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '')
  if (!m) return { refused: `${dotGit} is a file that names no repository` }
  const admin = resolve(top, m[1]!)
  if (!samePath(realPathOf(admin, { quiet: true }), admin)) return { refused: `${dotGit} names ${admin}, which is reached through a link` }
  const main = dirname(dirname(admin))
  if (basename(dirname(admin)) !== 'worktrees' || basename(main) !== '.git') {
    return { refused: `${dotGit} names ${admin}, which is not a worktree of a repository` }
  }
  const mainProblem = gitDirProblem(main)
  if (mainProblem !== null) return { refused: mainProblem }
  const adminProblem = gitDirProblem(admin, { worktree: true })
  if (adminProblem !== null) return { refused: adminProblem }
  const common = readText(join(admin, 'commondir'))?.trim()
  if (common === undefined || !samePath(realPathOf(resolve(admin, common), { quiet: true }), main)) {
    return { refused: `${admin} does not name ${main} as its common folder` }
  }
  const back = readText(join(admin, 'gitdir'))?.trim()
  if (back === undefined || !samePath(realPathOf(resolve(admin, back), { quiet: true }), dotGit)) {
    return { refused: `${admin} does not name ${dotGit} back` }
  }
  return { gitDir: admin, workTree: top }
}

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EISDIR') console.log(`[harness-git] ${p} could not be read: ${code ?? (e as Error).message}`)
    return undefined
  }
}

/**
 * Null when `d` is a repository folder git will use as it is: a real folder (no link on its way),
 * with no `commondir` and no `gitdir` file (a linked worktree's administrative folder has both;
 * its caller checks them: `worktree`), and no link among its entries or anywhere under `refs` and
 * `logs`, where git writes branch tips. Otherwise the reason.
 */
function gitDirProblem(d: string, o: { worktree?: boolean } = {}): string | null {
  let st
  try {
    st = lstatSync(d)
  } catch (e) {
    return `${d} could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${d} is not a folder of its own`
  if (!samePath(realPathOf(d, { quiet: true }), d)) return `${d} is reached through a link`
  if (!o.worktree) {
    for (const f of ['commondir', 'gitdir']) {
      if (existsSync(join(d, f))) return `${join(d, f)} redirects the repository`
    }
  }
  return linkUnder(d, 0) ?? linkUnder(join(d, 'refs'), 32) ?? linkUnder(join(d, 'logs'), 32)
}

/** The first link among `folder`'s entries (and, to `depth`, its subfolders'), or null. */
function linkUnder(folder: string, depth: number): string | null {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? null : `${folder} could not be listed (${code ?? (e as Error).message})`
  }
  for (const ent of entries) {
    const p = join(folder, ent.name)
    if (ent.isSymbolicLink()) return `${p} is a link`
    if (depth > 0 && ent.isDirectory()) {
      const why = linkUnder(p, depth - 1)
      if (why !== null) return why
    }
  }
  return null
}

/**
 * The names of the filter drivers defined at `local` or `worktree` scope in `repo`, read under
 * the fixed pairs already in `env`. Exit 1 (no match) and 128 (not a repository) are an empty
 * answer and log nothing; anything else is logged once and also answers empty.
 */
function repoFilterDrivers(repo: string, env: Env, base: Env): string[] {
  // A base with no PATH is the keys-alone form: the caller's spawn helper lays it over the
  // process's own environment, and this call does the same.
  const listEnv = pathKeyOf(base) === undefined ? { ...process.env, ...env } : env
  const args = ['-C', repo, 'config', '--show-scope', '--name-only', '--get-regexp', FILTER_KEY_RE]
  const once = (): { out: string } | { status: number } | { error: string; ms: number } => {
    const t0 = Date.now()
    try {
      const out = execFileSync(harnessGitBin(listEnv), args, {
        env: listEnv, encoding: 'utf-8', timeout: FILTER_LIST_CAP_MS,
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      })
      return { out }
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number | null }
      if (typeof err.status === 'number') return { status: err.status }
      return { error: err.code ?? err.message, ms: Date.now() - t0 }
    }
  }
  let r = once()
  // F155: a timeout that arrived before half the cap had passed is retried once.
  if ('error' in r && /ETIMEDOUT/.test(r.error) && r.ms < FILTER_LIST_CAP_MS / 2) r = once()
  if ('status' in r) {
    if (r.status !== 1 && r.status !== 128) {
      console.log(`[harness-git] the filters of ${repo} could not be listed (exit ${r.status}); they were not neutralised for this call`)
    }
    return []
  }
  if ('error' in r) {
    console.log(`[harness-git] the filters of ${repo} could not be listed (${r.error}); they were not neutralised for this call`)
    return []
  }
  const names = new Set<string>()
  for (const line of r.out.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const scope = line.slice(0, tab)
    if (scope !== 'local' && scope !== 'worktree') continue
    const m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(line.slice(tab + 1).trim())
    if (m) names.add(m[1]!)
  }
  return [...names]
}

const binCache = new Map<string, string>()
let notFoundLogged = false

/**
 * The file name to start git by. On Windows, the first `git.exe` on PATH (the key looked up
 * ignoring case; empty and relative entries skipped), so a `git.exe` planted in the child's
 * working folder is never the one that runs; `'git'` when none is found (logged once). Elsewhere
 * `'git'`: a POSIX exec does not search the working folder. Starts no process.
 */
export function harnessGitBin(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'git'
  const key = pathKeyOf(env)
  const pathValue = key === undefined ? '' : env[key] ?? ''
  const cached = binCache.get(pathValue)
  if (cached !== undefined) return cached
  let found = 'git'
  for (const entry of pathValue.split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || !(isAbsolute(dir) || win32.isAbsolute(dir))) continue
    const candidate = join(dir, 'git.exe')
    if (!existsSync(candidate)) continue
    found = candidate
    // Wave 19b (package D's measurement): <Git>\cmd\git.exe is a launcher that starts the real git as its
    // child; a cap (execFileSync's timeout) ended the launcher alone and left that git running. The real
    // one beside it, <Git>\mingw64\bin\git.exe, is started instead when it is there.
    const parent = /^(.*)[\\/]cmd[\\/]*$/i.exec(dir)
    if (parent) {
      const real = join(parent[1]!, 'mingw64', 'bin', 'git.exe')
      if (existsSync(real)) found = real
    }
    break
  }
  if (found === 'git' && !notFoundLogged) {
    notFoundLogged = true
    console.log('[harness-git] git.exe was not found on PATH; the bare name is used')
  }
  binCache.set(pathValue, found)
  return found
}
