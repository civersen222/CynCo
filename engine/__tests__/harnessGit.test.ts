/**
 * engine/harnessGit.ts (F242, directive 7): the one helper for git the harness runs in a folder a
 * contained run may have written.
 *
 * Everything happens inside one mkdtemp root. `<dir>/home` is only where a witness would be
 * written: every program this test plants writes one file there and does nothing else. Every git
 * call runs with a global config file of the test's own and no system config, so the owner's git
 * settings neither arm nor disarm anything here.
 *
 * The left-behind case plants every surface the helper answers in a repository (signed commits and
 * an `export-subst` file among them), then makes the harness's calls through the helper: the
 * contract's git reader (`gitProbe`, which passes the helper itself), the engine's sites and the
 * scripts' functions called for real, and the driver's command lines, which run in its main loop
 * (the table `HARNESS_LINES` names the site of each line). No witness may exist afterwards, and the
 * folder a planted `core.worktree` names must be unchanged. The armed control shows the same plants
 * DO fire without the helper, so an empty witness folder means something. The redirect cases do
 * the same for a `.git` that names another repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { harnessGitBin, harnessGitEnv, HARNESS_DIFF_FLAGS, isHarnessRefused, refusedGitDir } from '../harnessGit.js'
import { engineCheckout } from '../containment.js'
import { gitProbe } from '../tools/contractVerify.js'

type Env = Record<string, string | undefined>

const WIN = process.platform === 'win32'
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0

const FIXED_KEYS = [
  'core.hooksPath', 'core.fsmonitor', 'core.pager', 'core.editor', 'sequence.editor',
  'commit.gpgsign', 'tag.gpgsign', 'gpg.program', 'log.showSignature', 'gpg.ssh.program', 'gpg.x509.program',
  'gpg.ssh.allowedSignersFile', 'credential.helper',
  // Wave 19 (C4-2), added on purpose: git's own check of names Windows reads as another (and HFS's).
  'core.protectNTFS', 'core.protectHFS',
]

let dir: string
let base: Env
const savedEnv: Env = {}
// The test's own git identity and clock (deterministic hashes for the control), and its own
// global config with no system config: put in process.env too, because `gitProbe` reads it.
const PINNED_KEYS = [
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_WORK_TREE',
  // Removed for the test, so that it is the helper that sets it (a shell may already have it).
  'NoDefaultCurrentDirectoryInExePath',
]

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cynco-harness-git-')))
  const globalFile = join(dir, 'gitconfig-global')
  writeFileSync(globalFile, '')
  for (const k of PINNED_KEYS) savedEnv[k] = process.env[k]
  const pins: Env = {
    GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'harness test', GIT_AUTHOR_EMAIL: 'harness@localhost', GIT_AUTHOR_DATE: '2026-11-23T12:00:00Z',
    GIT_COMMITTER_NAME: 'harness test', GIT_COMMITTER_EMAIL: 'harness@localhost', GIT_COMMITTER_DATE: '2026-11-23T12:00:00Z',
  }
  for (const k of PINNED_KEYS) delete process.env[k]
  Object.assign(process.env, pins)
  base = { ...process.env }
})

afterAll(() => {
  for (const k of PINNED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

const posix = (p: string): string => p.replace(/\\/g, '/')

/** One git call by argv, with the helper (as a site passes it) or without it. */
function git(cwd: string, args: string[], o: { helper: boolean; repo?: boolean; env?: Env }): { status: number | null; out: string } {
  const b = o.env ?? base
  const env = o.helper ? harnessGitEnv(b, o.repo ? { repo: cwd } : {}) : b
  const file = o.helper ? harnessGitBin(env) : 'git'
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf-8', timeout: 60_000, windowsHide: true })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function ok(cwd: string, args: string[], o: { helper: boolean; repo?: boolean; env?: Env }): string {
  const r = git(cwd, args, o)
  expect(r.status, `git ${args.join(' ')} in ${cwd}: ${r.out}`).toBe(0)
  return r.out
}

/** A repository with two committed files, one of them under the `evil` attributes. */
function makeRepo(repo: string): void {
  mkdirSync(repo, { recursive: true })
  ok(repo, ['init', '-q', '-b', 'main'], { helper: false })
  writeFileSync(join(repo, 'a.txt'), 'alpha\n')
  writeFileSync(join(repo, 'b.dat'), 'bravo\n')
  writeFileSync(join(repo, '.gitattributes'), '*.dat filter=evil diff=evil\n')
  ok(repo, ['add', '-A'], { helper: false })
  ok(repo, ['commit', '-q', '-m', 'init'], { helper: false })
}

/** A script that writes `<home>/<name>` and then does `body`. */
function witnessScript(plant: string, home: string, name: string, body: string): string {
  const p = join(plant, `${name}.sh`)
  writeFileSync(p, `#!/bin/sh\necho hit > '${posix(join(home, name))}'\n${body}\n`, { mode: 0o755 })
  return `'${posix(p)}'`
}

/** A program started by argv (no shell): its path, unquoted. */
function programScript(plantDir: string, home: string, name: string): string {
  const p = join(plantDir, `${name}.sh`)
  writeFileSync(p, `#!/bin/sh\necho hit > '${posix(join(home, name))}'\nexit 1\n`, { mode: 0o755 })
  return posix(p)
}

/**
 * Two commits a run can write with its own git: one carrying an X.509 signature header and, on
 * top of it, one carrying an SSH signature header. Neither signature is valid; git still starts the
 * format's program to check it. Before them, a committed `sig.txt` under `export-subst` whose
 * `$Format:%G?$` makes `git archive` verify the signature too.
 */
function plantSignedCommits(repo: string): void {
  writeFileSync(join(repo, 'sig.txt'), '$Format:%G?$\n')
  writeFileSync(join(repo, '.gitattributes'), `${readFileSync(join(repo, '.gitattributes'), 'utf-8')}sig.txt export-subst\n`)
  ok(repo, ['add', '-A'], { helper: false })
  ok(repo, ['commit', '-q', '-m', 'export-subst'], { helper: false })
  const tree = ok(repo, ['rev-parse', 'HEAD^{tree}'], { helper: false }).trim()
  let parent = ok(repo, ['rev-parse', 'HEAD'], { helper: false }).trim()
  const signed = (kind: string, msg: string): string => {
    const body = [
      `tree ${tree}`, `parent ${parent}`,
      'author harness test <harness@localhost> 1795000000 +0000',
      'committer harness test <harness@localhost> 1795000000 +0000',
      `gpgsig -----BEGIN ${kind}-----`, ' U1NIU0lHAAAAAQ==', ` -----END ${kind}-----`,
      '', msg, '',
    ].join('\n')
    const r = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, env: base, input: body, encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  parent = signed('SIGNED MESSAGE', 'x509 signed')
  parent = signed('SSH SIGNATURE', 'ssh signed')
  ok(repo, ['update-ref', 'HEAD', parent], { helper: false })
}

/**
 * Plants every surface in `repo`'s own config and hooks folder. `worktree`, when given, is
 * planted as `core.worktree`. On Windows, `git.cmd` and `git.bat` go in the repository root.
 */
function plant(repo: string, home: string, plantDir: string, worktree?: string): void {
  mkdirSync(home, { recursive: true })
  mkdirSync(plantDir, { recursive: true })
  plantSignedCommits(repo)
  const hooks = join(repo, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  for (const h of ['post-checkout', 'pre-commit', 'post-commit', 'post-index-change']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\necho hit > '${posix(join(home, `hook-${h}`))}'\nexit 0\n`, { mode: 0o755 })
  }
  const set = (k: string, v: string) => ok(repo, ['config', k, v], { helper: false })
  set('core.fsmonitor', witnessScript(plantDir, home, 'fsmonitor', 'exit 1'))
  set('filter.evil.clean', witnessScript(plantDir, home, 'filter-clean', 'cat'))
  set('filter.evil.smudge', witnessScript(plantDir, home, 'filter-smudge', 'cat'))
  set('diff.evil.textconv', witnessScript(plantDir, home, 'textconv', 'cat "$1"'))
  set('diff.external', witnessScript(plantDir, home, 'diff-external', 'exit 0'))
  set('core.pager', witnessScript(plantDir, home, 'pager', 'cat'))
  // Signature verification: git starts the program named for the signature's format, by argv.
  set('log.showSignature', 'true')
  set('gpg.ssh.program', programScript(plantDir, home, 'ssh-program'))
  set('gpg.x509.program', programScript(plantDir, home, 'x509-program'))
  const signers = join(plantDir, 'allowed_signers')
  writeFileSync(signers, '')
  set('gpg.ssh.allowedSignersFile', posix(signers))
  if (worktree !== undefined) set('core.worktree', posix(worktree))
  if (WIN) {
    writeFileSync(join(repo, 'git.cmd'), `@echo hit> "${join(home, 'git-cmd')}"\r\n@exit /b 1\r\n`)
    writeFileSync(join(repo, 'git.bat'), `@echo hit> "${join(home, 'git-bat')}"\r\n@exit /b 1\r\n`)
  }
}

/** Changes the work tree the way a run leaves it: two tracked edits and one new file. */
function dirty(repo: string): void {
  writeFileSync(join(repo, 'a.txt'), 'alpha changed\n')
  writeFileSync(join(repo, 'b.dat'), 'bravo changed\n')
  writeFileSync(join(repo, 'c.dat'), 'charlie\n')
}

const NEW_FILE_PATCH = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+n\n'
const DIFF = [...HARNESS_DIFF_FLAGS]

/**
 * The git command lines the harness runs in a mission folder, by site (01-isolation 9.3).
 * `repo: true` where the site passes `{ repo }` (the command reads or writes work-tree content).
 * `<patch>`, `<wt>` and `<tar>` are filled in per run. The contract's git reader is not here: it
 * is called for real (`gitProbe`).
 */
const HARNESS_LINES: Array<{ site: string; args: string[]; repo: boolean }> = [
  { site: 'driver', args: ['status', '--short'], repo: true },
  { site: 'driver', args: ['status', '--porcelain', '-uno'], repo: true },
  { site: 'driver', args: ['rev-parse', 'HEAD'], repo: false },
  { site: 'driver', args: ['log', '--oneline', '-3'], repo: false },
  { site: 'driver', args: ['log', '--oneline'], repo: false },
  { site: 'campaign runner', args: ['show', '--name-only', 'HEAD'], repo: false },
  { site: 'dashboard', args: ['log', '--format=%h %s', '-3'], repo: false },
  { site: 'driver', args: ['reflog', '-3'], repo: false },
  { site: 'gitFacts', args: ['status', '--porcelain'], repo: true },
  { site: 'gitFacts', args: ['status', '--porcelain', '--untracked-files=all'], repo: true },
  { site: 'gitFacts', args: ['diff', '--numstat', 'HEAD'], repo: true },
  { site: 'gitFacts', args: ['diff', ...DIFF, '-U0', 'HEAD', '--', 'b.dat'], repo: true },
  { site: 'gitFacts', args: ['show', 'HEAD:b.dat'], repo: false },
  { site: 'gitFacts', args: ['rev-parse', '--show-toplevel'], repo: false },
  { site: 'gitFacts', args: ['rev-parse', '--is-inside-work-tree'], repo: false },
  { site: 'gitFacts', args: ['cat-file', '-t', 'HEAD'], repo: false },
  { site: 'gitFacts', args: ['log', '--name-only', '--pretty=format:%h%x20%s', '-1'], repo: false },
  { site: 'snapshot', args: ['rev-parse', '--git-common-dir'], repo: false },
  { site: 'workspace purge', args: ['ls-files', '--', 'a.txt', 'b.dat'], repo: false },
  { site: 'extractPatch', args: ['add', '-A'], repo: true },
  { site: 'extractPatch', args: ['diff', ...DIFF, '--cached', 'HEAD'], repo: true },
  { site: 'extractPatch', args: ['reset', '-q', 'HEAD'], repo: true },
  { site: 'sampler applyPatch', args: ['apply', '--check', '<patch>'], repo: true },
  { site: 'WorktreeManager.create', args: ['worktree', 'add', '--detach', '<wt>'], repo: true },
  { site: 'WorktreeManager', args: ['worktree', 'list', '--porcelain'], repo: false },
  { site: 'WorktreeManager.cleanup', args: ['worktree', 'remove', '--force', '--force', '<wt>'], repo: true },
  { site: 'archiveBase', args: ['archive', '--format=tar', '-o', '<tar>', 'HEAD'], repo: true },
  { site: 'commitStaging', args: ['add', '-A'], repo: true },
  { site: 'commitStaging', args: ['commit', '-q', '-m', 'staged by the harness'], repo: true },
  { site: 'driver', args: ['checkout', '--', '.'], repo: true },
]

/** The shell-string form (`execSync('git ...', { cwd })`, through cmd.exe on Windows). */
const SHELL_LINES = ['git status --porcelain', 'git add -A', `git diff ${DIFF.join(' ')} --cached HEAD`, 'git reset -q HEAD']

function fill(args: string[], slots: { patch: string; wt: string; tar: string }): string[] {
  return args.map(a => a === '<patch>' ? slots.patch : a === '<wt>' ? slots.wt : a === '<tar>' ? slots.tar : a)
}

/** Runs every harness line in `repo` and returns the outputs, the root normalised away. */
function runHarnessLines(root: string, repo: string, helper: boolean): string[] {
  const slots = { patch: join(root, 'new.patch'), wt: join(root, 'wt'), tar: join(root, 'base.tar') }
  writeFileSync(slots.patch, NEW_FILE_PATCH)
  const outs: string[] = []
  for (const line of HARNESS_LINES) {
    if (line.site === 'driver' && line.args[0] === 'checkout') writeFileSync(join(repo, 'a.txt'), 'alpha once more\n')
    const out = ok(repo, fill(line.args, slots), { helper, repo: line.repo })
    outs.push(`${line.site} | ${line.args.join(' ')}\n${out}`)
  }
  for (const cmd of SHELL_LINES) {
    const env = helper ? harnessGitEnv(base, { repo }) : base
    outs.push(`shell | ${cmd}\n${execSync(cmd, { cwd: repo, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })}`)
  }
  const norm = (s: string) => s.split(root).join('<root>').split(posix(root)).join('<root>')
  return outs.map(norm)
}

describe('harnessGitEnv: the shape', () => {
  it('sets the fixed pairs in order, after the plain variables', () => {
    const env = harnessGitEnv({})
    expect(env.GIT_CONFIG_COUNT).toBe(String(FIXED_KEYS.length))
    expect(FIXED_KEYS.map((_, i) => env[`GIT_CONFIG_KEY_${i}`])).toEqual(FIXED_KEYS)
    expect(FIXED_KEYS.map((_, i) => env[`GIT_CONFIG_VALUE_${i}`])).toEqual([
      `${posix(engineCheckout())}/.no-git-hooks`, 'false', 'cat', 'true', 'true', 'false', 'false', 'gpg',
      'false', 'ssh-keygen', 'gpgsm', `${posix(engineCheckout())}/.no-git-allowed-signers`, '',
      'true', 'true',
    ])
    expect(existsSync(join(engineCheckout(), '.no-git-hooks'))).toBe(false)
    expect(existsSync(join(engineCheckout(), '.no-git-allowed-signers'))).toBe(false)
    expect(env.GIT_PAGER).toBe('cat')
    expect(env.GIT_EDITOR).toBe('true')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_SSH_COMMAND).toBe('ssh')
  })

  it('continues the numbering after pairs already present, and keeps them', () => {
    const env = harnessGitEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' })
    expect(env.GIT_CONFIG_KEY_0).toBe('a.b')
    expect(env.GIT_CONFIG_KEY_1).toBe('c.d')
    expect(env.GIT_CONFIG_KEY_2).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_COUNT).toBe(String(2 + FIXED_KEYS.length))
  })

  it('keeps an ssh command the base already has', () => {
    expect(harnessGitEnv({ GIT_SSH_COMMAND: 'ssh -i key' }).GIT_SSH_COMMAND).toBe('ssh -i key')
  })

  it('stops cmd.exe looking in the current directory, on Windows only', () => {
    expect(harnessGitEnv({}).NoDefaultCurrentDirectoryInExePath).toBe(WIN ? '1' : undefined)
  })

  it('returns the keys alone for an empty base', () => {
    const env = harnessGitEnv({})
    const expected = ['GIT_PAGER', 'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT',
      ...FIXED_KEYS.flatMap((_, i) => [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`]),
      ...(WIN ? ['NoDefaultCurrentDirectoryInExePath'] : [])]
    expect(Object.keys(env).sort()).toEqual(expected.sort())
  })

  it('names the repository of a folder with its own .git, puts a ceiling over one without, and pins nothing when the base names GIT_DIR', () => {
    const plain = join(dir, 'shape-plain')
    mkdirSync(plain, { recursive: true })
    const p = harnessGitEnv({}, { repo: plain })
    expect(p.GIT_WORK_TREE).toBeUndefined()
    expect(p.GIT_DIR).toBeUndefined()
    expect(p.GIT_CEILING_DIRECTORIES).toBe(posix(realpathSync.native(dir)))
    // nested: the walk is made here; nothing above the temp folder is a repository.
    expect(harnessGitEnv({}, { repo: plain, nested: true }).GIT_CEILING_DIRECTORIES).toBeUndefined()
    const repo = join(dir, 'shape-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const r = harnessGitEnv({}, { repo })
    expect(r.GIT_WORK_TREE).toBe(posix(realpathSync.native(repo)))
    expect(r.GIT_DIR).toBe(`${posix(realpathSync.native(repo))}/.git`)
    expect(r.GIT_CEILING_DIRECTORIES).toBeUndefined()
    // A subfolder: refused-by-ceiling without nested, the repository above with it.
    const sub = join(repo, 'sub')
    mkdirSync(sub, { recursive: true })
    expect(harnessGitEnv({}, { repo: sub }).GIT_DIR).toBeUndefined()
    expect(harnessGitEnv({}, { repo: sub }).GIT_CEILING_DIRECTORIES).toBe(posix(realpathSync.native(repo)))
    expect(harnessGitEnv({}, { repo: sub, nested: true }).GIT_DIR).toBe(`${posix(realpathSync.native(repo))}/.git`)
    expect(harnessGitEnv({ GIT_DIR: join(dir, 'other.git') }, { repo }).GIT_WORK_TREE).toBeUndefined()
    expect(harnessGitEnv({ GIT_WORK_TREE: plain }, { repo }).GIT_WORK_TREE).toBe(plain)
    // No config pair names core.worktree: it would not win (the measurement below).
    const env = harnessGitEnv({}, { repo })
    const keys = Object.keys(env).filter(k => k.startsWith('GIT_CONFIG_KEY_')).map(k => env[k])
    expect(keys).not.toContain('core.worktree')
  })
})

describe('harnessGitBin', () => {
  const dirs = (): string[] => {
    const root = join(dir, `bin-${Math.random().toString(36).slice(2)}`)
    const ds = ['one', 'two', 'three'].map(n => join(root, n))
    for (const d of ds) mkdirSync(d, { recursive: true })
    return ds
  }

  it('finds git.exe in the second of three PATH entries', () => {
    const [one, two, three] = dirs()
    writeFileSync(join(two!, 'git.exe'), '')
    writeFileSync(join(three!, 'git.exe'), '')
    expect(harnessGitBin({ PATH: [one, two, three].join(';') }, 'win32')).toBe(join(two!, 'git.exe'))
    // The key is looked up ignoring case.
    expect(harnessGitBin({ Path: [one, two, three].join(';') }, 'win32')).toBe(join(two!, 'git.exe'))
  })

  it('skips a relative entry', () => {
    const [one, two] = dirs()
    writeFileSync(join(one!, 'git.exe'), '')
    writeFileSync(join(two!, 'git.exe'), '')
    const rel = relative(process.cwd(), one!)
    expect(rel === one || rel === '').toBe(false)
    expect(harnessGitBin({ PATH: ['', rel, two].join(';') }, 'win32')).toBe(join(two!, 'git.exe'))
  })

  // Package D's measurement (wave 19, scratch d gitcapprobe.txt): Git\cmd\git.exe is a launcher; a cap
  // (execFileSync's timeout) ended it alone and left the real git.exe running 3 s later; through
  // mingw64\bin\git.exe nothing was left. The paths are the host's here, so the case holds on Linux too.
  it('wave 19b: when the first git.exe on PATH is the launcher in <Git>\\cmd, the git.exe of <Git>\\mingw64\\bin is started', () => {
    const root = join(dir, `bin-${Math.random().toString(36).slice(2)}`, 'Git')
    const cmd = join(root, 'cmd')
    const real = join(root, 'mingw64', 'bin')
    const other = join(root, '..', 'other')
    for (const d of [cmd, real, other]) mkdirSync(d, { recursive: true })
    writeFileSync(join(cmd, 'git.exe'), '')
    writeFileSync(join(other, 'git.exe'), '')
    // No mingw64 git beside it: the launcher is what there is.
    expect(harnessGitBin({ PATH: [cmd, other].join(';') }, 'win32')).toBe(join(cmd, 'git.exe'))
    writeFileSync(join(real, 'git.exe'), '')
    // (A PATH value already answered is cached for the process, so each row below is a value of its own.)
    expect(harnessGitBin({ Path: [cmd, other, ''].join(';') }, 'win32')).toBe(join(real, 'git.exe'))
    expect(harnessGitBin({ PATH: [`"${cmd}"`, other].join(';') }, 'win32')).toBe(join(real, 'git.exe'))
    // A folder that is not Git's cmd is taken as it is.
    expect(harnessGitBin({ PATH: [other, cmd].join(';') }, 'win32')).toBe(join(other, 'git.exe'))
    expect(harnessGitBin({ PATH: cmd }, 'linux')).toBe('git')
  })

  it("returns 'git' off Windows and when nothing is found", () => {
    const [one, two] = dirs()
    writeFileSync(join(one!, 'git.exe'), '')
    expect(harnessGitBin({ PATH: one }, 'linux')).toBe('git')
    expect(harnessGitBin({ PATH: two }, 'win32')).toBe('git')
  })
})

describe.skipIf(!HAS_GIT)('the work-tree pin (measured)', () => {
  it('a planted core.worktree beats a command-scope core.worktree, and loses to GIT_WORK_TREE', () => {
    const root = join(dir, 'worktree-measure')
    const repo = join(root, 'repo')
    const elsewhere = join(root, 'elsewhere')
    makeRepo(repo)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'keep.txt'), 'untouched\n')
    ok(repo, ['config', 'core.worktree', posix(elsewhere)], { helper: false })
    // Without anything, and with the config form: git looks at the other folder.
    expect(ok(repo, ['status', '--porcelain'], { helper: false })).toContain('keep.txt')
    expect(ok(repo, ['-c', `core.worktree=${posix(repo)}`, 'status', '--porcelain'], { helper: false })).toContain('keep.txt')
    // With the helper: the repository's own folder, clean.
    expect(ok(repo, ['status', '--porcelain'], { helper: true, repo: true }).trim()).toBe('')
  }, 60_000)
})

/**
 * The repository a `{ repo }` call writes is the folder's own (review finding of slice S2): a run
 * can turn its `.git` into a file naming another repository, give it a `commondir`, make it or a
 * folder in it a junction, forge a linked worktree, or delete it so that git walks up. Each is
 * refused (exit 128, the other repository unchanged); the armed control shows the redirect is real.
 */
describe.skipIf(!HAS_GIT)('redirects: harness git never writes another repository', () => {
  const headOf = (repo: string): string => ok(repo, ['rev-parse', 'HEAD'], { helper: false }).trim()
  const stagedIn = (repo: string): string => ok(repo, ['diff', '--cached', '--name-only'], { helper: false }).trim()
  /** The writes a harness makes with `{ repo }`: commitStaging's add and commit, the driver's status and checkout. */
  const harnessWrites = (m: string): Array<number | null> => [
    git(m, ['add', '-A'], { helper: true, repo: true }).status,
    git(m, ['commit', '-q', '-m', 'staged by the harness'], { helper: true, repo: true }).status,
    git(m, ['status', '--porcelain'], { helper: true, repo: true }).status,
    git(m, ['checkout', '--', '.'], { helper: true, repo: true }).status,
  ]
  const mission = (root: string): string => {
    const m = join(root, 'mission')
    mkdirSync(m, { recursive: true })
    writeFileSync(join(m, 'run.txt'), 'written by the run\n')
    return m
  }
  const junction = (link: string, target: string): void => {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf-8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  }

  it('armed: without the helper, a .git file naming another repository commits into it', () => {
    const root = join(dir, 'redirect-armed')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const before = headOf(victim)
    const m = mission(root)
    writeFileSync(join(m, '.git'), `gitdir: ${posix(join(victim, '.git'))}\n`)
    ok(m, ['add', '-A'], { helper: false })
    ok(m, ['commit', '-q', '-m', 'staged by the harness'], { helper: false })
    expect(headOf(victim)).not.toBe(before)
  }, 60_000)

  it('a .git file naming another repository: every write is refused and the other repository is unchanged', () => {
    const root = join(dir, 'redirect-gitfile')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const before = headOf(victim)
    const m = mission(root)
    writeFileSync(join(m, '.git'), `gitdir: ${posix(join(victim, '.git'))}\n`)
    expect(harnessWrites(m)).toEqual([128, 128, 128, 128])
    expect(harnessGitEnv({}, { repo: m }).GIT_DIR).toBe(refusedGitDir())
    expect(headOf(victim)).toBe(before)
    expect(stagedIn(victim)).toBe('')
  }, 60_000)

  it('a commondir file in .git is refused, and so is a git init under a refused GIT_DIR', () => {
    const root = join(dir, 'redirect-commondir')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const before = headOf(victim)
    const m = mission(root)
    makeRepo(m)
    writeFileSync(join(m, '.git', 'commondir'), posix(join(victim, '.git')))
    expect(harnessWrites(m)).toEqual([128, 128, 128, 128])
    expect(headOf(victim)).toBe(before)
    expect(stagedIn(victim)).toBe('')
    const refusedEnv = harnessGitEnv(base, { repo: m })
    expect(spawnSync(harnessGitBin(refusedEnv), ['init'], { cwd: m, env: refusedEnv, encoding: 'utf-8' }).status).toBe(128)
  }, 60_000)

  it('the snapshot store (a GIT_DIR the caller names) is refused when it carries a commondir', () => {
    const root = join(dir, 'redirect-snapshot')
    const store = join(root, 'work', '.cynco-snapshots')
    mkdirSync(store, { recursive: true })
    expect(harnessGitEnv({ GIT_DIR: store, GIT_WORK_TREE: join(root, 'work') }).GIT_DIR).toBe(store)
    writeFileSync(join(store, 'commondir'), posix(join(root, 'elsewhere')))
    const env = harnessGitEnv({ GIT_DIR: store, GIT_WORK_TREE: join(root, 'work') })
    expect(env.GIT_DIR).toBe(refusedGitDir())
    expect(env.GIT_WORK_TREE).toBeUndefined()
  })

  it('no .git: git cannot walk up to the repository that contains the folder (nested may, for the indexer)', () => {
    const root = join(dir, 'redirect-walkup')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const before = headOf(victim)
    const m = join(victim, 'mission')
    mkdirSync(m)
    writeFileSync(join(m, 'run.txt'), 'written by the run\n')
    expect(harnessWrites(m)).toEqual([128, 128, 128, 128])
    expect(headOf(victim)).toBe(before)
    expect(stagedIn(victim)).toBe('')
    const nested = harnessGitEnv(base, { repo: m, nested: true })
    expect(nested.GIT_DIR).toBe(`${posix(victim)}/.git`)
    expect(spawnSync(harnessGitBin(nested), ['ls-files', '--others', '--exclude-standard'], { cwd: m, env: nested, encoding: 'utf-8' }).stdout.trim()).toBe('run.txt')
  }, 60_000)

  it('a linked worktree is named by its own administrative folder; a forged one is refused', () => {
    const root = join(dir, 'redirect-worktree')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const wt = join(root, 'wt1')
    ok(victim, ['worktree', 'add', '--detach', '-q', wt], { helper: false })
    const real = harnessGitEnv({}, { repo: wt })
    expect(real.GIT_DIR?.toLowerCase()).toBe(`${posix(victim)}/.git/worktrees/wt1`.toLowerCase())
    expect(real.GIT_WORK_TREE?.toLowerCase()).toBe(posix(wt).toLowerCase())
    expect(git(wt, ['status', '--porcelain'], { helper: true, repo: true }).status).toBe(0)
    // A run's folder whose .git names that administrative folder: it does not name the run back.
    const m = mission(root)
    writeFileSync(join(m, '.git'), `gitdir: ${posix(join(victim, '.git', 'worktrees', 'wt1'))}\n`)
    const before = headOf(victim)
    expect(harnessWrites(m)).toEqual([128, 128, 128, 128])
    expect(headOf(victim)).toBe(before)
  }, 60_000)

  it.skipIf(!WIN)('a .git that is a junction, and a refs folder that is one, are refused (Windows)', () => {
    const root = join(dir, 'redirect-junction')
    const victim = join(root, 'victim')
    makeRepo(victim)
    const before = headOf(victim)
    const m = mission(root)
    junction(join(m, '.git'), join(victim, '.git'))
    expect(harnessWrites(m)).toEqual([128, 128, 128, 128])
    expect(headOf(victim)).toBe(before)
    const m2 = join(root, 'mission2')
    makeRepo(m2)
    rmSync(join(m2, '.git', 'refs', 'heads'), { recursive: true, force: true })
    junction(join(m2, '.git', 'refs', 'heads'), join(victim, '.git', 'refs', 'heads'))
    writeFileSync(join(m2, 'more.txt'), 'more\n')
    expect(harnessWrites(m2)).toEqual([128, 128, 128, 128])
    expect(headOf(victim)).toBe(before)
  }, 60_000)
})

describe.skipIf(!HAS_GIT)('left behind: every planted surface, the harness calls through the helper', () => {
  it('the plants are armed: without the helper they fire', () => {
    const root = join(dir, 'armed')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    makeRepo(repo)
    plant(repo, home, join(root, 'plant'))
    dirty(repo)
    git(repo, ['status', '--porcelain'], { helper: false })
    git(repo, ['diff', 'HEAD'], { helper: false })
    git(repo, ['diff', '--no-ext-diff', 'HEAD'], { helper: false })
    git(repo, ['add', '-A'], { helper: false })
    git(repo, ['commit', '-q', '-m', 'armed'], { helper: false })
    writeFileSync(join(repo, 'b.dat'), 'bravo again\n')
    rmSync(join(repo, 'b.dat'))
    git(repo, ['checkout', '--', '.'], { helper: false })
    // A planted log.showSignature makes a plain log start the format's program.
    git(repo, ['log', '--oneline', '-4'], { helper: false })
    git(repo, ['archive', '--format=tar', '-o', join(root, 'armed.tar'), 'HEAD~1'], { helper: false })
    if (WIN) {
      const r = spawnSync('git status', { cwd: repo, env: base, shell: true, encoding: 'utf-8' })
      expect(r.status).not.toBe(0)
    }
    const fired = readdirSync(home).sort()
    // The pager is not here: git starts it only on a terminal, which a test has not got.
    const expected = ['diff-external', 'filter-clean', 'filter-smudge', 'fsmonitor', 'hook-post-checkout',
      'hook-post-commit', 'hook-pre-commit', 'ssh-program', 'textconv', 'x509-program']
    for (const w of expected) expect(fired, `armed witnesses: ${fired.join(', ')}`).toContain(w)
    if (WIN) expect(fired.some(w => w === 'git-bat' || w === 'git-cmd'), fired.join(', ')).toBe(true)
  }, 120_000)

  it('no witness exists after the harness calls, and the folder core.worktree names is unchanged', async () => {
    const root = join(dir, 'left-behind')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    const elsewhere = join(root, 'elsewhere')
    makeRepo(repo)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'keep.txt'), 'untouched\n')
    plant(repo, home, join(root, 'plant'), elsewhere)
    dirty(repo)

    // The contract's git reader, for real: it passes the helper itself.
    const probe = gitProbe(repo)
    const head = await probe.head()
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(await probe.isDirty('b.dat')).toBe(true)
    expect((await probe.dirtyPaths())?.sort()).toEqual(['a.txt', 'b.dat'])
    expect(await probe.changedSince(head!, 'b.dat')).toBe(false)

    const outs = runHarnessLines(root, repo, true)
    // The calls did their work in the repository's own folder.
    expect(outs.join('\n')).not.toContain('keep.txt')
    expect(readFileSync(join(repo, 'a.txt'), 'utf-8').replace(/\r\n/g, '\n')).toBe('alpha changed\n')
    expect(existsSync(join(root, 'base.tar'))).toBe(true)
    expect(ok(repo, ['log', '-1', '--pretty=%s'], { helper: true }).trim()).toBe('staged by the harness')

    expect(readdirSync(home), 'witnesses written by planted programs').toEqual([])
    expect(readdirSync(elsewhere)).toEqual(['keep.txt'])
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf-8')).toBe('untouched\n')
  }, 180_000)

  it('the engine\'s harness-git sites, called for real (S2a), leave no witness either', async () => {
    const root = join(dir, 'left-behind-sites')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    const elsewhere = join(root, 'elsewhere')
    makeRepo(repo)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'keep.txt'), 'untouched\n')
    plant(repo, home, join(root, 'plant'), elsewhere)
    dirty(repo)
    const head = ok(repo, ['rev-parse', 'HEAD'], { helper: true }).trim()

    const { collectGitFacts, collectDirtyPaths } = await import('../training/gitFacts.js')
    const { extractPatch } = await import('../bestOfN/patchExtractor.js')
    const { applyPatch } = await import('../bestOfN/sampler.js')
    const { WorktreeManager } = await import('../bestOfN/worktreeManager.js')
    const { WorkspaceSnapshot } = await import('../snapshot/snapshot.js')
    const { listProjectFiles } = await import('../index/indexer.js')

    expect(collectGitFacts(repo, head)).not.toBeNull()
    expect(collectDirtyPaths(repo)).toEqual(expect.arrayContaining(['a.txt', 'b.dat', 'c.dat']))
    writeFileSync(join(repo, 'm.py'), 'x = 1\n')
    expect(listProjectFiles(repo)).toContain('m.py')
    const patch = extractPatch(repo)
    expect(patch).toContain('diff --git a/a.txt b/a.txt')
    expect(applyPatch(repo, NEW_FILE_PATCH)).toBe(true)
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
    const wtRoot = join(root, 'wt-root')
    mkdirSync(wtRoot)
    const wt = new WorktreeManager(repo, { tmpRoot: wtRoot })
    const wtPath = await wt.create()
    expect(existsSync(join(wtPath, 'b.dat'))).toBe(true)
    wt.cleanupAll()
    const snap = new WorkspaceSnapshot(repo)
    snap.init()
    expect(snap.track()).toMatch(/^[0-9a-f]{40}$/)

    expect(readdirSync(home), 'witnesses written by planted programs').toEqual([])
    expect(readdirSync(elsewhere)).toEqual(['keep.txt'])
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf-8')).toBe('untouched\n')
  }, 180_000)

  // The scripts' functions with their own default io (01-isolation 9.3): if one of them lost its
  // `env:` or its `{ repo }`, a witness appears here. The driver's own lines run in its main loop and
  // stay in HARNESS_LINES.
  it('the scripts\' harness-git functions, called for real (S2c), leave no witness either', async () => {
    const root = join(dir, 'left-behind-scripts')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    const elsewhere = join(root, 'elsewhere')
    const out = join(root, 'out')
    makeRepo(repo)
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(out, { recursive: true })
    writeFileSync(join(elsewhere, 'keep.txt'), 'untouched\n')
    plant(repo, home, join(root, 'plant'), elsewhere)
    dirty(repo)
    mkdirSync(join(repo, 'pkg', '__pycache__'), { recursive: true })
    writeFileSync(join(repo, 'pkg', '__pycache__', 'm.pyc'), 'x')
    writeFileSync(join(repo, '.cynco-plan.md'), 'old plan\n')

    const { purgeBytecodeCaches, purgeStaleAgentState } = await import('../../scripts/cynco-workspace.mjs')
    const { snapshotUncommittedWork } = await import('../../scripts/cynco-work-snapshot.mjs')
    const { archiveBase } = await import('../../scripts/cynco-campaign-calibrate.mjs')
    const { restoreUncommittedWork } = await import('../../scripts/cynco-gate-author.mjs')
    const { runSync } = await import('../../scripts/cynco-spawn.mjs')

    expect(purgeBytecodeCaches(repo)[0]).toMatch(/^purged 1 __pycache__/)
    expect(purgeStaleAgentState(repo)[0]).toMatch(/^purged stale agent state: .cynco-plan.md/)
    const snap = snapshotUncommittedWork(repo, out, 'm1')
    expect(snap.error).toBeNull()
    expect(snap.written).toBe(true)
    const tarDir = join(root, 'archive')
    mkdirSync(tarDir)
    const io = {
      run: (cmd: string, args: string[], opts: Record<string, unknown> = {}) => runSync(cmd, args, opts),
      exists: existsSync,
      freshDir: (p: string) => mkdirSync(p, { recursive: true }),
    }
    // Its callers hand it forward-slash paths (Git Bash's tar reads `C:` as a host name).
    expect(archiveBase(posix(repo), 'HEAD', posix(tarDir), io)).toEqual({ ok: true, problems: [] })
    expect(existsSync(join(tarDir, 'a.txt'))).toBe(true)
    // restoreUncommittedWork: git apply --check, git apply, then commitStaging (add, commit).
    ok(repo, ['checkout', '--', '.'], { helper: true, repo: true })
    const said = restoreUncommittedWork({ stagingDir: repo, missionId: 'm1', io, snapshotDir: out })
    expect(said).toContain('WAS restored')
    expect(ok(repo, ['log', '-1', '--pretty=%s'], { helper: true }).trim()).toBe('restore uncommitted work from m1')

    expect(readdirSync(home), 'witnesses written by planted programs').toEqual([])
    expect(readdirSync(elsewhere)).toEqual(['keep.txt'])
  }, 180_000)
})

describe.skipIf(!HAS_GIT)('control: a clean repository answers the same with the helper as without it', () => {
  it('every harness line returns the same output', async () => {
    const results: string[][] = []
    const probes: unknown[] = []
    for (const helper of [true, false]) {
      const root = join(dir, helper ? 'control-with' : 'control-without')
      const repo = join(root, 'repo')
      makeRepo(repo)
      dirty(repo)
      results.push(runHarnessLines(root, repo, helper))
      if (helper) {
        const p = gitProbe(repo)
        probes.push([await p.head(), await p.isDirty('a.txt'), await p.dirtyPaths()])
      } else {
        probes.push([
          ok(repo, ['rev-parse', 'HEAD'], { helper: false }).trim(),
          ok(repo, ['status', '--porcelain', '--', 'a.txt'], { helper: false }).trim().length > 0,
          null,
        ])
      }
    }
    expect(results[0]).toEqual(results[1])
    expect((probes[0] as unknown[]).slice(0, 2)).toEqual((probes[1] as unknown[]).slice(0, 2))
  }, 180_000)
})

describe.skipIf(!HAS_GIT)('scope: a filter in the global config is the owner\'s own', () => {
  it('a global filter is not blanked; the same name defined by the repository is', () => {
    const root = join(dir, 'scope')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    const plantDir = join(root, 'plant')
    mkdirSync(home, { recursive: true })
    mkdirSync(plantDir, { recursive: true })
    const globalFile = join(root, 'gitconfig-global')
    writeFileSync(globalFile, `[filter "gl"]\n\tclean = ${witnessScript(plantDir, home, 'global-clean', 'cat')}\n`)
    const env: Env = { ...base, GIT_CONFIG_GLOBAL: globalFile }
    mkdirSync(repo, { recursive: true })
    ok(repo, ['init', '-q', '-b', 'main'], { helper: false, env })
    writeFileSync(join(repo, '.gitattributes'), '*.g filter=gl\n')
    writeFileSync(join(repo, 'one.g'), 'one\n')
    ok(repo, ['add', '-A'], { helper: true, repo: true, env })
    expect(readdirSync(home)).toEqual(['global-clean'])

    rmSync(join(home, 'global-clean'))
    ok(repo, ['config', 'filter.gl.clean', witnessScript(plantDir, home, 'local-clean', 'cat')], { helper: false, env })
    writeFileSync(join(repo, 'two.g'), 'two\n')
    ok(repo, ['add', '-A'], { helper: true, repo: true, env })
    expect(readdirSync(home)).toEqual([])
  }, 60_000)
})

describe.skipIf(!HAS_GIT || !WIN)('a git planted in the folder (Windows)', () => {
  it('a shell-string git does not run git.cmd or git.bat from the working folder', () => {
    expect(base.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
    const root = join(dir, 'planted-bin')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    makeRepo(repo)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(repo, 'git.cmd'), `@echo hit> "${join(home, 'git-cmd')}"\r\n@exit /b 1\r\n`)
    writeFileSync(join(repo, 'git.bat'), `@echo hit> "${join(home, 'git-bat')}"\r\n@exit /b 1\r\n`)
    const out = execSync('git rev-parse --is-inside-work-tree', { cwd: repo, env: harnessGitEnv(base), encoding: 'utf-8' })
    expect(out.trim()).toBe('true')
    expect(readdirSync(home)).toEqual([])
  }, 60_000)

  it('the argv form names the real git.exe by its full path', () => {
    const bin = harnessGitBin()
    expect(bin.toLowerCase().endsWith('git.exe')).toBe(true)
    expect(spawnSync(bin, ['--version'], { encoding: 'utf-8' }).status).toBe(0)
  })
})

/**
 * NOW.md:76 (F6): git takes a junction in the work tree for a folder, so a harness `checkout -- .`
 * writes through one and an `add` copies what is behind one. With `worktreeLinks` the work tree is
 * walked first and a link leading out of it refuses the call; the armed control shows the write is real.
 */
describe.skipIf(!HAS_GIT || !WIN)('worktreeLinks: harness git refuses a work tree holding a link that leads out (Windows junctions)', () => {
  const junction = (link: string, target: string): void => {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf-8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  }
  /** A repository whose committed `vendor/x.txt` the run replaced with a junction to `outside`. */
  const setUp = (name: string): { repo: string; outside: string } => {
    const root = join(dir, name)
    const repo = join(root, 'repo')
    const outside = join(root, 'outside')
    makeRepo(repo)
    mkdirSync(join(repo, 'vendor'))
    writeFileSync(join(repo, 'vendor', 'x.txt'), 'committed\n')
    ok(repo, ['add', '-A'], { helper: false })
    ok(repo, ['commit', '-q', '-m', 'vendor'], { helper: false })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'x.txt'), 'the owner\'s file\n')
    rmSync(join(repo, 'vendor'), { recursive: true })
    junction(join(repo, 'vendor'), outside)
    return { repo, outside }
  }

  it('armed: without the option, a harness checkout -- . writes through the junction into the folder it points at', () => {
    const { repo, outside } = setUp('wtlinks-armed')
    const env = harnessGitEnv(base, { repo })
    expect(env.GIT_DIR).toBe(`${posix(repo)}/.git`)
    const r = spawnSync(harnessGitBin(env), ['checkout', '--', '.'], { cwd: repo, env, encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(outside, 'x.txt'), 'utf-8')).toBe('committed\n')
  }, 60_000)

  it('with worktreeLinks the call is refused (exit 128), said once, and the folder behind the junction is unchanged', () => {
    const { repo, outside } = setUp('wtlinks-refused')
    const lines: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    let env: Env
    try {
      env = harnessGitEnv(base, { repo, worktreeLinks: true })
    } finally {
      console.log = log
    }
    expect(env.GIT_DIR).toBe(refusedGitDir())
    expect(env.GIT_WORK_TREE).toBeUndefined()
    const real = realpathSync.native(repo)
    expect(lines).toEqual([`[harness-git] git refused in ${real}: ${join(real, 'vendor')} leads outside ${real} (to ${realpathSync.native(outside)})`])
    const r = spawnSync(harnessGitBin(env), ['checkout', '--', '.'], { cwd: repo, env, encoding: 'utf-8' })
    expect(r.status).toBe(128)
    expect(readFileSync(join(outside, 'x.txt'), 'utf-8')).toBe('the owner\'s file\n')
  }, 60_000)

  it('a junction that stays inside the work tree is allowed, and a work tree with no link answers as without the option', () => {
    const root = join(dir, 'wtlinks-inside')
    const repo = join(root, 'repo')
    makeRepo(repo)
    expect(harnessGitEnv(base, { repo, worktreeLinks: true }).GIT_DIR).toBe(`${posix(repo)}/.git`)
    mkdirSync(join(repo, 'packages', 'a'), { recursive: true })
    junction(join(repo, 'linked-a'), join(repo, 'packages', 'a'))
    const env = harnessGitEnv(base, { repo, worktreeLinks: true })
    expect(env.GIT_DIR).toBe(`${posix(repo)}/.git`)
    expect(env.GIT_WORK_TREE).toBe(posix(repo))
  }, 60_000)
})

// B3 (wave 19): harness git refuses by naming a GIT_DIR git cannot open, and a git command that also runs
// outside a repository does not need one: `git apply` applied a patch under it (measured by the
// harness-children builder; again 2026-11-25, w19 scratch b out/b3-measure.txt: apply, apply --check,
// diff --no-index and hash-object all ran). A command-scope count git cannot parse stops every one of
// them before it reads anything (exit 128, `bogus count in GIT_CONFIG_COUNT`).
describe.skipIf(!HAS_GIT)('B3: the refusal is one every git command obeys', () => {
  /** A folder whose `.git` is a file that names no repository: harness git refuses it. */
  const refusedFolder = (name: string): string => {
    const m = join(dir, name)
    mkdirSync(m, { recursive: true })
    writeFileSync(join(m, '.git'), 'not a gitdir line\n')
    writeFileSync(join(m, 'a.txt'), 'one\n')
    writeFileSync(join(m, 'b.txt'), 'two\n')
    return m
  }
  const PATCH = 'diff --git a/created.txt b/created.txt\nnew file mode 100644\n--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+made by apply\n'

  it('isHarnessRefused tells a refused environment from an ordinary one, and a refusal survives a second pass of the helper', () => {
    const m = refusedFolder('b3-shape')
    const refused = harnessGitEnv(base, { repo: m })
    expect(isHarnessRefused(refused)).toBe(true)
    expect(isHarnessRefused(harnessGitEnv(base))).toBe(false)
    expect(isHarnessRefused(base)).toBe(false)
    // A site that hands a refused environment to the helper again (or lays its keys over another) stays refused.
    expect(isHarnessRefused(harnessGitEnv(refused))).toBe(true)
    // ...unchanged: the helper adds no pairs to a refusal (they would number the count git cannot parse).
    expect(harnessGitEnv(refused)).toEqual(refused)
    expect(isHarnessRefused({ ...base, ...harnessGitEnv({}, { repo: m }) })).toBe(true)
  })

  it('git apply, apply --check, diff --no-index and hash-object under a refused environment run nothing and write nothing', () => {
    const m = refusedFolder('b3-run')
    const env = harnessGitEnv(base, { repo: m })
    for (const args of [['apply', '--check', '-'], ['apply', '-'], ['diff', '--no-index', ...HARNESS_DIFF_FLAGS, 'a.txt', 'b.txt'], ['hash-object', 'a.txt']]) {
      const r = spawnSync(harnessGitBin(env), args, { cwd: m, env, input: PATCH, encoding: 'utf-8', timeout: 60_000, windowsHide: true })
      expect(r.status, `git ${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(128)
      expect(r.stdout, args.join(' ')).toBe('')
      expect(existsSync(join(m, 'created.txt')), args.join(' ')).toBe(false)
    }
  }, 60_000)
})

// C4-2 (wave 19, from the harness-children check): the fixed pairs pin core.protectNTFS, so a mission
// repository's own `core.protectNTFS=false` cannot turn git's Windows name check off for a harness call.
// Measured 2026-11-25 (out/b3-measure.txt): with the repository's false, `git apply` of `out./x.txt`
// wrote x.txt through the junction `out` (Win32 reads `out.` as `out`); with the pin it answered
// `invalid path 'out./x.txt'`, exit 128. core.protectHFS is pinned beside it: it refuses only names that
// HFS+ reads as `.git`, which no honest repository holds, and costs nothing here.
describe.skipIf(!HAS_GIT || !WIN)('C4-2: core.protectNTFS is pinned for every harness call', () => {
  it('a harness git apply of out./x.txt beside a junction out writes nothing through it, whatever the repository says', () => {
    const root = join(dir, 'c4-2')
    const repo = join(root, 'repo')
    const outside = join(root, 'outside')
    makeRepo(repo)
    mkdirSync(outside, { recursive: true })
    ok(repo, ['config', 'core.protectNTFS', 'false'], { helper: false })
    const r0 = spawnSync('cmd', ['/c', 'mklink', '/J', join(repo, 'out'), outside], { encoding: 'utf-8' })
    expect(r0.status, r0.stdout + r0.stderr).toBe(0)
    try {
      const patch = 'diff --git a/out./x.txt b/out./x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/out./x.txt\n@@ -0,0 +1 @@\n+through the junction\n'
      const env = harnessGitEnv(base, { repo })
      expect(env.GIT_DIR).toBe(`${posix(repo)}/.git`)
      const r = spawnSync(harnessGitBin(env), ['apply', '-'], { cwd: repo, env, input: patch, encoding: 'utf-8', timeout: 60_000, windowsHide: true })
      expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0)
      expect(r.stderr).toContain("invalid path 'out./x.txt'")
      expect(readdirSync(outside)).toEqual([])
    } finally {
      spawnSync('cmd', ['/c', 'rmdir', join(repo, 'out')], { encoding: 'utf-8' })
    }
  }, 60_000)
})
