/**
 * engine/containment.ts (F242): the run context, the environment builder, the command the
 * launcher is started with, the switch, the sandbox life cycle and every refusal by its text.
 *
 * Every test works inside its own mkdtemp folder and names every folder it uses: the sandbox
 * root, a fake home, the mission folder, CynCo's state, models and guard folders. Nothing here
 * runs icacls, whoami or PowerShell for real: a `run` seam answers for them and records the
 * calls. Windows-only behaviour is driven with `platform: 'win32'` and the seam, so it runs on
 * every system; vitest's Node has no launcher, so a Windows establish here is a test context
 * with `lowil` switched off (the probe needs Bun and lives in the launcher fixture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acknowledgedVolumes, adoptContainment, containedCommand, containedPathValue, containmentHint, containmentOff,
  containmentRecords, containmentSwitch, engineCheckout, establishContainment, harnessChildCwd, launcherFaultOf,
  LAUNCHER_UNAVAILABLE, listUnprotectedVolumes, mintRunId, RULE_M_MAX_ENTRIES, MSYS_IN_CONTAINED_RUN, NO_CONTAINMENT, operatorRefusal, readInheritanceOff,
  containmentFromRecord, GIT_HOLDER_RETRY_MS, gitNamespaceHolder, holdGitNamespace, installedGitRoot, MSYS_WITH_COPY, releaseGitNamespace,
  refusalLayerOf, refusalPrefix, refusalText, releaseContainment, releaseInProgress, restoreKeptGrants, runContainment, SANDBOX_SET_BACK_BUDGET, setRunContainment,
  sweepSandboxes, SWITCH_IN_UNATTENDED, testContainment, toolEnv, toolSpawnRefusal,
  type ContainmentRecord, type ContainmentRunner, type RunContainment,
} from '../containment.js'
import { RUN_ID_RE } from '../missionEnv.js'
import { auditDir, cyncoHome, guardDir } from '../paths.js'
import { isLinkEntry, listEntries, whyNotAtOwnPath, type EntryKind } from '../realPath.js'
import { removeLinkEntry } from './helpers/linkEntry.js'

/**
 * The walks take an entry's kind from the folder's listing (`listEntries`, `isLinkEntry`). A case
 * that needs the listing to disagree with lstat (what a junction made at low integrity does, F4)
 * without such a junction sets one of these; by default both answer what the real ones answer.
 */
const listing = vi.hoisted(() => ({
  entries: null as null | ((dir: string, real: (d: string) => Array<{ name: string; kind: EntryKind }>) => Array<{ name: string; kind: EntryKind }>),
  isLink: null as null | ((p: string, real: (p: string) => boolean | null) => boolean | null),
  /** Answers the real-path check (`whyNotAtOwnPath`), e.g. to stand for a swap between two of its calls. */
  whyNot: null as null | ((parentReal: string, name: string, real: (parentReal: string, name: string) => string | null) => string | null),
}))
vi.mock('../realPath.js', async importOriginal => {
  const real = await importOriginal<typeof import('../realPath.js')>()
  return {
    ...real,
    listEntries: (d: string) => (listing.entries ? listing.entries(d, real.listEntries) : real.listEntries(d)),
    isLinkEntry: (p: string) => (listing.isLink ? listing.isLink(p, real.isLinkEntry) : real.isLinkEntry(p)),
    whyNotAtOwnPath: (r: string, n: string) => (listing.whyNot ? listing.whyNot(r, n, real.whyNotAtOwnPath) : real.whyNotAtOwnPath(r, n)),
  }
})

/**
 * P2-B10: the working folder this module's own synchronous children are started in. Every call goes
 * through to the real `spawnSync`; while `on` is set, the program and its `cwd` are recorded.
 */
const spawned = vi.hoisted(() => ({ on: false, calls: [] as Array<{ file: string; cwd: unknown }> }))
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawnSync = ((...a: unknown[]) => {
    if (spawned.on) spawned.calls.push({ file: String(a[0]), cwd: (Array.isArray(a[1]) ? a[2] as { cwd?: unknown } | undefined : a[1] as { cwd?: unknown } | undefined)?.cwd })
    return (real.spawnSync as (...x: unknown[]) => unknown)(...a)
  }) as typeof real.spawnSync
  return { ...real, spawnSync }
})

const ENV_KEYS = ['LOCALCODE_CONTAINMENT_OFF', 'LOCALCODE_UNPROTECTED_VOLUMES_OK', 'LOCALCODE_MISSION_MARKER', 'LOCALCODE_CONTAINMENT_MSYS']

let dir: string
let L: { root: string; home: string; mission: string; extra: string; state: string; models: string; guard: string; outside: string }
let folders: RunContainment['folders']
let links: string[]

/** A junction on Windows; elsewhere the type is ignored and a symbolic link is made. A case removes it with `removeLinkEntry`. */
function link(target: string, at: string): void {
  symlinkSync(target, at, 'junction')
  links.push(at)
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cynco-containment-')))
  L = {
    root: join(dir, 'root'), home: join(dir, 'home'), mission: join(dir, 'mission'), extra: join(dir, 'extra'),
    state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), outside: join(dir, 'outside'),
  }
  for (const p of Object.values(L)) mkdirSync(p)
  mkdirSync(join(L.mission, '.git'))
  writeFileSync(join(L.mission, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  folders = { state: L.state, models: L.models, guard: L.guard, audit: null }
  links = []
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  setRunContainment(null)
  for (const k of ENV_KEYS) delete process.env[k]
  vi.restoreAllMocks()
  listing.entries = null
  listing.isLink = null
  listing.whyNot = null
  // The links this test made are removed as entries first, so the clean-up below never walks one.
  // A link that could not be removed is named: the recursive remove below then meets it.
  for (const l of links) {
    try {
      rmdirSync(l)
    } catch (asFolder) {
      try {
        unlinkSync(l)
      } catch (asFile) {
        if ((asFile as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.log(`[containment] the clean-up could not remove the link ${l} (rmdir: ${(asFolder as Error).message}; unlink: ${(asFile as Error).message})`)
        }
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A context over this test's folders (nothing on disk is created by testContainment). */
function ctxOf(over: Partial<Parameters<typeof testContainment>[0]> = {}): RunContainment {
  const runDir = join(L.root, 'run')
  return testContainment({
    missionCwd: L.mission,
    sandbox: { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') },
    home: L.home, folders, ...over,
  })
}

const exeOf = (file: string) => basename(file.replace(/\\/g, '/')).toLowerCase()

interface Call { file: string; args: string[] }
function seam(o: {
  volumes?: string | null; level?: string; homeLow?: boolean
  icacls?: (args: string[], calls: Call[]) => { ok: boolean; out: string } | undefined
  /** Answers a one-argument `icacls <path>` (a label read) before the default. */
  read?: (path: string) => { ok: boolean; out: string } | undefined
  before?: (c: Call) => void
  first?: { ok: boolean; out: string; code: number | null }
  /** Answers the access-list restore's PowerShell call (default: it says it restored). */
  ps?: (args: string[]) => { ok: boolean; out: string } | undefined
  /** Answers the establish's read of inheritance (P2-F6; default: the walk finished and found nothing). */
  inherit?: (args: string[]) => { ok: boolean; out: string } | undefined
} = {}) {
  const calls: Call[] = []
  let n = 0
  const run: ContainmentRunner = (file, args) => {
    const c = { file, args: [...args] }
    calls.push(c)
    o.before?.(c)
    if (n++ === 0 && o.first) return o.first
    const exe = exeOf(file)
    if (exe === 'whoami.exe') {
      if (args[0] === '/groups') return { ok: true, out: `"Mandatory Label\\X Mandatory Level","Label","${o.level ?? 'S-1-16-8192'}",""\r\n`, code: 0 }
      return { ok: true, out: '"pc\\owner","S-1-5-21-11-22-33-1001"\r\n', code: 0 }
    }
    if (exe === 'powershell.exe') {
      // The access-list restore of a release (R1 F1).
      if (String(args.at(-1)).includes('SetAccessControl')) {
        const answer = o.ps?.(args)
        return answer ? { ...answer, code: answer.ok ? 0 : 1 } : { ok: true, out: 'cynco-acl-restored\r\n', code: 0 }
      }
      // The establish's read of which entries already had inheritance off (P2-F6).
      if (String(args.at(-1)).includes('cynco-inheritance-read|')) {
        const answer = o.inherit?.(args)
        return answer ? { ...answer, code: answer.ok ? 0 : 1 } : { ok: true, out: 'cynco-inheritance-read|0\r\n', code: 0 }
      }
      if (o.volumes === null) return { ok: false, out: 'Get-CimInstance : Access denied', code: 1 }
      return { ok: true, out: o.volumes ?? 'C:|3|NTFS\r\n', code: 0 }
    }
    if (exe === 'icacls.exe') {
      if (args.length === 1) {
        const answer = o.read?.(args[0])
        if (answer) return { ...answer, code: answer.ok ? 0 : 5 }
        const label = o.homeLow ? '\r\n         Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)' : ''
        return { ok: true, out: `${args[0]} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)${label}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, code: 0 }
      }
      const custom = o.icacls?.(args, calls)
      if (custom) return { ...custom, code: custom.ok ? 0 : 5 }
      return { ok: true, out: `processed file: ${args[0]}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, code: 0 }
    }
    return { ok: false, out: `unexpected program ${file}`, code: 1 }
  }
  const icacls = () => calls.filter(c => exeOf(c.file) === 'icacls.exe' && c.args.length > 1)
  const labels = (level: 'L' | 'M') => icacls().filter(c => c.args[1] === '/setintegritylevel' && c.args[2] === `(OI)(CI)${level}`).map(c => c.args[0])
  // Since 2026-11-24 a release also sets the sandbox's home, tmp and scratch back to medium (NOW.md:78):
  // `work` is what `labels` was before, the folders the run worked in (everything outside the sandbox root).
  const work = (level: 'L' | 'M') => labels(level).filter(p => !fold(p).startsWith(`${fold(L.root)}/`))
  const sandboxM = () => labels('M').filter(p => fold(p).startsWith(`${fold(L.root)}/`))
  return { run, calls, icacls, labels, work, sandboxM }
}

function base(over: Partial<Parameters<typeof establishContainment>[0]> = {}): Parameters<typeof establishContainment>[0] {
  return { kind: 'mission', label: 'unit', missionCwd: L.mission, sandboxRoot: L.root, home: L.home, folders, platform: 'linux', ...over }
}

/** A Windows establish under vitest's Node: a test context with the launcher layer switched off. */
function winBase(run: ContainmentRunner, over: Partial<Parameters<typeof establishContainment>[0]> = {}) {
  process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
  return base({ platform: 'win32', test: true, run, ...over })
}

function refusal(r: ReturnType<typeof establishContainment> | ReturnType<typeof adoptContainment>): string {
  expect(r.ok, 'expected a refusal').toBe(false)
  return (r as { ok: false; reason: string }).reason
}

function established(r: ReturnType<typeof establishContainment>): RunContainment {
  if (!r.ok) throw new Error(`establish refused: ${r.reason}`)
  return r.containment
}

function recPath(runId: string): string {
  return join(L.root, runId, 'containment.json')
}
function readRec(runId: string): ContainmentRecord {
  return JSON.parse(readFileSync(recPath(runId), 'utf-8')) as ContainmentRecord
}
function editRec(runId: string, fn: (r: ContainmentRecord) => void): void {
  const r = readRec(runId)
  fn(r)
  writeFileSync(recPath(runId), JSON.stringify(r, null, 2))
}

const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/')

// ─── The refusal format ─────────────────────────────────────────────────────────────────────────

describe('the refusal format', () => {
  it('prefix, text and the layer read back', () => {
    expect(refusalPrefix('containment')).toBe('Refused [containment]:')
    const t = refusalText('containment', 'a reason')
    expect(t.startsWith('Refused [containment]: a reason. The command was not run')).toBe(true)
    expect(refusalLayerOf(t)).toBe('containment')
    expect(refusalLayerOf(refusalText('protected path', 'x', 'Nothing was run.'))).toBe('protected path')
    expect(refusalLayerOf(refusalText('audit', 'x'))).toBe('audit')
    expect(refusalLayerOf(refusalText('integrity', 'x'))).toBe('integrity')
    expect(refusalLayerOf('Error: something else')).toBeNull()
  })

  it('the operator line', () => {
    expect(operatorRefusal('[sandbox]', 'containment', 'why', 'run')).toBe('[sandbox] REFUSED: containment: why — nothing was run')
    expect(operatorRefusal('[driver]', 'audit', 'why', 'dispatched')).toBe('[driver] REFUSED: audit: why — nothing was dispatched')
  })
})

// ─── toolEnv ────────────────────────────────────────────────────────────────────────────────────

describe('toolEnv', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    LOCALCODE_MISSION_CHECK: 'python gate.py', LOCALCODE_MISSION_MARKER: 'm', LOCALCODE_MISSION_CWD: 'C:/r', LOCALCODE_MISSION_BASE: 'abc',
    CYNCO_MARKER_CHECK: 'CHK=1 python g.py', CYNCO_MARKER_CHECK_TIMEOUT_MS: '1800000', CYNCO_MISSION_ALSO_LABEL: 'C:/base',
    CYNCO_BASH_TIMEOUT_MS: '300000', LOCALCODE_APPROVE_ALL: 'true',
    LOCALCODE_MODELS_DIR: 'C:/m', LOCALCODE_SANDBOX_ROOT: 'C:/s', GH_TOKEN: 'secret', HOME: '/home/owner', USERPROFILE: 'C:\\Users\\owner',
  }

  it('with no context: the harness keys go, the rest stays, UTF-8 forced', () => {
    const env = toolEnv(baseEnv, null, 'linux')
    expect(Object.keys(env).filter(k => k.startsWith('LOCALCODE_MISSION_') || k.startsWith('CYNCO_MARKER_CHECK'))).toEqual([])
    expect(env.CYNCO_MISSION_ALSO_LABEL).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LOCALCODE_APPROVE_ALL).toBe('true')
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PYTHONUTF8).toBe('1')
    for (const k of ['LOCALCODE_MODELS_DIR', 'LOCALCODE_SANDBOX_ROOT', 'GH_TOKEN', 'HOME', 'USERPROFILE'] as const) expect(env[k]).toBe(baseEnv[k])
  })

  it('with a context on win32: every overlaid key, one spelling each, secrets and containment keys gone', () => {
    const ctx = ctxOf()
    const env = toolEnv({
      ...baseEnv, Path: 'C:\\Windows', Temp: 'C:\\Users\\owner\\AppData\\Local\\Temp', UserProfile: 'C:\\Users\\owner',
      APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
      CYNCO_NTFY_TOKEN: 't', GITHUB_TOKEN: 't', LOCALCODE_API_KEY: 'k', LOCALCODE_GUARD_DIR: 'g', LOCALCODE_AUDIT_DIR: 'a',
      LOCALCODE_CONTAINMENT_OFF: 'lowil', LOCALCODE_UNPROTECTED_VOLUMES_OK: 'D:',
    }, ctx, 'win32')
    const sb = ctx.sandbox
    expect(env.HOME).toBe(sb.home)
    expect(env.USERPROFILE).toBe(sb.home)
    expect(env.TEMP).toBe(sb.tmp)
    expect(env.TMP).toBe(sb.tmp)
    expect(env.TMPDIR).toBe(sb.tmp)
    expect(env.CYNCO_SCRATCH).toBe(sb.scratch)
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(sb.home, '.gitconfig'))
    expect(env.APPDATA).toBe(join(sb.home, 'AppData', 'Roaming'))
    expect(env.LOCALAPPDATA).toBe(join(sb.home, 'AppData', 'Local'))
    if (/^[A-Za-z]:/.test(sb.home)) {
      expect(env.HOMEDRIVE).toBe(sb.home.slice(0, 2))
      expect(fold(`${env.HOMEDRIVE}${env.HOMEPATH}`)).toBe(fold(sb.home))
    }
    expect(env.PYTHONUSERBASE).toBe(join('C:\\Users\\owner\\AppData\\Roaming', 'Python'))
    expect(fold(env.PYTHONUSERBASE!).startsWith(fold(sb.root))).toBe(false)
    expect(Object.keys(env).filter(k => k.toUpperCase() === 'TEMP')).toEqual(['TEMP'])
    expect(Object.keys(env).filter(k => k.toUpperCase() === 'USERPROFILE')).toEqual(['USERPROFILE'])
    expect(env.Path).toBe('C:\\Windows')
    for (const k of ['CYNCO_NTFY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'LOCALCODE_API_KEY', 'LOCALCODE_SANDBOX_ROOT', 'LOCALCODE_GUARD_DIR',
      'LOCALCODE_AUDIT_DIR', 'LOCALCODE_MODELS_DIR', 'LOCALCODE_CONTAINMENT_OFF', 'LOCALCODE_UNPROTECTED_VOLUMES_OK', 'CYNCO_MISSION_ALSO_LABEL']) {
      expect(env[k], k).toBeUndefined()
    }
  })

  // NOW.md:96: the OneDrive* variables named the real profile's OneDrive folder.
  it('with a context on win32: every OneDrive* variable names the sandbox home\'s OneDrive; none is added', () => {
    const ctx = ctxOf()
    const env = toolEnv({
      OneDrive: 'C:\\Users\\owner\\OneDrive', OneDriveConsumer: 'C:\\Users\\owner\\OneDrive',
      OneDriveCommercial: 'C:\\Users\\owner\\OneDrive - Org', ONEDRIVE_EXTRA: 'C:\\Users\\owner\\x',
    }, ctx, 'win32')
    const to = join(ctx.sandbox.home, 'OneDrive')
    expect(env.OneDrive).toBe(to)
    expect(env.OneDriveConsumer).toBe(to)
    expect(env.OneDriveCommercial).toBe(to)
    expect(env.ONEDRIVE_EXTRA).toBe(to)
    expect(Object.keys(toolEnv({}, ctx, 'win32')).filter(k => /^onedrive/i.test(k))).toEqual([])
    // No context, or not Windows: as they were.
    expect(toolEnv({ OneDrive: 'C:\\Users\\owner\\OneDrive' }, null, 'win32').OneDrive).toBe('C:\\Users\\owner\\OneDrive')
    expect(toolEnv({ OneDrive: '/home/owner/OneDrive' }, ctx, 'linux').OneDrive).toBe('/home/owner/OneDrive')
  })

  // R1 F2 / NOW.md:104: under a Git Bash starter, Git's usr\bin came first, so a bare whoami or
  // find started msys's copy. Windows' System32 now comes ahead of it; nothing is removed.
  it('containedPathValue: System32 and its WindowsPowerShell folder ahead of Git\'s Unix folders (table)', () => {
    const G = 'C:\\Program Files\\Git'
    const rows: Array<{ name: string; in: string; out: string; o?: { systemRoot?: string; first?: string[] } }> = [
      { name: 'no Unix folder: unchanged', in: 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd', out: 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd' },
      { name: 'empty', in: '', out: '' },
      {
        name: 'Git Bash order: the two move to just before usr\\local\\bin, spelling kept, others stay in order',
        in: `C:\\Users\\o\\bin;${G}\\mingw64\\bin;${G}\\usr\\local\\bin;${G}\\usr\\bin;${G}\\usr\\bin;C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\;${G}\\cmd`,
        out: `C:\\Users\\o\\bin;${G}\\mingw64\\bin;C:\\Windows\\system32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\;${G}\\usr\\local\\bin;${G}\\usr\\bin;${G}\\usr\\bin;C:\\Windows;C:\\Windows\\System32\\Wbem;${G}\\cmd`,
      },
      { name: 'already ahead: unchanged', in: `C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${G}\\usr\\bin`, out: `C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${G}\\usr\\bin` },
      {
        name: 'one ahead, a duplicate after: the duplicate moves too, nothing removed',
        in: `C:\\Windows\\System32;${G}\\usr\\bin;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;c:/windows/system32/`,
        out: `C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;c:/windows/system32/;${G}\\usr\\bin`,
      },
      { name: 'neither present, a Unix folder is: both put before it', in: `C:\\tools;${G}\\usr\\bin`, out: `C:\\tools;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${G}\\usr\\bin` },
      { name: 'the bare POSIX form counts as a Unix folder', in: '/usr/bin;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', out: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;/usr/bin' },
      { name: 'a quoted entry is compared without its quotes', in: `"${G}\\usr\\bin";"C:\\Windows\\System32";C:\\Windows\\System32\\WindowsPowerShell\\v1.0`, out: `"C:\\Windows\\System32";C:\\Windows\\System32\\WindowsPowerShell\\v1.0;"${G}\\usr\\bin"` },
      { name: 'another SystemRoot', in: `${G}\\usr\\bin;D:\\Win\\System32;D:\\Win\\System32\\WindowsPowerShell\\v1.0`, out: `D:\\Win\\System32;D:\\Win\\System32\\WindowsPowerShell\\v1.0;${G}\\usr\\bin`, o: { systemRoot: 'D:\\Win\\' } },
      { name: 'a folder ending in usr but not usr\\bin is not a Unix folder', in: 'C:\\usr;C:\\Windows\\System32', out: 'C:\\usr;C:\\Windows\\System32' },
      {
        name: 'first: folders put ahead of everything (the hook for a private Unix runtime)',
        in: `${G}\\usr\\bin;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0`,
        out: `C:\\private\\usr\\bin;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${G}\\usr\\bin`,
        o: { first: ['C:\\private\\usr\\bin', ''] },
      },
    ]
    for (const r of rows) {
      const got = containedPathValue(r.in, r.o)
      expect(got, r.name).toBe(r.out)
      // Nothing removed: every entry of the input is still there, as many times (apart from additions).
      const count = (s: string) => s.split(';').reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map<string, number>())
      const before = count(r.in), after = count(got)
      for (const [e, n] of before) expect(after.get(e) ?? 0, `${r.name}: ${e}`).toBe(n)
    }
  })

  // Changed on purpose (P2-F5, decided by the lead in wave 15b): toolEnv reordered the PATH with
  // containedPathValue, which made a bare `bash` under the dispatch's Git Bash PATH start
  // System32\bash.exe, the WSL launcher. The reorder is out as the default: a contained child's PATH is
  // the PATH it was given, as on 222a0b5e, under every spelling of its key (P2-F7: two spellings were
  // possible, and only the first was reordered). containedPathValue stays, tested above, for a later switch.
  it('with a context on win32: toolEnv leaves the PATH as it was given, under every spelling of its key', () => {
    const ctx = ctxOf()
    const p = 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\system32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\'
    const env = toolEnv({ Path: p, SystemRoot: 'C:\\Windows' }, ctx, 'win32')
    expect(env.Path).toBe(p)
    expect(Object.keys(env).filter(k => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    const two = toolEnv({ Path: p, PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\other' }, ctx, 'win32')
    expect([two.Path, two.PATH]).toEqual([p, 'C:\\Program Files\\Git\\usr\\bin;C:\\other'])
    expect(toolEnv({ Path: p }, null, 'win32').Path).toBe(p)
    expect(toolEnv({ PATH: '/usr/bin:/bin' }, ctx, 'linux').PATH).toBe('/usr/bin:/bin')
  })

  // B2 (wave 19): a run started from a tool shell handed its children that shell's session variables (a
  // messaging token and socket, session and account identifiers, an ask-pass program, an API base
  // address; names only were read). A contained child no longer inherits a variable whose NAME says
  // credential or session; the cache and home levers the owner was promised still pass.
  it('B2: with a context, no variable whose name says credential or session reaches a child; the levers and ordinary names do (table)', () => {
    const ctx = ctxOf()
    const out = [
      // The shapes found in a tool shell's environment (spelled here without any product's name).
      'TOOL_HOST_MESSAGING_TOKEN', 'TOOL_HOST_MESSAGING_SOCKET', 'TOOL_HOST_SESSION_ID', 'TOOL_HOST_CHILD_SESSION', 'TOOL_SESSION_ATTENDED',
      // TOOL_API_BASE_URL left this list on purpose in wave 19b: an address is not a credential (the case below).
      'TOOL_ACCOUNT_UUID', 'TOOL_ORGANIZATION_UUID', 'TOOL_USER_EMAIL', 'USE_LOCAL_OAUTH', 'TOOL_HAS_HOST_AUTH_REFRESH',
      // Credentials as tools name them.
      'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN', 'NPM_TOKEN', 'AWS_SESSION_TOKEN', 'NPM_CONFIG__AUTHTOKEN', 'npm_config__authToken', 'NPM_CONFIG__AUTH',
      'CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'PROVIDER_API_KEY', 'LOCALCODE_API_KEY', 'SERVICE_APIKEY', 'DEPLOY_PRIVATE_KEY', 'SSH_KEY',
      'PGPASSWORD', 'DB_PASSWORD', 'REDIS_PASS', 'GPG_PASSPHRASE', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO',
      'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SHARED_CREDENTIALS_FILE', 'SITE_COOKIE', 'DBUS_SESSION_BUS_ADDRESS', 'CYNCO_NTFY_URL',
    ]
    const kept: Record<string, string> = {
      // The levers of the investigation's table pass as today.
      PIP_CACHE_DIR: 'C:\\h\\pip', npm_config_cache: 'C:\\h\\npm', PYTHONUSERBASE: 'C:\\h\\py', CARGO_HOME: 'C:\\h\\cargo',
      RUSTUP_HOME: 'C:\\Users\\owner\\.rustup', NPM_CONFIG_USERCONFIG: 'C:\\h\\.npmrc', PIP_CONFIG_FILE: 'C:\\h\\pip.ini',
      // Ordinary names that only look close.
      TOKENIZERS_PARALLELISM: 'false', SESSIONNAME: 'Console', KEYBOARD_LAYOUT: 'us', PASSTHROUGH_MODE: '1', GIT_CONFIG_KEY_0: 'core.x',
      SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE', COMPUTERNAME: 'PC', NUMBER_OF_PROCESSORS: '16', PSModulePath: 'C:\\m',
    }
    const base: Record<string, string> = { ...kept }
    for (const k of out) base[k] = 'x'
    const before = { ...process.env }
    for (const platform of ['win32', 'linux'] as const) {
      const env = toolEnv(base, ctx, platform)
      for (const k of out) expect(env[k], `${platform}: ${k}`).toBeUndefined()
      for (const [k, v] of Object.entries(kept)) expect(env[k], `${platform}: ${k}`).toBe(v)
    }
    // With no context nothing is stripped (an uncontained child is the engine's own business), and the
    // engine's own environment is untouched either way.
    const none = toolEnv(base, null, 'win32')
    for (const k of out) expect(none[k], k).toBe('x')
    expect(process.env).toEqual(before)
  })

  // Wave 19b: an address is not a credential, and stripping one can send a client that was pointed at a
  // local server (the 8081 model server, a proxy) to its public default address instead. Changed on
  // purpose: wave 19's rule stripped every name ending in BASE_URL or API_BASE.
  it('wave 19b: a variable that names an address (*_BASE_URL, *_API_BASE) reaches a contained child; a credential beside it does not', () => {
    const ctx = ctxOf()
    const addresses = { TOOL_API_BASE_URL: 'http://127.0.0.1:8081/v1', OPENAI_BASE_URL: 'http://127.0.0.1:8081/v1', LLM_API_BASE: 'http://127.0.0.1:11434' }
    for (const platform of ['win32', 'linux'] as const) {
      const env = toolEnv({ ...addresses, TOOL_API_KEY: 'k', TOOL_AUTH_TOKEN: 't' }, ctx, platform)
      for (const [k, v] of Object.entries(addresses)) expect(env[k], `${platform}: ${k}`).toBe(v)
      expect(env.TOOL_API_KEY, platform).toBeUndefined()
      expect(env.TOOL_AUTH_TOKEN, platform).toBeUndefined()
    }
  })

  // Wave 19b: Bun fetches a package that is not installed from the registry by itself when the script
  // it runs lies outside every node_modules tree; BUN_OPTIONS=--no-install stops it, even against
  // --install=force or a bunfig that asks for it (measured 2026-11-25, scratch b5-closedport.txt).
  it('wave 19b: a contained child\'s own Bun never fetches by itself: BUN_OPTIONS holds --no-install, after what the starter\'s held', () => {
    const ctx = ctxOf()
    for (const platform of ['win32', 'linux'] as const) {
      expect(toolEnv({}, ctx, platform).BUN_OPTIONS, platform).toBe('--no-install')
      expect(toolEnv({ BUN_OPTIONS: '--smol' }, ctx, platform).BUN_OPTIONS, platform).toBe('--smol --no-install')
      expect(toolEnv({ BUN_OPTIONS: '--install=force' }, ctx, platform).BUN_OPTIONS, platform).toBe('--install=force --no-install')
      expect(toolEnv({ BUN_OPTIONS: '  --no-install ' }, ctx, platform).BUN_OPTIONS, platform).toBe('--no-install')
      expect(toolEnv({ BUN_OPTIONS: '--smol --no-install' }, ctx, platform).BUN_OPTIONS, platform).toBe('--smol --no-install')
    }
    // One spelling of the key on Windows, the starter's value kept in it.
    const w = toolEnv({ Bun_Options: '--smol' }, ctx, 'win32')
    expect(Object.keys(w).filter(k => k.toUpperCase() === 'BUN_OPTIONS')).toEqual(['BUN_OPTIONS'])
    expect(w.BUN_OPTIONS).toBe('--smol --no-install')
    // With no context (the engine's own children, the harness's): nothing is added or changed.
    expect(toolEnv({}, null, 'win32').BUN_OPTIONS).toBeUndefined()
    expect(toolEnv({ BUN_OPTIONS: '--smol' }, null, 'linux').BUN_OPTIONS).toBe('--smol')
  })

  // Check A, A-R8 (wave 19): the authoring mark rests on ALWAYS_STRIP's LOCALCODE_MISSION_ prefix; this
  // row names the key itself. It guards behaviour that already held (it passed before it was written).
  it('A-R8: the authoring mark LOCALCODE_MISSION_AUTHOR_CHECK never reaches a child, contained or not', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(toolEnv({ LOCALCODE_MISSION_AUTHOR_CHECK: '1', KEEP: 'k' }, ctxOf(), platform).LOCALCODE_MISSION_AUTHOR_CHECK, platform).toBeUndefined()
      expect(toolEnv({ LOCALCODE_MISSION_AUTHOR_CHECK: '1' }, null, platform).LOCALCODE_MISSION_AUTHOR_CHECK, platform).toBeUndefined()
    }
    expect(toolEnv({ Localcode_Mission_Author_Check: '1' }, ctxOf(), 'win32').Localcode_Mission_Author_Check).toBeUndefined()
  })

  it('an explicit PYTHONUSERBASE wins, and with no APPDATA the real home is used', () => {
    const ctx = ctxOf()
    expect(toolEnv({ PYTHONUSERBASE: 'C:\\py' }, ctx, 'win32').PYTHONUSERBASE).toBe('C:\\py')
    expect(toolEnv({}, ctx, 'win32').PYTHONUSERBASE).toBe(join(L.home, 'AppData', 'Roaming', 'Python'))
  })

  it('with a context on linux: home, temp, scratch and git config redirected; nothing Windows-only added', () => {
    const ctx = ctxOf()
    const env = toolEnv({ PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/owner/.config' }, ctx, 'linux')
    expect(env.HOME).toBe(ctx.sandbox.home)
    for (const k of ['TMPDIR', 'TEMP', 'TMP'] as const) expect(env[k]).toBe(ctx.sandbox.tmp)
    expect(env.CYNCO_SCRATCH).toBe(ctx.sandbox.scratch)
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(ctx.sandbox.home, '.gitconfig'))
    expect(env.USERPROFILE).toBeUndefined()
    expect(env.APPDATA).toBeUndefined()
    expect(env.HOMEDRIVE).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBe(join(ctx.sandbox.home, '.config'))
    expect(env.XDG_CACHE_HOME).toBeUndefined()
    expect(env.PYTHONUSERBASE).toBe(join(L.home, '.local'))
  })
})

// ─── containedCommand ───────────────────────────────────────────────────────────────────────────

describe('containedCommand', () => {
  it('passes through with no context and off Windows', () => {
    const none = containedCommand({ file: 'echo hi', args: [], shell: true }, { ctx: null, cwd: L.mission, env: { A: '1', LOCALCODE_MISSION_CWD: 'x' }, extraEnv: { B: '2' }, platform: 'win32' })
    expect(none.viaLauncher).toBe(false)
    expect(none.file).toBe('echo hi')
    expect(none.cwd).toBe(L.mission)
    expect(none.env.A).toBe('1')
    expect(none.env.B).toBe('2')
    expect(none.env.LOCALCODE_MISSION_CWD).toBeUndefined()
    const ctx = ctxOf()
    const lin = containedCommand({ file: 'git', args: ['status'] }, { ctx, cwd: L.mission, env: { A: '1' }, extraEnv: { B: '2' }, platform: 'linux' })
    expect(lin.viaLauncher).toBe(false)
    expect(lin.args).toEqual(['status'])
    expect(lin.env.HOME).toBe(ctx.sandbox.home)
    expect(lin.env.B).toBe('2')
  })

  it('on win32 builds the launcher argv, in the checkout, with the engine environment unchanged', () => {
    const ctx = ctxOf()
    const c = containedCommand({ file: 'Get-ChildItem', args: [], shell: 'powershell.exe' }, {
      ctx, cwd: L.mission, env: { ...process.env, CYNCO_CHECK_ORDINAL: '3' }, extraEnv: { NO_COLOR: '1' }, platform: 'win32', execPath: 'C:/bun/bun.exe',
    })
    const checkout = engineCheckout()
    expect(c.viaLauncher).toBe(true)
    expect(c.file).toBe('C:/bun/bun.exe')
    expect(c.cwd).toBe(checkout)
    // The launcher gets the engine's own environment plus this spawn's seal, and nothing else.
    expect(c.seal).toMatch(/^[0-9a-f]{32}$/)
    expect(c.env).toEqual({ ...process.env, CYNCO_LAUNCHER_SEAL: c.seal })
    const again = containedCommand({ file: 'x', args: [], shell: true }, { ctx, platform: 'win32', execPath: 'C:/bun/bun.exe' })
    expect(again.seal).not.toBe(c.seal)
    expect(c.args.slice(0, 7)).toEqual([
      '--no-env-file',
      `--config=${join(checkout, 'engine', 'lowIntegrityLauncher.bunfig.toml')}`,
      join(checkout, 'engine', 'lowIntegrityLauncher.ts'),
      '--run-dir', ctx.sandbox.root,
      '--cwd', L.mission,
    ])
    const envPairs = c.args.flatMap((a, i) => (a === '--env' ? [c.args[i + 1]] : []))
    expect(envPairs).toEqual(['CYNCO_CHECK_ORDINAL=3', 'NO_COLOR=1'])
    expect(c.args.slice(-3)).toEqual(['--shell', 'powershell.exe', 'Get-ChildItem'])
    expect(c.commandFile).toBeUndefined()
  })

  it('shell: true leaves the shell slot empty; the argv form is --exec', () => {
    const ctx = ctxOf()
    expect(containedCommand({ file: 'echo x', args: [], shell: true }, { ctx, platform: 'win32' }).args.slice(-3)).toEqual(['--shell', '', 'echo x'])
    expect(containedCommand({ file: 'git', args: ['--version'] }, { ctx, platform: 'win32' }).args.slice(-3)).toEqual(['--exec', 'git', '--version'])
  })

  it('a 20,000-character command goes through --command-file in the run folder', () => {
    const runDir = join(L.root, 'run')
    mkdirSync(runDir)
    const ctx = ctxOf()
    const long = 'Write-Output ' + 'x'.repeat(20_000)
    const c = containedCommand({ file: long, args: [], shell: true }, { ctx, platform: 'win32' })
    expect(c.args.slice(-4, -1)).toEqual(['--shell', '', '--command-file'])
    expect(c.commandFile).toBe(c.args[c.args.length - 1])
    expect(dirname(c.commandFile!)).toBe(runDir)
    expect(readFileSync(c.commandFile!, 'utf-8')).toBe(long)
  })

  it('a test context with lowil switched off is the pass-through', () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    const ctx = ctxOf()
    const c = containedCommand({ file: 'echo x', args: [], shell: true }, { ctx, cwd: L.mission, platform: 'win32' })
    expect(c.viaLauncher).toBe(false)
    expect(c.env.USERPROFILE).toBe(ctx.sandbox.home)
  })
})

// ─── toolSpawnRefusal, the switch, launcher faults ──────────────────────────────────────────────

describe('toolSpawnRefusal', () => {
  it('the six rules', () => {
    const test = ctxOf()
    const live: RunContainment = { ...test, test: false }
    expect(toolSpawnRefusal({ ctx: null })).toBeNull()
    expect(toolSpawnRefusal({ ctx: null, required: true })).toBe(refusalText('containment', NO_CONTAINMENT))
    expect(toolSpawnRefusal({ ctx: live, platform: 'linux' })).toBeNull()
    expect(toolSpawnRefusal({ ctx: live, platform: 'win32', bun: false })).toBe(refusalText('containment', LAUNCHER_UNAVAILABLE('not Bun')))
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    expect(toolSpawnRefusal({ ctx: live, platform: 'linux' })).toBe(refusalText('containment', SWITCH_IN_UNATTENDED))
    expect(toolSpawnRefusal({ ctx: test, platform: 'win32', bun: false })).toBeNull()
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil,bogus'
    for (const platform of ['linux', 'win32'] as const) {
      expect(toolSpawnRefusal({ ctx: test, platform })).toBe(refusalText('containment', 'LOCALCODE_CONTAINMENT_OFF names an unknown layer: bogus'))
    }
  })

  it('a Bun process without the launcher files names the missing file', () => {
    const t = toolSpawnRefusal({ ctx: { ...ctxOf(), test: false }, platform: 'win32', bun: true })
    if (existsSync(join(engineCheckout(), 'engine', 'lowIntegrityLauncher.bunfig.toml')) && existsSync(join(engineCheckout(), 'engine', 'lowIntegrityLauncher.ts'))) {
      expect(t).toBeNull()
    } else {
      expect(t).toContain('launcher file missing: ')
    }
  })

  it('every refusal reads back as the containment layer', () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'paths'
    const t = toolSpawnRefusal({ ctx: { ...ctxOf(), test: false }, platform: 'linux' })!
    expect(t.startsWith(refusalPrefix('containment'))).toBe(true)
    expect(refusalLayerOf(t)).toBe('containment')
  })
})

describe('containmentSwitch and containmentOff', () => {
  it('reads the one variable', () => {
    expect(containmentSwitch({})).toEqual({ raw: null, off: [], unknown: [] })
    expect(containmentSwitch({ LOCALCODE_CONTAINMENT_OFF: '  ' }).raw).toBeNull()
    expect(containmentSwitch({ LOCALCODE_CONTAINMENT_OFF: 'lowil, Paths' }).off).toEqual(['lowil', 'paths'])
    const odd = containmentSwitch({ LOCALCODE_CONTAINMENT_OFF: 'lowil,audit' })
    expect(odd.unknown).toEqual(['audit'])
  })

  it('switches a layer off only for a test context, and never with an unknown word', () => {
    const test = ctxOf()
    const live: RunContainment = { ...test, test: false }
    expect(containmentOff('lowil', test, { LOCALCODE_CONTAINMENT_OFF: 'lowil' })).toBe(true)
    expect(containmentOff('paths', test, { LOCALCODE_CONTAINMENT_OFF: 'lowil' })).toBe(false)
    expect(containmentOff('lowil', test, { LOCALCODE_CONTAINMENT_OFF: 'lowil,x' })).toBe(false)
    expect(containmentOff('lowil', live, { LOCALCODE_CONTAINMENT_OFF: 'lowil' })).toBe(false)
    expect(containmentOff('lowil', null, { LOCALCODE_CONTAINMENT_OFF: 'lowil' })).toBe(false)
  })
})

describe('launcherFaultOf', () => {
  const SEAL = '0123456789abcdef0123456789abcdef'
  it('197 and 198 are faults only with their own line AND this spawn\'s seal line', () => {
    const f = launcherFaultOf(197, `noise\n[containment] refused: the record could not be read\n[containment] sealed ${SEAL} 197\n`, SEAL)
    expect(f?.code).toBe('ECONTAINMENT')
    expect(f?.reason).toBe('the record could not be read')
    expect(f?.text).toBe(refusalText('containment', 'the record could not be read'))
    expect(f?.ran).toBe(false)
    expect(launcherFaultOf(197, `a program that exits 197 by itself\n[containment] sealed ${SEAL} 197`, SEAL)).toBeNull()
    const gone = launcherFaultOf(198, `[containment] child ended: SIGKILL\r\n[containment] sealed ${SEAL} 198\r\n`, SEAL)
    expect(gone?.code).toBe('ECHILDGONE')
    expect(gone?.ran).toBe(true)
    expect(gone?.exitCode).toBeNull()
    expect(launcherFaultOf(0, `[containment] refused: x\n[containment] sealed ${SEAL} 0`, SEAL)).toBeNull()
    expect(launcherFaultOf(7, '', SEAL)).toBeNull()
  })

  // Review of slice S5: the child shares the launcher's stderr and passes its own status through,
  // so the launcher's lines alone prove nothing. Without the seal line for THIS spawn (absent, for
  // another spawn, for the other status, or no seal known) a 197 or 198 is the command's own code.
  it('a command that prints the launcher\'s line and exits 197 or 198 itself is no fault', () => {
    expect(launcherFaultOf(197, 'Remove-Item ran first\r\n[containment] refused: forged by the command\r\n', SEAL)).toBeNull()
    expect(launcherFaultOf(198, '[containment] child ended: forged', SEAL)).toBeNull()
    expect(launcherFaultOf(197, '[containment] refused: x\n[containment] sealed ffffffffffffffffffffffffffffffff 197', SEAL)).toBeNull()
    expect(launcherFaultOf(197, `[containment] refused: x\n[containment] sealed ${SEAL} 198`, SEAL)).toBeNull()
    expect(launcherFaultOf(197, `[containment] refused: x\n[containment] sealed ${SEAL} 197`, undefined)).toBeNull()
    expect(launcherFaultOf(197, '[containment] refused: x\n[containment] sealed  197', '')).toBeNull()
  })

  // Review finding of slice S2 (rule F35): the gate-authoring check is a Bun script in the
  // checkout, which a Bun at low integrity cannot load. Its exit 1 is "did not run", never a FAILED
  // check; any other exit 1 is the command's own.
  it('exit 1 with Bun\'s own EPERM line is "did not run" (ECONTAINMENT), naming the file', () => {
    const line = 'error: EPERM reading "C:\\Users\\o\\localcode\\scripts\\cynco-gate-author.mjs"'
    const f = launcherFaultOf(1, `${line}\n`, undefined)
    expect(f?.code).toBe('ECONTAINMENT')
    // A process ran (the Bun the launcher started), so a result built from it carries status 1.
    expect(f?.ran).toBe(true)
    expect(f?.exitCode).toBe(1)
    expect(f?.reason).toContain('C:\\Users\\o\\localcode\\scripts\\cynco-gate-author.mjs')
    expect(f?.reason).toContain('did not run')
    expect(f?.text.startsWith('Refused [containment]: ')).toBe(true)
    expect(launcherFaultOf(1, `Bun v1.3.13\r\n${line}\r\n`, undefined)?.code).toBe('ECONTAINMENT')
    expect(launcherFaultOf(1, 'FAILED test_x.py::test_a\nerror: something else', undefined)).toBeNull()
    expect(launcherFaultOf(1, `prefix ${line}`, undefined)).toBeNull()
    expect(launcherFaultOf(2, line, SEAL)).toBeNull()
    expect(launcherFaultOf(0, line, SEAL)).toBeNull()
  })
})

// ─── Run ids, volumes, hints, the test seam ─────────────────────────────────────────────────────

describe('mintRunId and acknowledgedVolumes', () => {
  it('every label gives a well-formed run id, and two calls differ', () => {
    for (const label of ['my mission', 'a/b\\c', '..hidden', '-x', '_x', 'x'.repeat(200), '', '!!!']) {
      expect(mintRunId(label), label).toMatch(RUN_ID_RE)
    }
    expect(mintRunId('')).toMatch(/^run-/)
    expect(mintRunId('a')).not.toBe(mintRunId('a'))
  })

  it('volume roots in one spelling; anything else as written', () => {
    expect(acknowledgedVolumes({ LOCALCODE_UNPROTECTED_VOLUMES_OK: 'D:;d:\\; D: ; ' })).toEqual(['D:\\'])
    expect(acknowledgedVolumes({ LOCALCODE_UNPROTECTED_VOLUMES_OK: 'D:\\data' })).toEqual(['D:\\data'])
    expect(acknowledgedVolumes({})).toEqual([])
  })
})

describe('containmentHint', () => {
  const msys = 'sh.exe: *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1): 0xC0000022'
  it('says nothing with no context or off Windows', () => {
    expect(containmentHint('failure', msys, null, 'win32')).toBe('')
    expect(containmentHint('failure', msys, ctxOf(), 'linux')).toBe('')
  })
  it('the msys text on failure and on success, and the timeout text', () => {
    const ctx = ctxOf()
    expect(containmentHint('failure', msys, ctx, 'win32')).toContain(MSYS_IN_CONTAINED_RUN)
    expect(containmentHint('success', `ok\n${msys}`, ctx, 'win32')).toContain('Use the PowerShell form instead')
    // P2-F5 (wave 15b): the PATH is not reordered, so the hint says which Windows programs resolve to
    // Git's copy in a dispatched mission, and that the full System32 path is the way round.
    const words = containmentHint('failure', msys, ctx, 'win32')
    for (const w of ['whoami', 'find', 'sort', "Git's copy", 'dispatched mission']) expect(words, w).toContain(w)
    const sys32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32`
    expect(words).toContain(`${sys32}\\whoami.exe`)
    expect(containmentHint('failure', 'plain error', ctx, 'win32')).toBe('')
    expect(containmentHint('timeout', '', ctx, 'win32')).toContain('-p no:cacheprovider')
  })
})

describe('testContainment', () => {
  it('is pure and marks the context as a test', () => {
    const before = readdirSync(dir).sort()
    const ctx = ctxOf()
    expect(ctx.test).toBe(true)
    expect(ctx.runId).toMatch(RUN_ID_RE)
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(existsSync(ctx.sandbox.root)).toBe(false)
    expect(Object.isFrozen(ctx)).toBe(true)
    setRunContainment(ctx)
    expect(runContainment()).toBe(ctx)
  })

  it('refuses inside a process that is itself an unattended run', () => {
    process.env.LOCALCODE_MISSION_MARKER = 'DONE'
    expect(() => ctxOf()).toThrow('testContainment() was called in a process that is itself an unattended run')
  })

  // P2-B10 (wave 15c): toolEnv hands the sandbox home on as USERPROFILE. A relative one makes Windows
  // PowerShell's LocalApplicationData empty, and its module analysis cache then goes under the child's
  // working folder (measured: phase3\w15\scratch\p2\out-c\lad, run5): the stray
  // Microsoft\Windows\PowerShell\ModuleAnalysisCache at the top of the repository is that shape.
  it('refuses a sandbox folder or a home that is not an absolute path', () => {
    const runDir = join(L.root, 'run')
    const sb = { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }
    for (const k of ['root', 'home', 'tmp', 'scratch'] as const) {
      expect(() => ctxOf({ sandbox: { ...sb, [k]: 'relative\\x' } }), k).toThrow(`testContainment() takes absolute paths: the sandbox ${k} relative\\x is not one`)
    }
    expect(() => ctxOf({ home: 'h' })).toThrow('testContainment() takes absolute paths: the home h is not one')
  })

  it('C1 (wave 19): the rule is the same on every host: a drive path is absolute everywhere, a path rooted without a drive is not on Windows', () => {
    const runDir = join(L.root, 'run')
    const sb = { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }
    // Windows literals are absolute on every host (protectedPaths.test.ts builds its W context from them on Linux CI).
    expect(() => ctxOf({ home: 'C:\\Users\\u' })).not.toThrow()
    expect(() => ctxOf({ sandbox: { ...sb, home: 'C:/cynco-sandbox/run1/home' } })).not.toThrow()
    expect(() => ctxOf({ home: '\\\\server\\share\\u' })).not.toThrow()
    // Rooted without a drive: Windows PowerShell then reads LocalApplicationData as empty (measured
    // 2026-11-24, `\` gives lad=[]), the very shape the check exists for. A bare drive and a device path too.
    for (const bad of ['\\sb\\home', 'C:', 'C:relative', '\\\\?\\C:\\x', '\\\\.\\C:\\x']) {
      expect(() => ctxOf({ home: bad }), bad).toThrow(`testContainment() takes absolute paths: the home ${bad} is not one`)
    }
    if (process.platform === 'win32') {
      expect(() => ctxOf({ home: '/sb/home' })).toThrow('testContainment() takes absolute paths: the home /sb/home is not one')
      expect(() => ctxOf({ sandbox: { ...sb, tmp: '/sb/tmp' } })).toThrow('testContainment() takes absolute paths: the sandbox tmp /sb/tmp is not one')
    } else {
      expect(() => ctxOf({ home: '/sb/home' })).not.toThrow()
    }
  })
})

describe('harnessChildCwd (P2-B10)', () => {
  it('a child of this module starts in System32 on Windows (a folder it cannot write), never in the checkout', () => {
    const sys32 = join(process.env.SystemRoot || 'C:/Windows', 'System32')
    expect(harnessChildCwd('win32')).toBe(sys32)
    expect(fold(harnessChildCwd('win32')).startsWith(fold(engineCheckout()))).toBe(false)
    expect(harnessChildCwd('linux')).toBe(engineCheckout())
  })

  it.skipIf(process.platform !== 'win32')('the real volume listing starts Windows PowerShell in System32, not in the checkout (Windows: one read-only query)', () => {
    spawned.calls = []
    spawned.on = true
    try {
      listUnprotectedVolumes({ platform: 'win32' })
    } finally {
      spawned.on = false
    }
    const ps = spawned.calls.filter(c => exeOf(c.file) === 'powershell.exe')
    expect(ps).toHaveLength(1)
    expect(ps[0].cwd).toBe(harnessChildCwd('win32'))
  })
})

// ─── establishContainment ───────────────────────────────────────────────────────────────────────

describe('establishContainment: the sandbox it makes', () => {
  it('on win32: folders, the record before the first label, the exact icacls calls', () => {
    const runId = mintRunId('unit')
    const recordFirst: boolean[] = []
    const s = seam({ before: c => { if (exeOf(c.file) === 'icacls.exe' && c.args.length > 1) recordFirst.push(existsSync(recPath(runId))) } })
    writeFileSync(join(L.home, '.gitconfig'), '[user]\n\tname = owner\n')
    const ctx = established(establishContainment(winBase(s.run, { label: undefined, runId, extraRoots: [L.extra] })))
    const runDir = join(L.root, runId)
    for (const d of ['home', join('home', 'AppData', 'Roaming'), join('home', 'AppData', 'Local'), 'tmp', 'scratch']) expect(existsSync(join(runDir, d)), d).toBe(true)
    expect(recordFirst.length).toBeGreaterThan(0)
    expect(recordFirst.every(Boolean)).toBe(true)
    const grants = s.icacls().filter(c => c.args[1] === '/grant')
    expect(grants.map(c => c.args[0])).toEqual([runDir])
    expect(grants[0].args[2]).toBe('*S-1-5-21-11-22-33-1001:(OI)(CI)F')
    expect(s.labels('L')).toEqual([join(runDir, 'home'), join(runDir, 'tmp'), join(runDir, 'scratch'), L.mission, L.extra])
    expect(s.labels('L')).not.toContain(runDir)
    expect(s.calls.some(c => c.args.some(a => a.toUpperCase() === '/T'))).toBe(false)
    const gitconfig = readFileSync(join(runDir, 'home', '.gitconfig'), 'utf-8')
    expect(gitconfig).toContain('[include]')
    expect(gitconfig).toContain(`path = ${join(L.home, '.gitconfig').replace(/\\/g, '/')}`)
    const rec = readRec(runId)
    expect(rec.cwdLabel).toBe('low')
    expect(rec.holder).toBeNull()
    expect(rec.releasedAt).toBeNull()
    expect(ctx.runId).toBe(runId)
    expect(ctx.sandbox.root).toBe(runDir)
    expect(ctx.extraRoots).toEqual([L.extra])
    expect(ctx.folders).toEqual(folders)
    expect(ctx.isolation).toBe('overlay')
  })

  it('no .gitconfig in the home folder: no include', () => {
    const ctx = established(establishContainment(base()))
    expect(readFileSync(join(ctx.sandbox.home, '.gitconfig'), 'utf-8')).not.toContain('[include]')
  })

  it('labelCwd: false labels nothing outside the sandbox', () => {
    const s = seam()
    const ctx = established(establishContainment(winBase(s.run, { labelCwd: false, kind: 'precheck' })))
    expect(s.labels('L')).toEqual([join(ctx.sandbox.root, 'home'), join(ctx.sandbox.root, 'tmp'), join(ctx.sandbox.root, 'scratch')])
    expect(readRec(ctx.runId).cwdLabel).toBe('none')
  })

  it('a precheck and a grader record name this process as holder; a mission record names none', () => {
    for (const kind of ['precheck', 'grader'] as const) {
      const ctx = established(establishContainment(base({ kind })))
      expect(readRec(ctx.runId).holder?.pid).toBe(process.pid)
    }
    const m = established(establishContainment(base()))
    expect(readRec(m.runId).holder).toBeNull()
  })

  it('a label that fails, then succeeds after the grant, records cwdGranted', () => {
    let tries = 0
    const s = seam({ icacls: args => (args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: `${args[0]}: Access is denied.` } : undefined) })
    const ctx = established(establishContainment(winBase(s.run)))
    expect(s.icacls().filter(c => c.args[1] === '/grant').map(c => c.args[0])).toEqual([ctx.sandbox.root, L.mission])
    expect(readRec(ctx.runId).cwdGranted).toBe(true)
  })

  it('F155: an impossible ETIMEDOUT on the first call is retried once and said', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const s = seam({ first: { ok: false, out: 'ETIMEDOUT', code: null } })
    established(establishContainment(winBase(s.run)))
    expect(log.mock.calls.map(c => String(c[0])).some(l => l.includes('an impossible ETIMEDOUT after'))).toBe(true)
  })
})

describe('establishContainment: every refusal by its text', () => {
  it('E1, E2: the switch', () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    expect(refusal(establishContainment(base()))).toBe(SWITCH_IN_UNATTENDED)
    process.env.LOCALCODE_CONTAINMENT_OFF = 'nope'
    expect(refusal(establishContainment(base({ test: true })))).toBe('LOCALCODE_CONTAINMENT_OFF names an unknown layer: nope')
  })

  it('the switch rows of entry 1.M2: grader, precheck and daemon-task with lowil and no mission key', () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    for (const kind of ['grader', 'precheck', 'daemon-task'] as const) {
      expect(refusal(establishContainment(base({ kind })))).toBe(SWITCH_IN_UNATTENDED)
    }
    expect(readdirSync(L.root)).toEqual([])
  })

  it('E3: a low process does not establish a second containment', () => {
    const s = seam({ level: 'S-1-16-4096' })
    expect(refusal(establishContainment(winBase(s.run)))).toBe('this process is already running at low integrity, and a contained run does not establish a second containment')
  })

  it('E4: exactly one of a label and a well-formed run id', () => {
    expect(refusal(establishContainment(base({ label: undefined })))).toBe('establishContainment needs exactly one of a label and a well-formed run id (got neither)')
    expect(refusal(establishContainment(base({ runId: mintRunId('x') })))).toMatch(/^establishContainment needs exactly one of a label and a well-formed run id \(got label unit and run id /)
    expect(refusal(establishContainment(base({ label: undefined, runId: 'bad id' })))).toBe('establishContainment needs exactly one of a label and a well-formed run id (got run id bad id)')
  })

  it('E5: no cwd', () => {
    expect(refusal(establishContainment(base({ missionCwd: '' })))).toBe(`this task names no cwd, so it would work in the engine's own checkout ${engineCheckout()}; give the mission a cwd`)
  })

  it('E6: under Node on Windows the launcher is unavailable, and nothing is created', () => {
    const s = seam()
    expect(refusal(establishContainment(base({ platform: 'win32', run: s.run })))).toBe(LAUNCHER_UNAVAILABLE('not Bun'))
    expect(readdirSync(L.root)).toEqual([])
  })

  it('S1, S2: the sandbox root', () => {
    const missing = join(dir, 'no-such-root')
    expect(refusal(establishContainment(base({ sandboxRoot: missing })))).toBe(`the sandbox root ${missing} is not an absolute path to an existing folder; create it once with scripts/cynco-containment-setup.ps1 or name another folder in LOCALCODE_SANDBOX_ROOT`)
    expect(refusal(establishContainment(base({ sandboxRoot: 'relative/root' })))).toMatch(/^the sandbox root relative\/root is not an absolute path/)
    expect(refusal(establishContainment(base({ sandboxRoot: dir })))).toBe(`the sandbox root ${dir} is a drive root, or is or contains the home folder ${L.home}`)
    expect(refusal(establishContainment(base({ sandboxRoot: L.home })))).toBe(`the sandbox root ${L.home} is a drive root, or is or contains the home folder ${L.home}`)
  })

  it('V1, V2, V3: volumes that cannot be protected', () => {
    const vols = 'C:|3|NTFS\r\nE:|2|exFAT\r\nF:|5|\r\nG:|2|\r\n'
    expect(refusal(establishContainment(winBase(seam({ volumes: vols }).run)))).toBe('E:\\ (exFAT) cannot be protected by integrity labels and is not acknowledged')
    process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK = 'e:'
    const ok = established(establishContainment(winBase(seam({ volumes: vols }).run)))
    expect(ok.unprotectedVolumes).toEqual(['E:\\'])
    process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK = 'C:'
    expect(refusal(establishContainment(winBase(seam().run)))).toBe('the entry C:\\ of LOCALCODE_UNPROTECTED_VOLUMES_OK is not the root of an attached volume that integrity labels cannot protect')
    delete process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK
    expect(refusal(establishContainment(winBase(seam({ volumes: null }).run)))).toBe('the attached volumes could not be listed (Get-CimInstance : Access denied), so it is not known whether one of them is unprotected')
  })

  it('the volume listing carries each volume\'s serial number (additive; an old three-field line gives null)', () => {
    const s = seam({ volumes: 'C:|3|NTFS|1A2B3C4D\r\nD:|2|exFAT|ABCD1234\r\nE:|2|FAT32\r\nF:|4|NTFS|\r\nG:|3|ReFS|00FF00FF  \r\n' })
    expect(listUnprotectedVolumes({ platform: 'win32', run: s.run })).toEqual([
      { root: 'D:\\', fileSystem: 'exFAT', kind: 'removable', serial: 'ABCD1234' },
      { root: 'E:\\', fileSystem: 'FAT32', kind: 'removable', serial: null },
      { root: 'F:\\', fileSystem: 'NTFS', kind: 'network', serial: null },
      { root: 'G:\\', fileSystem: 'ReFS', kind: 'local', serial: '00FF00FF' },
    ])
    const script = s.calls.find(c => exeOf(c.file) === 'powershell.exe')!.args.at(-1)!
    expect(script).toContain('$($_.VolumeSerialNumber)')
    expect(listUnprotectedVolumes({ platform: 'linux', run: s.run })).toEqual([])
  })

  // P2-F3 (wave 15): the serial field was matched as hex only, so a line whose serial was anything else
  // (a driver that prints N/A, a stray bar) did not match at all and its volume was left out of the
  // listing: the refusal never saw it. A serial that is not hex is now null and the volume stays.
  it('a volume whose serial is not hex, empty or absent is still listed (its serial null); a line that cannot be read refuses', () => {
    const shapes = 'C:|3|NTFS|F67B405B\r\nD:|2|exFAT|N/A\r\nE:|2|FAT32|\r\nH:|2|exFAT\r\nI:|4|NTFS|  \r\nJ:|2|UDF|12AB|extra\r\nK:|3|ReFS|0x12\r\n'
    expect(listUnprotectedVolumes({ platform: 'win32', run: seam({ volumes: shapes }).run })).toEqual([
      { root: 'D:\\', fileSystem: 'exFAT', kind: 'removable', serial: null },
      { root: 'E:\\', fileSystem: 'FAT32', kind: 'removable', serial: null },
      { root: 'H:\\', fileSystem: 'exFAT', kind: 'removable', serial: null },
      { root: 'I:\\', fileSystem: 'NTFS', kind: 'network', serial: null },
      { root: 'J:\\', fileSystem: 'UDF', kind: 'removable', serial: null },
      { root: 'K:\\', fileSystem: 'ReFS', kind: 'local', serial: null },
    ])
    // The establish refuses the volume with the N/A serial, as it refuses any unacknowledged one.
    expect(refusal(establishContainment(winBase(seam({ volumes: 'C:|3|NTFS|F67B405B\r\nD:|2|exFAT|N/A\r\n' }).run)))).toBe('D:\\ (exFAT) cannot be protected by integrity labels and is not acknowledged')
    // A line that starts as a volume line and cannot be read is not passed over: the listing fails.
    expect(() => listUnprotectedVolumes({ platform: 'win32', run: seam({ volumes: 'C:|3|NTFS|1\r\nD:|removable|exFAT|2\r\n' }).run }))
      .toThrow('the attached volumes could not be listed (a line of the listing could not be read: D:|removable|exFAT|2)')
  })

  it.skipIf(process.platform !== 'win32')('S3: the sandbox root on a volume without labels', () => {
    const vol = `${L.root.slice(0, 1).toUpperCase()}:`
    process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK = vol
    const s = seam({ volumes: `${vol}|3|exFAT\r\n` })
    expect(refusal(establishContainment(winBase(s.run)))).toBe(`the sandbox root ${L.root} is on ${vol}\\, a volume without integrity labels`)
  })

  it('H1: a home folder labelled low', () => {
    expect(refusal(establishContainment(winBase(seam({ homeLow: true }).run)))).toBe(`the home folder ${L.home} is itself labelled low integrity, so low integrity protects nothing in it`)
  })

  it('H1: a home folder whose label cannot be read', () => {
    const s = seam({ read: p => (p === L.home ? { ok: false, out: `${L.home}: Access is denied.` } : undefined) })
    expect(refusal(establishContainment(winBase(s.run)))).toBe(`the integrity label of the home folder ${L.home} could not be read (${L.home}: Access is denied.)`)
  })

  // M4 is reached only on a volume that holds neither the checkout nor the home folder (M2 and M3
  // come first for those). No test may depend on a real second drive (a sleeping one timed this case
  // out under suite load), so the root is made up and the M1 seam says it is a folder: nothing is
  // read on any volume but the resolution of a letter no test machine is expected to have. A
  // Windows path rule: elsewhere the only volume root, /, holds the checkout.
  it.skipIf(process.platform !== 'win32')('M4: a volume root (a made-up one, no disk)', () => {
    const fake = 'Q:\\'
    expect(fake[0]).not.toBe(engineCheckout()[0].toUpperCase())
    expect(fake[0]).not.toBe(tmpdir()[0].toUpperCase())
    const asked: string[] = []
    const isFolder = (p: string) => { asked.push(p); return p === fake }
    expect(refusal(establishContainment(base({ missionCwd: fake, home: L.home, isFolder })))).toBe(`the mission folder ${fake} is a volume root`)
    expect(asked).toEqual([fake])
    // The seam is rule M1's own: a folder it denies is refused with M1's text.
    expect(refusal(establishContainment(base({ missionCwd: L.mission, isFolder: () => false })))).toBe(`the mission folder ${L.mission} does not exist or is not a folder`)
  })

  it('M1: a folder that is not there', () => {
    const gone = join(dir, 'gone')
    expect(refusal(establishContainment(base({ missionCwd: gone })))).toBe(`the mission folder ${gone} does not exist or is not a folder`)
    expect(refusal(establishContainment(base({ extraRoots: [gone] })))).toBe(`the extra folder ${gone} does not exist or is not a folder`)
  })

  it('M2: the checkout, a folder that contains it, a folder inside it', () => {
    const co = engineCheckout()
    for (const p of [co, dirname(co), join(co, 'engine')]) {
      expect(refusal(establishContainment(base({ missionCwd: p })))).toBe(`the mission folder ${realpathSync.native(p)} is, contains or is inside the checkout this engine runs from (${co})`)
    }
  })

  it('M3: the home folder', () => {
    expect(refusal(establishContainment(base({ missionCwd: L.home })))).toBe(`the mission folder ${L.home} is the home folder ${L.home} or contains it`)
  })

  it('M5: a network path', () => {
    const unc = process.platform === 'win32' ? `\\\\?\\${L.mission}` : `/${L.mission}`
    expect(refusal(establishContainment(base({ missionCwd: unc })))).toMatch(/ is on a network share or on a volume without integrity labels$/)
  })

  it('M6: CynCo\'s own folders; the authoring staging folder is the exception', () => {
    const state = join(L.home, '.cynco')
    mkdirSync(join(state, 'authoring', 'x', '.git'), { recursive: true })
    writeFileSync(join(state, 'authoring', 'x', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const f = { ...folders, state }
    expect(refusal(establishContainment(base({ missionCwd: join(state, 'authoring'), folders: f })))).toBe(`the mission folder ${join(state, 'authoring')} is, contains or is inside ${state} (CynCo's state folder)`)
    expect(establishContainment(base({ missionCwd: join(state, 'authoring', 'x'), folders: f })).ok).toBe(true)
    expect(refusal(establishContainment(base({ missionCwd: L.guard })))).toBe(`the mission folder ${L.guard} is, contains or is inside ${L.guard} (the guard folder)`)
    expect(refusal(establishContainment(base({ missionCwd: L.models })))).toBe(`the mission folder ${L.models} is, contains or is inside ${L.models} (the models folder)`)
    const audit = join(L.mission, 'audit')
    mkdirSync(audit)
    expect(refusal(establishContainment(base({ folders: { ...folders, audit } })))).toBe(`the mission folder ${L.mission} is, contains or is inside ${audit} (the audit folder)`)
    const inRoot = join(L.root, 'm')
    mkdirSync(inRoot)
    expect(refusal(establishContainment(base({ missionCwd: inRoot })))).toBe(`the mission folder ${inRoot} is, contains or is inside ${L.root} (the sandbox root)`)
  })

  it('M7: a dot-folder of the home folder', () => {
    const ssh = join(L.home, '.ssh', 'keys')
    mkdirSync(ssh, { recursive: true })
    expect(refusal(establishContainment(base({ missionCwd: ssh })))).toBe(`the mission folder ${ssh} is inside ${join(L.home, '.ssh')}, a dot-folder of the home folder`)
  })

  it('M8: a link at the first or second level that leads out; one that stays inside is allowed', () => {
    link(L.outside, join(L.mission, 'out1'))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'out1')} -> ${L.outside})`)
    removeLinkEntry(join(L.mission, 'out1'))
    links = []
    mkdirSync(join(L.mission, 'sub'))
    link(L.outside, join(L.mission, 'sub', 'out2'))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'sub', 'out2')} -> ${L.outside})`)
    removeLinkEntry(join(L.mission, 'sub', 'out2'))
    links = []
    mkdirSync(join(L.mission, 'inner'))
    link(join(L.mission, 'inner'), join(L.mission, 'sub', 'in'))
    expect(establishContainment(base()).ok).toBe(true)
  })

  // NOW.md:84: rule M looked two levels deep, so a junction deeper down was followed by a later
  // `Remove-Item .\*`; and a folder it could not list was passed with a log line.
  it('M8 (NOW.md:84): a link at any depth that leads out is refused; one deep inside that stays inside is allowed', () => {
    mkdirSync(join(L.mission, 'a', 'b', 'c'), { recursive: true })
    link(L.outside, join(L.mission, 'a', 'b', 'c', 'out4'))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'a', 'b', 'c', 'out4')} -> ${L.outside})`)
    removeLinkEntry(join(L.mission, 'a', 'b', 'c', 'out4'))
    links = []
    link(join(L.mission, 'a'), join(L.mission, 'a', 'b', 'c', 'up'))
    expect(establishContainment(base()).ok).toBe(true)
  })

  it('M8 (NOW.md:84): a folder rule M cannot list is refused, not passed', () => {
    mkdirSync(join(L.mission, 'locked'))
    listing.entries = (d, realList) => {
      if (fold(d) === fold(join(L.mission, 'locked'))) throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${d}'`), { code: 'EPERM' })
      return realList(d)
    }
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a folder that could not be listed, so whether a link in it leads outside it is not known (${join(L.mission, 'locked')}: EPERM: operation not permitted, scandir '${join(L.mission, 'locked')}')`)
  })

  it('M8 (NOW.md:84): a tree of more entries than the bound is refused by name', () => {
    mkdirSync(join(L.mission, 'big'))
    const many = Array.from({ length: RULE_M_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, kind: 'file' as EntryKind }))
    listing.entries = (d, realList) => (fold(d) === fold(join(L.mission, 'big')) ? many : realList(d))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds more than 200,000 entries, so whether a link under it leads outside it was not checked; a mission works in a smaller clone, or in one without its installed packages`)
  })

  // P2-F8 (a): the bound is over the whole tree, not per folder (a per-folder count survived the case above).
  it('M8 (NOW.md:84): the bound counts the whole tree: two folders of 100,001 entries each are refused', () => {
    mkdirSync(join(L.mission, 'big1'))
    mkdirSync(join(L.mission, 'big2'))
    const half = Array.from({ length: RULE_M_MAX_ENTRIES / 2 + 1 }, (_, i) => ({ name: `f${i}`, kind: 'file' as EntryKind }))
    listing.entries = (d, realList) => ([join(L.mission, 'big1'), join(L.mission, 'big2')].some(b => fold(d) === fold(b)) ? half : realList(d))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds more than 200,000 entries, so whether a link under it leads outside it was not checked; a mission works in a smaller clone, or in one without its installed packages`)
  })

  // NOW.md:77: a link whose target is gone was judged by where its own path is (inside), and leads
  // out again once its target is made again.
  it('M8 (NOW.md:77): a link whose target cannot be resolved is refused, wherever it pointed', () => {
    mkdirSync(join(L.mission, 'inner'))
    link(join(L.mission, 'inner'), join(L.mission, 'dangling'))
    expect(establishContainment(base()).ok).toBe(true)
    rmdirSync(join(L.mission, 'inner'))
    const why = refusal(establishContainment(base()))
    expect(why.startsWith(`the mission folder ${L.mission} holds a link whose target cannot be resolved (${join(L.mission, 'dangling')}: `), why).toBe(true)
    expect(why.endsWith('; such a link leads wherever its target is made again')).toBe(true)
  })

  // C3 (wave 19): icacls and .NET read `foo.` (or `foo `) as `foo` (measured); rule M refuses such an
  // entry anywhere in the tree by name, file or folder, so nothing the release walks starts out with one.
  // Changed on purpose (R5, wave 19b): the rule is Windows' name rule, so the establish is one for
  // Windows (winBase); the case below shows the same names accepted by an establish for Linux.
  it('M8 (C3, wave 19): an entry whose name ends in a dot or a space, at any depth, is refused by name', () => {
    mkdirSync(join(L.mission, 'a', 'b'), { recursive: true })
    for (const name of ['foo.', 'bar ', 'x.']) {
      listing.entries = (d, realList) => (fold(d) === fold(join(L.mission, 'a', 'b')) ? [...realList(d), { name, kind: name === 'x.' ? 'dir' as EntryKind : 'file' as EntryKind }] : realList(d))
      expect(refusal(establishContainment(winBase(seam().run))), name).toBe(`the mission folder ${L.mission} holds an entry whose name Windows reads as another entry (${join(L.mission, 'a', 'b', name)}: its name ends in a dot or a space)`)
    }
    listing.entries = null
    expect(establishContainment(winBase(seam().run)).ok).toBe(true)
  })

  // R5 (check B, wave 19): the name rule is Windows'; on Linux such a name is an ordinary one.
  it('R5 (wave 19b): an establish for Linux accepts an entry, and a path part, whose name ends in a dot or a space', () => {
    // Made for real (through the \\?\ form on Windows, where the plain form drops the dot or space).
    const asWritten = (p: string) => (process.platform === 'win32' ? `\\\\?\\${p}` : p)
    const b = join(L.mission, 'a', 'b')
    mkdirSync(b, { recursive: true })
    writeFileSync(asWritten(join(b, 'foo.')), 'f')
    writeFileSync(asWritten(join(b, 'bar ')), 'b')
    mkdirSync(asWritten(join(b, 'x.')))
    writeFileSync(asWritten(join(b, 'x.', 'in.txt')), 'i')
    expect(listEntries(b).map(e => e.name).sort()).toEqual(['bar ', 'foo.', 'x.'])
    const r0 = establishContainment(base())
    expect(r0.ok, r0.ok ? '' : r0.reason).toBe(true)
    // The same tree refused by an establish for Windows.
    expect(refusal(establishContainment(winBase(seam().run)))).toMatch(/holds an entry whose name Windows reads as another entry/)
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    const odd = join(dir, 'odd.', 'repo')
    mkdirSync(asWritten(join(odd, '.git')), { recursive: true })
    writeFileSync(asWritten(join(odd, '.git', 'HEAD')), 'ref: refs/heads/main\n')
    try {
      const r = establishContainment(base({ missionCwd: odd }))
      expect(r.ok, r.ok ? '' : r.reason).toBe(true)
    } finally {
      unlinkSync(asWritten(join(odd, '.git', 'HEAD')))
      for (const p of [join(odd, '.git'), odd, join(dir, 'odd.')]) rmdirSync(asWritten(p))
    }
  })

  it('M (C3, wave 19): a mission folder whose own path has a part that ends in a dot or a space is refused by name', () => {
    const odd = join(dir, 'odd.', 'repo')
    // Made through the \\?\ form on Windows, where the plain form would make `odd`.
    mkdirSync(process.platform === 'win32' ? `\\\\?\\${odd}` : odd, { recursive: true })
    try {
      mkdirSync(process.platform === 'win32' ? `\\\\?\\${join(odd, '.git')}` : join(odd, '.git'))
      // Changed on purpose (R5, wave 19b): an establish for Windows (winBase), where the rule applies.
      expect(refusal(establishContainment(winBase(seam().run, { missionCwd: odd })))).toBe(`the mission folder ${odd} has a part of its path whose name Windows reads as another folder (odd.: it ends in a dot or a space)`)
    } finally {
      for (const p of [join(odd, '.git'), odd, join(dir, 'odd.')]) rmdirSync(process.platform === 'win32' ? `\\\\?\\${p}` : p)
    }
  })

  it('M9: the mission folder is the top of its own repository (mission only)', () => {
    const noGit = join(dir, 'nogit')
    mkdirSync(noGit)
    expect(refusal(establishContainment(base({ missionCwd: noGit })))).toBe(`the mission folder ${noGit} is not the top of its own git repository (.git is missing); a mission works in a clone made with git clone --no-hardlinks, not in a worktree or a subfolder`)
    expect(establishContainment(base({ missionCwd: noGit, kind: 'daemon-task' })).ok).toBe(true)
    const gitFile = join(dir, 'gitfile')
    mkdirSync(gitFile)
    writeFileSync(join(gitFile, '.git'), 'gitdir: ../elsewhere\n')
    expect(refusal(establishContainment(base({ missionCwd: gitFile })))).toContain('(.git is a file: a worktree or a submodule)')
    const noHead = join(dir, 'nohead')
    mkdirSync(join(noHead, '.git'), { recursive: true })
    expect(refusal(establishContainment(base({ missionCwd: noHead })))).toContain('(.git holds no HEAD)')
  })

  it('a hard link under a folder that will be labelled: refused, wherever its other name is', () => {
    mkdirSync(join(L.mission, 'deep', 'er'), { recursive: true })
    writeFileSync(join(L.outside, 'secret.txt'), 'x')
    const inner = join(L.mission, 'deep', 'er', 'secret-alias.txt')
    linkSync(join(L.outside, 'secret.txt'), inner)
    // Off Windows nothing is labelled, so nothing is checked.
    expect(establishContainment(base()).ok).toBe(true)
    expect(refusal(establishContainment(winBase(seam().run)))).toBe(`the mission folder ${L.mission} holds a file with more than one name (${inner} has 2); a low label set on such a file reaches every other name of it, so the folder is not labelled: work in a clone made with git clone --no-hardlinks`)
    // Nor with labelCwd false.
    expect(establishContainment(winBase(seam().run, { labelCwd: false, kind: 'precheck' })).ok).toBe(true)
    unlinkSync(inner)
    expect(establishContainment(winBase(seam().run)).ok).toBe(true)
  })

  it('a folder still labelled low with no live run holding it is refused before anything is made', () => {
    const lowRead = (p: string) => (p === L.mission ? { ok: true, out: `${p} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n         Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\r\n` } : undefined)
    expect(refusal(establishContainment(winBase(seam({ read: lowRead }).run)))).toBe(`the mission folder ${L.mission} is already labelled low integrity and no live run holds it (an earlier run's release did not set it back, or it sits in a folder labelled low). Look at what changed in it, then set it back with icacls "${L.mission}" /setintegritylevel (OI)(CI)M`)
    expect(readdirSync(L.root)).toEqual([])
    // A live run holding the folder is the legitimate reason for its label.
    const first = established(establishContainment(winBase(seam().run)))
    editRec(first.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    expect(establishContainment(winBase(seam({ read: lowRead }).run)).ok).toBe(true)
  })

  it('a dead run naming the folder is released with its label set back before the label is read', () => {
    const first = established(establishContainment(winBase(seam().run)))
    editRec(first.runId, rec => { rec.holder = { pid: deadPid(), startedAt: new Date().toISOString() } })
    const s = seam()
    established(establishContainment(winBase(s.run)))
    // `work`: the dead run's own sandbox is set back too since 2026-11-24 (asserted below).
    expect(s.work('M')).toEqual([L.mission])
    expect(s.sandboxM()).toEqual(['home', 'tmp', 'scratch'].map(d => join(L.root, first.runId, d)))
    expect(readRec(first.runId).releasedBy).toBe('holder-gone')
  })

  it('C1: a run folder that already exists', () => {
    const runId = mintRunId('unit')
    mkdirSync(join(L.root, runId))
    expect(refusal(establishContainment(base({ label: undefined, runId })))).toMatch(new RegExp(`^the sandbox ${join(L.root, runId).replace(/\\/g, '\\\\')} could not be created \\(`))
  })

  it('C2: a sandbox label that fails', () => {
    const s = seam({ icacls: args => (args[0].endsWith('tmp') && args[1] === '/setintegritylevel' ? { ok: false, out: 'tmp: Access is denied.' } : undefined) })
    expect(refusal(establishContainment(winBase(s.run)))).toMatch(/^the sandbox .*tmp could not be labelled low integrity \(tmp: Access is denied\.\)$/)
  })

  it('C3: a label that fails after the grant names the icacls line; what was labelled is set back', () => {
    // Changed on purpose (R1 F1): the access list is saved before the grant now, so the save is let
    // through here to reach the grant this case is about (a failed save is its own case below).
    const s = seam({ icacls: args => (args[0] === L.extra && args[1] !== '/save' ? { ok: false, out: `${L.extra}: Access is denied.` } : undefined) })
    const r = establishContainment(winBase(s.run, { extraRoots: [L.extra] }))
    expect(refusal(r)).toBe(`the extra folder ${L.extra} could not be labelled low integrity (${L.extra}: Access is denied.)`)
    // `work`: the failed establish sets its own sandbox back too since 2026-11-24.
    expect(s.work('M')).toEqual([L.mission])
    const [rec] = containmentRecords({ sandboxRoot: L.root })
    expect(s.sandboxM()).toEqual(['home', 'tmp', 'scratch'].map(d => join(L.root, rec.runId, d)))
    expect(rec.releasedBy).toBe('failed-establish')
    expect(rec.releasedAt).not.toBeNull()
  })
})

// ─── adoptContainment ───────────────────────────────────────────────────────────────────────────

describe('adoptContainment', () => {
  function made(over: Partial<Parameters<typeof establishContainment>[0]> = {}): RunContainment {
    return established(establishContainment(base({ extraRoots: [L.extra], ...over })))
  }
  const adopt = (runId: string | null, over: Partial<Parameters<typeof adoptContainment>[0]> = {}) =>
    adoptContainment({ runId, missionCwd: L.mission, who: 'engine', sandboxRoot: L.root, probe: false, platform: 'linux', ...over })

  it('builds the context from the record and holds it', () => {
    const c = made()
    const r = adopt(c.runId)
    if (!r.ok) throw new Error(r.reason)
    expect(r.containment.folders).toEqual(readRec(c.runId).folders)
    expect(r.containment.home).toBe(L.home)
    expect(r.containment.extraRoots).toEqual([L.extra])
    expect(r.containment.unprotectedVolumes).toEqual([])
    expect(r.containment.test).toBe(false)
    expect(readRec(c.runId).holder?.pid).toBe(process.pid)
    expect(adopt(c.runId).ok).toBe(true)
    expect(runContainment()).toBeNull()
  })

  it('the driver verifies and does not hold', () => {
    const c = made()
    expect(adopt(c.runId, { who: 'driver' }).ok).toBe(true)
    expect(readRec(c.runId).holder).toBeNull()
  })

  it('every refusal by its text', () => {
    const c = made()
    const path = recPath(c.runId)
    process.env.LOCALCODE_CONTAINMENT_OFF = 'paths'
    expect(refusal(adopt(c.runId))).toBe(SWITCH_IN_UNATTENDED)
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    expect(refusal(adopt(null))).toBe('no run id was handed to this engine (LOCALCODE_MISSION_RUN_ID is unset or malformed); a mission is started with scripts/dispatch-mission.sh, which creates the sandbox')
    expect(refusal(adopt('malformed', { who: 'engine' }))).toContain('no run id was handed to this engine')
    expect(refusal(adopt(null, { who: 'one-shot' }))).toBe('the task file names no sandbox (runId); a one-shot is started by the daemon or the campaign runner, which create it')
    expect(refusal(adopt(null, { who: 'driver' }))).toBe('the driver was handed no run id (LOCALCODE_MISSION_RUN_ID is unset or malformed); it is started by scripts/dispatch-mission.sh')
    expect(refusal(adopt(c.runId, { missionCwd: '' }))).toBe('this run was not told its mission folder')
    const other = mintRunId('other')
    expect(refusal(adopt(other))).toMatch(new RegExp(`^no containment record at .*${other}.*containment\\.json \\(`))
    expect(refusal(adopt(c.runId, { missionCwd: L.extra }))).toBe(`the containment record ${path} is for ${L.mission}, not for this run's folder ${L.extra}`)
    expect(refusal(adopt(c.runId, { platform: 'win32' }))).toBe(LAUNCHER_UNAVAILABLE('not Bun'))
    editRec(c.runId, r => { r.holder = { pid: process.ppid, startedAt: new Date().toISOString() } })
    expect(refusal(adopt(c.runId))).toBe(`the containment record ${path} is already held by pid ${process.ppid}`)
    editRec(c.runId, r => { r.holder = null })
    rmdirSync(join(L.root, c.runId, 'tmp'))
    expect(refusal(adopt(c.runId))).toBe(`the sandbox folder ${join(L.root, c.runId, 'tmp')} is missing`)
    editRec(c.runId, r => { (r as { schema: number }).schema = 2 })
    expect(refusal(adopt(c.runId))).toBe(`the containment record ${path} is not a version this engine reads (schema 2)`)
  })

  it('a record of another kind is refused by name', () => {
    const p = made({ kind: 'precheck' })
    expect(refusal(adopt(p.runId))).toBe(`the containment record ${recPath(p.runId)} is for a precheck run; the engine adopts only a mission record`)
    expect(refusal(adopt(p.runId, { who: 'driver' }))).toBe(`the containment record ${recPath(p.runId)} is for a precheck run; the driver adopts only a mission record`)
    const m = made()
    expect(refusal(adopt(m.runId, { who: 'one-shot' }))).toBe(`the containment record ${recPath(m.runId)} is for a mission run; a one-shot adopts only a daemon-task record`)
    const noGit = join(dir, 'task')
    mkdirSync(noGit)
    const t = made({ kind: 'daemon-task', missionCwd: noGit, extraRoots: [] })
    expect(adopt(t.runId, { who: 'one-shot', missionCwd: noGit }).ok).toBe(true)
  })

  it('a record made by a test, and a released record, cannot serve a run', () => {
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    const t = made({ test: true })
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    expect(refusal(adopt(t.runId))).toBe('this containment record was made by a test and cannot serve a run')
    const c = made()
    releaseContainment(c.runId, { sandboxRoot: L.root, platform: 'linux' })
    expect(refusal(adopt(c.runId))).toBe(`the containment record ${recPath(c.runId)} was released at ${readRec(c.runId).releasedAt}`)
  })
})

// ─── releaseContainment ─────────────────────────────────────────────────────────────────────────

describe('releaseContainment', () => {
  function labelledRun(s: ReturnType<typeof seam>): RunContainment {
    return established(establishContainment(winBase(s.run, { extraRoots: [L.extra] })))
  }

  it('marks the record and sets each labelled folder back to medium, never with /T', () => {
    const s = seam()
    const c = labelledRun(s)
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(true)
    // `work`: the sandbox is set back as well since 2026-11-24, after the folders.
    expect(r.work('M')).toEqual([L.mission, L.extra])
    expect(r.sandboxM()).toEqual([c.sandbox.home, c.sandbox.tmp, c.sandbox.scratch])
    expect(r.calls.some(x => x.args.some(a => a.toUpperCase() === '/T'))).toBe(false)
    expect(readRec(c.runId).releasedBy).toBe('release')
    const again = releaseContainment(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r.run })
    expect(again.note).toBe(`run ${c.runId} was already released at ${readRec(c.runId).releasedAt}`)
    expect(r.labels('M')).toHaveLength(5)
  })

  it('leaves a folder another live run holds, and says which', () => {
    const first = labelledRun(seam())
    const second = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    const r = seam()
    const res = releaseContainment(second, { platform: 'win32', run: r.run })
    // `work`: the folders another run holds stay low; the released run's own sandbox does not.
    expect(r.work('M')).toEqual([])
    expect(r.sandboxM()).toEqual([second.sandbox.home, second.sandbox.tmp, second.sandbox.scratch])
    expect(res.note).toContain(`${L.mission} stays labelled low: run ${first.runId} still holds it`)
  })

  it('relabels when the other run\'s holder is gone, or it has had no holder for 15 minutes', () => {
    const first = labelledRun(seam())
    const second = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = { pid: deadPid(), startedAt: new Date().toISOString() } })
    const r = seam()
    releaseContainment(second, { platform: 'win32', run: r.run })
    expect(r.work('M')).toEqual([L.mission, L.extra])
    const third = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = null; rec.createdAt = new Date(Date.now() - 20 * 60_000).toISOString() })
    const r2 = seam()
    releaseContainment(third, { platform: 'win32', run: r2.run })
    expect(r2.work('M')).toEqual([L.mission, L.extra])
  })

  it('sets the folder low again when a run became active during the relabel', () => {
    const first = labelledRun(seam())
    releaseContainment(first, { platform: 'win32', run: seam().run })
    const second = labelledRun(seam())
    const r = seam({
      before: call => {
        if (exeOf(call.file) === 'icacls.exe' && call.args[0] === L.mission && call.args[2] === '(OI)(CI)M') {
          editRec(first.runId, rec => { rec.releasedAt = null; delete rec.releasedBy; rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
        }
      },
    })
    const res = releaseContainment(second, { platform: 'win32', run: r.run })
    expect(r.labels('L')).toEqual([L.mission])
    expect(res.note).toContain(`${L.mission} was labelled low again: run ${first.runId} became active during the release`)
  })

  it('rule R4: a low label the run set itself under the folder is set back; an inherited one is left; links are not entered', () => {
    mkdirSync(join(L.mission, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(L.mission, 'f.txt'), 'x')
    writeFileSync(join(L.mission, 'g.txt'), 'x')
    writeFileSync(join(L.mission, 'sub', 'deeper', 'h.txt'), 'x')
    writeFileSync(join(L.outside, 'never-listed.txt'), 'x')
    const c = labelledRun(seam())
    link(L.outside, join(L.mission, 'jn'))
    const block = (p: string, label: string) => `${p} NT AUTHORITY\\SYSTEM:(I)(F)\r\n          Mandatory Label\\${label}\r\n\r\n`
    const r = seam({
      icacls: args => {
        if (args[1] !== '/L' || args.length !== 2) return undefined
        if (args[0] === join(L.mission, '*')) {
          // f.txt carries the run's own label; g.txt an inherited one; sub its own; .git and jn
          // are not in the listing and are asked on their own.
          return { ok: true, out: block(join(L.mission, 'f.txt'), 'Low Mandatory Level:(NW)') + block(join(L.mission, 'g.txt'), 'Low Mandatory Level:(I)(NW)') + block(join(L.mission, 'sub'), 'Low Mandatory Level:(OI)(CI)(NW)') + 'Successfully processed 3 files; Failed processing 0 files\r\n' }
        }
        if (args[0] === join(L.mission, 'jn')) return { ok: true, out: block(args[0], 'Low Mandatory Level:(OI)(CI)(NW)') }
        return undefined
      },
    })
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const resets = r.calls.filter(x => x.args[1] === '/L' && x.args[2] === '/setintegritylevel').map(x => [x.args[0], x.args[3]])
    expect(resets).toEqual(expect.arrayContaining([[join(L.mission, 'f.txt'), 'M'], [join(L.mission, 'sub'), '(OI)(CI)M'], [join(L.mission, 'jn'), 'M']]))
    expect(resets).toHaveLength(3)
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    expect(listed).toContain(join(L.mission, 'sub', '*'))
    expect(listed).toContain(join(L.mission, 'sub', 'deeper', '*'))
    expect(listed).not.toContain(join(L.mission, 'jn', '*'))
    expect(listed.some(a => a.startsWith(L.outside))).toBe(false)
    expect(r.calls.some(x => x.args.some(a => a.toUpperCase() === '/T'))).toBe(false)
    expect(res.note).toContain(`${L.mission} set back to medium integrity (`)
    expect(res.note).toContain('3 set back')
  })

  it('rule R4: an entry under the folder whose low label cannot be set back makes the release say so', () => {
    writeFileSync(join(L.mission, 'f.txt'), 'x')
    const c = labelledRun(seam())
    const r = seam({
      icacls: args => {
        if (args[0] === join(L.mission, '*') && args[1] === '/L') return { ok: true, out: `${join(L.mission, 'f.txt')} Mandatory Label\\Low Mandatory Level:(NW)\r\n` }
        if (args[0] === join(L.mission, 'f.txt') && args[2] === '/setintegritylevel') return { ok: false, out: 'Access is denied.' }
        return undefined
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${L.mission}: 1 entry under it may still be labelled low (${join(L.mission, 'f.txt')} could not be set back (Access is denied.))`)
  })

  it('a missing record and a missing folder are notes; a failed relabel is logged; nothing throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const id = mintRunId('nobody')
    expect(releaseContainment(id, { sandboxRoot: L.root, platform: 'win32', run: seam().run })).toEqual({ relabelled: false, note: `no containment record for ${id}` })
    const c = labelledRun(seam())
    rmSync(L.extra, { recursive: true })
    const r = seam({ icacls: args => (args[0] === L.mission ? { ok: false, out: 'Access is denied.' } : undefined) })
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${L.mission} could not be set back to medium integrity (Access is denied.)`)
    expect(res.note).toContain(`${L.extra} is missing`)
    expect(log.mock.calls.map(x => String(x[0])).some(l => l.startsWith('[containment] run ') && l.includes('could not be set back'))).toBe(true)
  })

  // NOW.md:78: a released sandbox stayed labelled low until the seven-day sweep, so another run could
  // write it or make a junction to it, and a live low process could rename in it while it was swept.
  it('NOW.md:78: a release sets the sandbox\'s home, tmp and scratch back to medium with the walk, never /T; a precheck sandbox too', () => {
    const c = labelledRun(seam())
    // P2-F8 (b): an entry in each of the three, so a walk of only one of them is seen.
    writeFileSync(join(c.sandbox.scratch, 'made.txt'), 'x')
    writeFileSync(join(c.sandbox.tmp, 'made.txt'), 'x')
    mkdirSync(join(c.sandbox.home, 'made'))
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    expect(r.sandboxM()).toEqual([c.sandbox.home, c.sandbox.tmp, c.sandbox.scratch])
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    for (const d of [c.sandbox.home, c.sandbox.tmp, c.sandbox.scratch]) expect(listed).toContain(join(d, '*'))
    expect(r.calls.some(x => x.args.some(a => a.toUpperCase() === '/T'))).toBe(false)
    expect(res.note).toMatch(/; the sandbox's home, tmp and scratch set back to medium integrity \(\d+ folders? read for labels set under them\)$/)
    // A sandbox whose folder carries no label (a precheck): before, the release returned before any
    // icacls call and the sandbox stayed low.
    const p = established(establishContainment(winBase(seam().run, { labelCwd: false, kind: 'precheck' })))
    const r2 = seam()
    const res2 = releaseContainment(p, { platform: 'win32', run: r2.run })
    expect(r2.work('M')).toEqual([])
    expect(r2.sandboxM()).toEqual([p.sandbox.home, p.sandbox.tmp, p.sandbox.scratch])
    expect(res2.note.startsWith(`run ${p.runId} released; the sandbox's home, tmp and scratch set back to medium integrity (`)).toBe(true)
    // Off Windows nothing is labelled, and the note is as it was.
    const lin = established(establishContainment(base({ test: true })))
    const linRun = seam()
    expect(releaseContainment(lin, { platform: 'linux', run: linRun.run }).note).toBe(`run ${lin.runId} released`)
    expect(linRun.calls).toEqual([])
  })

  it('NOW.md:78: a sandbox folder that cannot be set back makes the release say so, and relabelled is false', () => {
    const c = labelledRun(seam())
    const r = seam({ icacls: args => (args[0] === c.sandbox.tmp && args[1] === '/setintegritylevel' ? { ok: false, out: 'tmp: Access is denied.' } : undefined) })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`the sandbox ${c.sandbox.root} may still be labelled low in 1 place (${c.sandbox.tmp} could not be set back to medium integrity (tmp: Access is denied.))`)
  })

  // NOW.md:110: a low process may turn inheritance off on what it can write; release read labels only.
  it('NOW.md:110: an entry with inheritance turned off gets it back (icacls /reset /L, after its label); an inheriting entry is left', () => {
    writeFileSync(join(L.mission, 'off.txt'), 'x')
    writeFileSync(join(L.mission, 'on.txt'), 'x')
    const c = labelledRun(seam())
    const r = seam({
      icacls: args => {
        if (args[0] === join(L.mission, '*') && args[1] === '/L' && args.length === 2) {
          return {
            ok: true,
            out: `${join(L.mission, 'off.txt')} PC\\owner:(F)\r\n          Mandatory Label\\Low Mandatory Level:(NW)\r\n\r\n`
              + `${join(L.mission, 'on.txt')} NT AUTHORITY\\SYSTEM:(I)(F)\r\n          PC\\owner:(I)(F)\r\n          Mandatory Label\\Low Mandatory Level:(I)(NW)\r\n\r\nSuccessfully processed 2 files; Failed processing 0 files\r\n`,
          }
        }
        return undefined
      },
    })
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const off = r.calls.map((x, i) => ({ x, i })).filter(({ x }) => x.args[0] === join(L.mission, 'off.txt'))
    expect(off.map(({ x }) => x.args.slice(1))).toEqual([['/L', '/setintegritylevel', 'M'], ['/reset', '/L']])
    expect(r.calls.some(x => x.args[0] === join(L.mission, 'on.txt') && x.args[1] === '/reset')).toBe(false)
    expect(res.note).toContain(`set back to medium integrity (`)
    expect(res.note).toContain(`; inheritance turned back on for 1: ${join(L.mission, 'off.txt')}`)
    // The acceptance reads the count right after the opening bracket (releaseWalkOutcome).
    expect(res.note).toMatch(new RegExp(`${L.mission.replace(/\\/g, '\\\\')} set back to medium integrity \\(\\d+ folders? read`))
  })

  // P2-F6 (wave 15b): the reset above was applied to every entry with inheritance off, so an entry of
  // the owner's that had it off on purpose before the run (a protected secrets file; pytest's
  // .pytest_cache is one, measured) lost its own access list at release.
  const offBlock = (p: string) => `${p} PC\\owner:(F)\r\n          Mandatory Label\\Low Mandatory Level:(NW)\r\n\r\n`
  it('P2-F6: an entry of a work folder that had inheritance off before the run is never reset, and is named; one the run turned off is; in the sandbox every one is', () => {
    const before = join(L.mission, 'off-before.txt'), byRun = join(L.mission, 'off-run.txt'), extraBefore = join(L.extra, 'kept.txt')
    for (const f of [before, byRun, extraBefore]) writeFileSync(f, 'x')
    const s = seam({
      inherit: args => {
        const script = String(args.at(-1))
        if (script.includes(`'${L.mission}'`)) return { ok: true, out: `off|${before}\r\ncynco-inheritance-read|4\r\n` }
        if (script.includes(`'${L.extra}'`)) return { ok: true, out: `link|${extraBefore}\r\ncynco-inheritance-read|1\r\n` }
        return undefined
      },
    })
    const c = established(establishContainment(winBase(s.run, { extraRoots: [L.extra] })))
    const rec = readRec(c.runId)
    expect(rec.inheritanceBefore).toEqual([
      { folder: L.mission, listFile: join(c.sandbox.root, 'inheritance-0.before'), count: 1 },
      { folder: L.extra, listFile: join(c.sandbox.root, 'inheritance-1.before'), count: 1 },
    ])
    expect(readFileSync(join(c.sandbox.root, 'inheritance-0.before'), 'utf-8')).toBe(`${before}\n`)
    // The read comes before any label or grant on the work folders, and reads without changing anything.
    const read = s.calls.findIndex(x => String(x.args.at(-1)).includes('cynco-inheritance-read|'))
    const firstWorkLabel = s.calls.findIndex(x => exeOf(x.file) === 'icacls.exe' && x.args[0] === L.mission && x.args.length > 1)
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(firstWorkLabel)
    expect(s.calls[read].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(String(s.calls[read].args.at(-1))).not.toMatch(/Set-Acl|SetAccessControl|icacls/)
    const runOff = join(c.sandbox.scratch, 'run-off.txt')
    writeFileSync(runOff, 'x')
    const r = seam({
      icacls: args => {
        if (args[1] !== '/L' || args.length !== 2) return undefined
        if (args[0] === join(L.mission, '*')) return { ok: true, out: offBlock(before) + offBlock(byRun) }
        if (args[0] === join(L.extra, '*')) return { ok: true, out: offBlock(extraBefore) }
        if (args[0] === join(c.sandbox.scratch, '*')) return { ok: true, out: offBlock(runOff) }
        return undefined
      },
    })
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const resets = r.calls.filter(x => x.args[1] === '/reset').map(x => x.args[0])
    expect(resets).toEqual([byRun, runOff])
    expect(res.note).toContain(`; inheritance turned back on for 1: ${byRun}; inheritance left off for 1, which had it off before this run: ${before})`)
    expect(res.note).toContain(`${L.extra} set back to medium integrity (1 folder read for labels set under it; 1 set back: ${extraBefore}; inheritance left off for 1, which had it off before this run: ${extraBefore})`)
    expect(res.note).toContain(`inheritance turned back on for 1: ${runOff}`)
  })

  it('P2-F6: when the establish could not read a work folder, or the record keeps no list (an older engine), nothing under it is reset, and the release says why', () => {
    const off = join(L.mission, 'off.txt')
    writeFileSync(off, 'x')
    const offListing = { icacls: (args: string[]) => (args[0] === join(L.mission, '*') && args[1] === '/L' && args.length === 2 ? { ok: true, out: offBlock(off) } : undefined) }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const unread = established(establishContainment(winBase(seam({ inherit: () => ({ ok: false, out: 'Exception calling "GetAccessControl": denied' }) }).run)))
    // P2-B5 (wave 15c): the reason says what happened to the read, then its last line (before, the bare
    // last line, which after a cut is a path such as 'off|C:\...' and read as if that entry were the cause).
    expect(readRec(unread.runId).inheritanceBefore).toEqual([{ folder: L.mission, unread: 'the read failed or was cut at its cap of 300 s; its last line: Exception calling "GetAccessControl": denied' }])
    const r = seam(offListing)
    const res = releaseContainment(unread, { platform: 'win32', run: r.run })
    expect(r.calls.some(x => x.args[1] === '/reset')).toBe(false)
    expect(res.note).toContain(`inheritance left off for 1, what had it off before the run could not be read (the read failed or was cut at its cap of 300 s; its last line: Exception calling "GetAccessControl": denied): ${off}`)
    // A walk that never said it finished (stopped part way) is unread as well.
    const cut = established(establishContainment(winBase(seam({ inherit: () => ({ ok: true, out: `off|${off}\r\n` }) }).run)))
    expect(readRec(cut.runId).inheritanceBefore?.[0].unread).toBe(`the read did not say it finished; its last line: off|${off}`)
    releaseContainment(cut, { platform: 'win32', run: seam().run })
    const older = established(establishContainment(winBase(seam().run)))
    editRec(older.runId, rec => { delete rec.inheritanceBefore })
    const r2 = seam(offListing)
    const res2 = releaseContainment(older, { platform: 'win32', run: r2.run })
    expect(r2.calls.some(x => x.args[1] === '/reset')).toBe(false)
    expect(res2.note).toContain(`inheritance left off for 1, this run's record keeps no list of what had it off before the run: ${off}`)
  })

  // R1 F1 (checker-1): the grant that let a folder be labelled was never undone: a lasting change to the owner's folder.
  it('R1 F1: the access list is saved before the grant, in the run folder, and put back after the folder is set back', () => {
    let tries = 0
    const saves: string[][] = []
    const s = seam({
      icacls: args => {
        if (args[1] === '/save') {
          saves.push(args)
          writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)(A;OICIID;FA;;;SY)\r\n`, 'utf16le'))
          return { ok: true, out: 'Successfully processed 1 files; Failed processing 0 files\r\n' }
        }
        return args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: `${args[0]}: Access is denied.` } : undefined
      },
    })
    const c = established(establishContainment(winBase(s.run)))
    const order = s.icacls().filter(x => x.args[0] === L.mission).map(x => x.args[1])
    expect(order).toEqual(['/setintegritylevel', '/save', '/grant', '/setintegritylevel'])
    expect(saves).toEqual([[L.mission, '/save', join(c.sandbox.root, 'acl-0.before'), '/c']])
    const rec = readRec(c.runId)
    expect(rec.cwdGranted).toBe(true)
    expect(rec.grants).toEqual([{ folder: L.mission, aclFile: join(c.sandbox.root, 'acl-0.before') }])
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const ps = r.calls.findIndex(x => exeOf(x.file) === 'powershell.exe' && String(x.args.at(-1)).includes('SetAccessControl'))
    const relabel = r.calls.findIndex(x => x.args[0] === L.mission && x.args[2] === '(OI)(CI)M')
    expect(ps).toBeGreaterThan(relabel)
    // P2-F8 (c): after the whole walk under the folder too, not only after its own relabel.
    const lastListing = r.calls.map((x, i) => ({ x, i })).filter(({ x }) => x.args.length === 2 && x.args[1] === '/L' && fold(x.args[0]).startsWith(`${fold(L.mission)}/`)).map(({ i }) => i)
    expect(lastListing.length).toBeGreaterThan(0)
    expect(ps).toBeGreaterThan(Math.max(...lastListing))
    const script = r.calls[ps].args.at(-1)!
    expect(r.calls[ps].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(script).toContain("SetSecurityDescriptorSddlForm('D:AI(A;;FR;;;BU)(A;OICIID;FA;;;SY)', [System.Security.AccessControl.AccessControlSections]::Access)")
    expect(script).toContain(`[System.IO.Directory]::SetAccessControl('${L.mission.replace(/'/g, "''")}', $ds)`)
    expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was put back`)
  })

  it('R1 F1: a restore that fails, a copy that names another folder, and a held folder are said, and relabelled is false', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const granted = () => {
      let tries = 0
      return established(establishContainment(winBase(seam({
        icacls: args => {
          if (args[1] === '/save') {
            writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)\r\n`, 'utf16le'))
            return { ok: true, out: 'ok' }
          }
          return args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: 'Access is denied.' } : undefined
        },
      }).run)))
    }
    const a = granted()
    const failed = releaseContainment(a, { platform: 'win32', run: seam({ ps: () => ({ ok: false, out: 'Exception calling "SetAccessControl"' }) }).run })
    expect(failed.relabelled).toBe(false)
    expect(failed.note).toContain(`${L.mission}: the access list saved before this run's grant could not be put back (Exception calling "SetAccessControl"); the copy is ${join(a.sandbox.root, 'acl-0.before')}`)
    const b = granted()
    writeFileSync(join(b.sandbox.root, 'acl-0.before'), Buffer.from('other\r\nD:AI(A;;FA;;;WD)\r\n', 'utf16le'))
    const r = seam()
    const wrong = releaseContainment(b, { platform: 'win32', run: r.run })
    expect(wrong.relabelled).toBe(false)
    expect(wrong.note).toContain(`the saved copy names other, not ${basename(L.mission)}`)
    expect(r.calls.some(x => exeOf(x.file) === 'powershell.exe')).toBe(false)
    const holder = granted()
    const held = granted()
    editRec(holder.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    const kept = releaseContainment(held, { platform: 'win32', run: seam().run })
    expect(kept.relabelled).toBe(false)
    expect(kept.note).toContain(`${L.mission}: the access-list grant made for this run was not undone, because run ${holder.runId} still holds the folder; its saved access list is ${join(held.sandbox.root, 'acl-0.before')}`)
  })

  // P2-F2 (wave 15b): writing a folder's access list back makes Windows recompute what everything
  // under it inherited; a link the run left under it that leads out must not carry that rewrite.
  it('P2-F2: a granted folder holding a link that leads outside it keeps the grant, said, and no access list is written', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let tries = 0
    const c = established(establishContainment(winBase(seam({
      icacls: args => {
        if (args[1] === '/save') {
          writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)\r\n`, 'utf16le'))
          return { ok: true, out: 'ok' }
        }
        return args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: 'Access is denied.' } : undefined
      },
    }).run)))
    mkdirSync(join(L.mission, 'deep'))
    link(L.outside, join(L.mission, 'deep', 'out'))
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was not put back, because ${join(L.mission, 'deep', 'out')} leads outside it (to ${L.outside}); writing it rewrites what every entry under the folder inherited; its saved access list is ${join(c.sandbox.root, 'acl-0.before')}`)
    expect(r.calls.some(x => String(x.args.at(-1)).includes('SetAccessControl'))).toBe(false)
    // The label was still set back; the grant alone is kept.
    expect(r.work('M')).toEqual([L.mission])
  })

  // P2-F2: a grant cut at its cap has already changed the folder's access list (and part of what is
  // under it); the copy saved before it must be put back by the failed establish, so it is recorded first.
  it('P2-F2: a grant that fails or is cut is put back from the saved copy by the failed establish; the caps of the grant and the restore', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const caps: Array<[string, number]> = []
    const s = seam({
      icacls: args => {
        if (args[1] === '/save') {
          writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)\r\n`, 'utf16le'))
          return { ok: true, out: 'ok' }
        }
        if (args[0] === L.mission && args[1] === '/setintegritylevel') return { ok: false, out: 'Access is denied.' }
        if (args[0] === L.mission && args[1] === '/grant') return { ok: false, out: 'ETIMEDOUT' }
        return undefined
      },
    })
    const run: ContainmentRunner = (file, args, cap) => { caps.push([exeOf(file) === 'powershell.exe' ? (String(args.at(-1)).includes('SetAccessControl') ? 'restore' : 'powershell') : `${exeOf(file)} ${args[1] ?? ''}`, cap]); return s.run(file, args, cap) }
    const r = establishContainment(winBase(run))
    expect(refusal(r)).toBe(`the mission folder ${L.mission} could not be labelled low integrity (ETIMEDOUT)`)
    const restore = s.calls.find(x => String(x.args.at(-1)).includes('SetAccessControl'))
    expect(restore, 'the saved access list was not put back').toBeDefined()
    expect(String(restore!.args.at(-1))).toContain(`[System.IO.Directory]::SetAccessControl('${L.mission.replace(/'/g, "''")}', $ds)`)
    const [rec] = containmentRecords({ sandboxRoot: L.root })
    expect(rec.grants).toEqual([{ folder: L.mission, aclFile: join(L.root, rec.runId, 'acl-0.before') }])
    // Measured 2026-11-24 on 100,100 entries: the grant 6.6 s, the restore 6.7 s; the cap is ample for rule M's 200,000.
    expect(caps.filter(([k]) => k === 'icacls.exe /grant' || k === 'restore').map(([, cap]) => cap)).toEqual([120_000, 120_000, 120_000])
  })

  /** A mission folder whose first label fails, so it is granted; its access list is saved by the seam. */
  function grantedSeam(o: { onGrant?: () => void; grantOk?: boolean } = {}) {
    let tries = 0
    return seam({
      icacls: args => {
        if (args[1] === '/save') {
          writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)\r\n`, 'utf16le'))
          return { ok: true, out: 'ok' }
        }
        if (args[0] === L.mission && args[1] === '/grant') {
          o.onGrant?.()
          return o.grantOk === false ? { ok: false, out: 'Access is denied.' } : undefined
        }
        return args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: 'Access is denied.' } : undefined
      },
    })
  }
  const restoreCalls = (calls: Call[]) => calls.filter(x => exeOf(x.file) === 'powershell.exe' && String(x.args.at(-1)).includes('SetAccessControl'))

  // P2-B3 (wave 15c): every F2 case had a link that leads out (rule M's `link` answer); a link whose
  // target cannot be resolved (its `why` answer) blocks the restore too, at release and after a failed establish.
  it('P2-B3: a granted folder holding a link whose target cannot be resolved keeps the grant at release; no access list is written', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const gone = join(dir, 'gone-later')
    mkdirSync(gone)
    link(gone, join(L.mission, 'dangling'))
    rmdirSync(gone)
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was not put back, because the folder holds a link whose target cannot be resolved (${join(L.mission, 'dangling')}: `)
    expect(restoreCalls(r.calls)).toEqual([])
  })

  it('P2-B3: after a failed establish, a granted folder holding a link whose target cannot be resolved gets no access list written, and the log says why', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lines.push(String(l)) })
    const gone = join(dir, 'gone-later')
    // The grant itself fails, after a link was made under the folder whose target is then removed.
    const s = grantedSeam({
      grantOk: false,
      onGrant: () => { mkdirSync(gone); link(gone, join(L.mission, 'dangling')); rmdirSync(gone) },
    })
    expect(refusal(establishContainment(winBase(s.run)))).toBe(`the mission folder ${L.mission} could not be labelled low integrity (Access is denied.)`)
    expect(restoreCalls(s.calls)).toEqual([])
    expect(lines.some(l => l.startsWith(`[containment] the access list of ${L.mission} could not be put back after a failed establish (the folder holds a link whose target cannot be resolved (${join(L.mission, 'dangling')}: `)), lines.join('\n')).toBe(true)
    // C7 (wave 19): kept in the record, so the sweep keeps the saved copy and restore-acl can put it back.
    const rec = containmentRecords({ sandboxRoot: L.root })[0]
    expect(rec.grantsKept).toEqual([{ folder: L.mission, aclFile: join(L.root, rec.runId, 'acl-0.before'), why: 'link' }])
  })

  // P2-B4 (wave 15c): a release that keeps a grant marked the record released, so nothing tried the
  // restore again, and the seven-day sweep deleted the saved copy the note pointed at.
  it('P2-B4: a kept grant is recorded and names the command; restoreKeptGrants puts it back once the link is gone', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    link(L.outside, join(L.mission, 'out'))
    const res = releaseContainment(c, { platform: 'win32', run: seam().run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`its saved access list is ${aclFile}; put it back with: bun scripts/cynco-sandbox.mjs restore-acl ${c.runId}`)
    // `why` since wave 19 (C6 b), on purpose: restore-acl sets a label back first when that is what kept it.
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'link' }])
    // Still blocked: nothing is written, the grant stays recorded.
    const r1 = seam()
    const still = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r1.run })
    expect(still.done).toBe(false)
    expect(still.note).toContain(`${L.mission}: the access list saved before this run's grant was not put back, because ${join(L.mission, 'out')} leads outside it (to ${L.outside})`)
    expect(restoreCalls(r1.calls)).toEqual([])
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'link' }])
    removeLinkEntry(join(L.mission, 'out'))
    const r2 = seam()
    const done = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r2.run })
    expect(done, done.note).toEqual({ done: true, note: `run ${c.runId}: ${L.mission}: the access list saved before this run's grant was put back` })
    expect(restoreCalls(r2.calls)).toHaveLength(1)
    expect(readRec(c.runId).grantsKept).toEqual([])
    // Nothing left to do, and a run id with no record, are said.
    expect(restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: seam().run })).toEqual({ done: true, note: `run ${c.runId} keeps no grant to put back` })
    expect(restoreKeptGrants('none-20261124T010203-abcd', { sandboxRoot: L.root, platform: 'win32', run: seam().run })).toEqual({ done: true, note: 'no containment record for none-20261124T010203-abcd' })
  })

  // C5 (wave 19): the record was marked released first and grantsKept written only at the end, so a
  // release that ended in between (a Stop, a restart, the watcher killed; the mission walk takes minutes)
  // left a granted folder with nothing that said so, and the sweep deleted the saved copy.
  it('C5: a release that ends part way has already kept the grant in the record; restore-acl sets the label back first, then puts it back', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    const s = seam()
    const crashing: ContainmentRunner = (file, args, cap) => {
      if (exeOf(file) === 'icacls.exe' && args[1] === '/L' && fold(args[0]).startsWith(`${fold(L.mission)}/`)) throw new Error('the process ended here')
      return s.run(file, args, cap)
    }
    expect(() => releaseContainment(c, { platform: 'win32', run: crashing })).toThrow('the process ended here')
    const rec = readRec(c.runId)
    expect(rec.releasedAt).not.toBeNull()
    expect(rec.grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'unfinished' }])
    // restore-acl does what the release did not get to: the folder's own label first, then the access list.
    const r = seam()
    const done = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r.run })
    expect(done, done.note).toEqual({ done: true, note: `run ${c.runId}: ${L.mission}: the access list saved before this run's grant was put back` })
    expect(r.work('M')).toEqual([L.mission])
    expect(restoreCalls(r.calls)).toHaveLength(1)
    expect(readRec(c.runId).grantsKept).toEqual([])
  })

  // R1 (check B, wave 19): the 'unfinished' write made a release that was still running (the mission
  // walk takes minutes) look like one that had ended: status said GRANT KEPT, and restore-acl wrote the
  // access list back under the walk. The releasing process is now in the record until the release ends.
  it('R1 (wave 19b): while another live process is releasing the run, restore-acl answers not done and runs nothing; once it is gone, it puts the grant back', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    const s = seam()
    const crashing: ContainmentRunner = (file, args, cap) => {
      if (exeOf(file) === 'icacls.exe' && args[1] === '/L' && fold(args[0]).startsWith(`${fold(L.mission)}/`)) throw new Error('the process ended here')
      return s.run(file, args, cap)
    }
    expect(() => releaseContainment(c, { platform: 'win32', run: crashing })).toThrow('the process ended here')
    // Changed on purpose by BB-4 (wave 19c): a release that throws in a process that keeps running clears its
    // `releasing` before the error leaves it (the case below); a process that really ends mid-walk leaves its
    // own pid there, dead, which the next lines stand for by writing the field.
    expect(readRec(c.runId).releasing).toBeUndefined()
    expect(releaseInProgress(readRec(c.runId))).toBeNull()
    // Another live process (this test's parent stands for it) is releasing: nothing is done.
    editRec(c.runId, rec => { rec.releasing = { pid: process.ppid, startedAt: new Date().toISOString() } })
    expect(releaseInProgress(readRec(c.runId))).toBe(process.ppid)
    const r1 = seam()
    const wait = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r1.run })
    expect(wait).toEqual({ done: false, note: `run ${c.runId} is still being released by process ${process.ppid}; restore-acl waits until that release has ended` })
    expect(r1.calls).toEqual([])
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'unfinished' }])
    // That process is gone: restore-acl does what the release did not get to.
    editRec(c.runId, rec => { rec.releasing = { pid: deadPid(), startedAt: new Date().toISOString() } })
    expect(releaseInProgress(readRec(c.runId))).toBeNull()
    const done = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: seam().run })
    expect(done.done, done.note).toBe(true)
    // A release that runs to its end leaves no releasing process in the record.
    const d = established(establishContainment(winBase(grantedSeam().run)))
    expect(releaseContainment(d, { platform: 'win32', run: seam().run }).relabelled).toBe(true)
    expect(readRec(d.runId).releasing).toBeUndefined()
  })

  // BB-4 (check B, wave 19b): a release that threw inside a process that keeps running (the daemon's sweep
  // catches per record and runs for days) left `releasing` naming that live process, so restore-acl waited
  // and status said RELEASE IN PROGRESS for as long as the daemon lived.
  it('BB-4: a release that throws in this process leaves no releasing process on disk; the grant stays kept as unfinished, and restore-acl acts', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    const s = seam()
    let seen: ContainmentRecord['releasing'] | 'unread' = 'unread'
    const crashing: ContainmentRunner = (file, args, cap) => {
      if (exeOf(file) === 'icacls.exe' && args[1] === '/L' && fold(args[0]).startsWith(`${fold(L.mission)}/`)) {
        seen = readRec(c.runId).releasing
        throw new Error('a walk that threw')
      }
      return s.run(file, args, cap)
    }
    expect(() => releaseContainment(c, { platform: 'win32', run: crashing })).toThrow('a walk that threw')
    // While it walked, the record named this process; the error took it out again before it left.
    expect(seen).toMatchObject({ pid: process.pid })
    const rec = readRec(c.runId)
    expect(rec.releasing).toBeUndefined()
    expect(rec.releasedAt).not.toBeNull()
    expect(rec.grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'unfinished' }])
    // Another process reading it (status, restore-acl) sees no release in progress.
    expect(releaseInProgress(rec)).toBeNull()
    const done = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: seam().run })
    expect(done.done, done.note).toBe(true)
  })

  it('C5: a release that finishes leaves no grant kept, and one whose restore is blocked keeps it with its reason', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const res = releaseContainment(c, { platform: 'win32', run: seam().run })
    expect(res.relabelled, res.note).toBe(true)
    expect(readRec(c.runId).grantsKept).toBeUndefined()
  })

  // C6 (wave 19): three gaps of restore-acl.
  it('C6 (a): a kept grant whose folder is gone is dropped and said; nothing is written', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    link(L.outside, join(L.mission, 'out'))
    releaseContainment(c, { platform: 'win32', run: seam().run })
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'link' }])
    removeLinkEntry(join(L.mission, 'out'))
    links = []
    rmSync(L.mission, { recursive: true, force: true })
    const r = seam()
    const res = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r.run })
    expect(res).toEqual({ done: true, note: `run ${c.runId}: ${L.mission} is gone; nothing to put back` })
    expect(restoreCalls(r.calls)).toEqual([])
    expect(readRec(c.runId).grantsKept).toEqual([])
    mkdirSync(L.mission)
  })

  it('C6 (b): a grant kept because the label could not be set back is relabelled medium first; while that fails it stays kept and nothing is written', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    const deny = () => seam({ icacls: args => (args[0] === L.mission && args[1] === '/setintegritylevel' ? { ok: false, out: `${L.mission}: Access is denied.` } : undefined) })
    const res = releaseContainment(c, { platform: 'win32', run: deny().run })
    expect(res.relabelled).toBe(false)
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'label' }])
    const r1 = deny()
    const still = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r1.run })
    expect(still).toEqual({ done: false, note: `run ${c.runId}: ${L.mission}: not put back, because its label could not be set back to medium integrity first (${L.mission}: Access is denied.)` })
    expect(restoreCalls(r1.calls)).toEqual([])
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'label' }])
    const r2 = seam()
    const done = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r2.run })
    expect(done.done, done.note).toBe(true)
    expect(r2.work('M')).toEqual([L.mission])
    expect(restoreCalls(r2.calls)).toHaveLength(1)
  })

  it('C6 (c): a record that exists and cannot be read is not "no record": restore-acl answers not done', () => {
    const c = established(establishContainment(base()))
    writeFileSync(recPath(c.runId), '{ not json')
    const res = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: seam().run })
    expect(res.done).toBe(false)
    expect(res.note).toMatch(new RegExp(`^the record of ${c.runId} could not be read \\(`))
  })

  // C7 (wave 19): the paths no case read.
  it('C7: a release while another live run holds the folder keeps the grant, says how to put it back, and restore-acl waits for that run', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = established(establishContainment(winBase(grantedSeam().run)))
    const aclFile = join(c.sandbox.root, 'acl-0.before')
    const other = labelledRun(seam())
    editRec(other.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    const res = releaseContainment(c, { platform: 'win32', run: seam().run })
    expect(res.note).toContain(`${L.mission}: the access-list grant made for this run was not undone, because run ${other.runId} still holds the folder; its saved access list is ${aclFile}; put it back with: bun scripts/cynco-sandbox.mjs restore-acl ${c.runId}`)
    expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile, why: 'held' }])
    const r = seam()
    const still = restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r.run })
    expect(still).toEqual({ done: false, note: `run ${c.runId}: ${L.mission}: not put back, because run ${other.runId} still holds the folder` })
    expect(restoreCalls(r.calls)).toEqual([])
    expect(r.work('M')).toEqual([])
  })

  it('C7: a failed establish whose sandbox holds more folders than the budget records sandboxLeftLow', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const s = grantedSeam({
      grantOk: false,
      onGrant: () => {
        const runDir = join(L.root, readdirSync(L.root).find(n => RUN_ID_RE.test(n))!)
        for (let i = 0; i < SANDBOX_SET_BACK_BUDGET.folders + 40; i++) {
          mkdirSync(join(runDir, 'scratch', `d${i}`))
          writeFileSync(join(runDir, 'scratch', `d${i}`, 'f.txt'), 'x')
        }
      },
    })
    expect(refusal(establishContainment(winBase(s.run)))).toBe(`the mission folder ${L.mission} could not be labelled low integrity (Access is denied.)`)
    const rec = containmentRecords({ sandboxRoot: L.root })[0]
    expect(rec.releasedBy).toBe('failed-establish')
    expect(rec.sandboxLeftLow?.folders).toBe(SANDBOX_SET_BACK_BUDGET.folders)
  })

  // P2-F9 (wave 15c): setting a released sandbox back cost one icacls start per folder, unbounded
  // (about 17 minutes for a CynCo-size tree in scratch, synchronously, on the daemon's event loop).
  it('wave 15c: the sandbox set-back stops at its folder budget, leaves the rest low, records it and says so; the mission folder\'s walk is not budgeted', () => {
    const N = SANDBOX_SET_BACK_BUDGET.folders + 40
    const c = labelledRun(seam())
    for (let i = 0; i < N; i++) {
      mkdirSync(join(c.sandbox.scratch, `d${i}`))
      writeFileSync(join(c.sandbox.scratch, `d${i}`, 'f.txt'), 'x')
      mkdirSync(join(L.mission, `m${i}`))
      writeFileSync(join(L.mission, `m${i}`, 'f.txt'), 'x')
    }
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    // A folder's one listing (`icacls "<dir>\*" /L`), not the per-entry reads that follow it.
    const listings = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L' && x.args[0].endsWith('*')).map(x => x.args[0])
    const under = (top: string) => listings.filter(p => fold(p).startsWith(`${fold(top)}/`))
    expect(under(c.sandbox.root)).toHaveLength(SANDBOX_SET_BACK_BUDGET.folders)
    // The mission folder itself, its .git and every one of the N folders: the owner's repository is walked whole.
    expect(under(L.mission)).toHaveLength(N + 2)
    expect(r.sandboxM()).toEqual([c.sandbox.home, c.sandbox.tmp, c.sandbox.scratch])
    expect(res.relabelled, res.note).toBe(true)
    expect(res.note).toContain(`; the sandbox was not set back past ${SANDBOX_SET_BACK_BUDGET.folders} folders; the sweep removes it`)
    expect(readRec(c.runId).sandboxLeftLow).toEqual({ folders: SANDBOX_SET_BACK_BUDGET.folders, at: readRec(c.runId).releasedAt })
    // C2 (wave 19), changed on purpose: the calls made for single entries inside a folder count too.
    expect(SANDBOX_SET_BACK_BUDGET).toEqual({ folders: 200, ms: 5_000, calls: 2_000 })
  })

  it('wave 15c: the sandbox set-back stops at its time budget', () => {
    const c = labelledRun(seam())
    for (let i = 0; i < 12; i++) {
      mkdirSync(join(c.sandbox.scratch, `d${i}`))
      writeFileSync(join(c.sandbox.scratch, `d${i}`, 'f.txt'), 'x')
    }
    const slow = seam()
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const run: ContainmentRunner = (file, args, cap) => {
      // Each folder's one listing is slow; the reads of single entries that follow it are not.
      if (args.length === 2 && args[1] === '/L' && args[0].endsWith('*') && fold(args[0]).startsWith(`${fold(c.sandbox.root)}/`)) Atomics.wait(wait, 0, 0, 700)
      return slow.run(file, args, cap)
    }
    const t0 = Date.now()
    const res = releaseContainment(c, { platform: 'win32', run })
    const ms = Date.now() - t0
    const n = Number(/the sandbox was not set back past (\d+) folders; the sweep removes it/.exec(res.note)?.[1])
    expect(n, res.note).toBeGreaterThan(0)
    expect(n).toBeLessThan(14)
    // The budget is checked before each folder: at most one listing past it.
    expect(ms).toBeLessThan(SANDBOX_SET_BACK_BUDGET.ms + 700 + 1_500)
    expect(readRec(c.runId).sandboxLeftLow?.folders).toBe(n)
  }, 60_000)

  it('C2 (wave 19): the budget holds inside one wide folder too: 500 entries the run labelled low, 20 ms a call, stop within the budget plus one call', () => {
    const c = labelledRun(seam())
    const wide = join(c.sandbox.scratch, 'wide')
    mkdirSync(wide)
    const N = 500
    for (let i = 0; i < N; i++) writeFileSync(join(wide, `f${i}.txt`), 'x')
    const s = seam({
      icacls: args => {
        // The folder's one listing: every entry carries a Low label of its own (not inherited).
        if (args.length === 2 && args[1] === '/L' && fold(args[0]) === fold(join(wide, '*'))) {
          const blocks = Array.from({ length: N }, (_, i) => `${join(wide, `f${i}.txt`)} BUILTIN\\Users:(I)(RX)\r\n      Mandatory Label\\Low Mandatory Level:(NW)\r\n`)
          return { ok: true, out: `${blocks.join('')}Successfully processed ${N} files; Failed processing 0 files\r\n` }
        }
        return undefined
      },
    })
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const run: ContainmentRunner = (file, args, cap) => {
      if (args.includes('/setintegritylevel') && fold(args[0]).startsWith(`${fold(wide)}/`)) Atomics.wait(wait, 0, 0, 20)
      return s.run(file, args, cap)
    }
    const t0 = Date.now()
    const res = releaseContainment(c, { platform: 'win32', run })
    const ms = Date.now() - t0
    // One call of 20 ms past the deadline at most, plus what the rest of the release costs here.
    expect(ms, res.note).toBeLessThan(SANDBOX_SET_BACK_BUDGET.ms + 20 + 1_500)
    expect(res.note).toMatch(/; the sandbox was not set back past \d+ folders; the sweep removes it/)
    expect(readRec(c.runId).sandboxLeftLow?.folders).toBeGreaterThan(0)
    const set = s.calls.filter(x => x.args.includes('/setintegritylevel') && fold(x.args[0]).startsWith(`${fold(wide)}/`))
    expect(set.length).toBeGreaterThan(0)
    expect(set.length).toBeLessThan(N)
  }, 60_000)

  it('C2 (wave 19): a folder\'s listing is read by an index, not by scanning every entry for every line', () => {
    const c = labelledRun(seam())
    const wide = join(c.sandbox.scratch, 'wide')
    mkdirSync(wide)
    const N = 4_000
    for (let i = 0; i < N; i++) writeFileSync(join(wide, `a file with spaces ${i}.txt`), 'x')
    const s = seam({
      icacls: args => {
        if (args.length === 2 && args[1] === '/L' && fold(args[0]) === fold(join(wide, '*'))) {
          // Every entry has a block, none labelled: no call follows the listing, only its parse.
          const blocks = Array.from({ length: N }, (_, i) => `${join(wide, `a file with spaces ${i}.txt`)} BUILTIN\\Users:(I)(RX)\r\n      NT AUTHORITY\\SYSTEM:(I)(F)\r\n`)
          return { ok: true, out: `${blocks.join('')}Successfully processed ${N} files; Failed processing 0 files\r\n` }
        }
        return undefined
      },
    })
    const t0 = Date.now()
    const res = releaseContainment(c, { platform: 'win32', run: s.run })
    const ms = Date.now() - t0
    expect(res.relabelled, res.note).toBe(true)
    expect(readRec(c.runId).sandboxLeftLow).toBeUndefined()
    // Each entry's block was found: none was asked on its own.
    expect(s.calls.filter(x => x.args.length === 2 && x.args[1] === '/L' && fold(x.args[0]).startsWith(`${fold(wide)}/a file`))).toEqual([])
    expect(ms, res.note).toBeLessThan(2_500)
  }, 120_000)

  it('R1 F1: a folder whose access list cannot be saved is granted nothing, and the establish refuses naming both lines', () => {
    const s = seam({
      icacls: args => (args[0] === L.mission && (args[1] === '/setintegritylevel' || args[1] === '/save') ? { ok: false, out: `${args[0]}: Access is denied.` } : undefined),
    })
    expect(refusal(establishContainment(winBase(s.run)))).toBe(`the mission folder ${L.mission} could not be labelled low integrity (${L.mission}: Access is denied.), and its access list could not be saved before the grant that would let it be labelled (${L.mission}: Access is denied.)`)
    expect(s.icacls().some(x => x.args[0] === L.mission && x.args[1] === '/grant')).toBe(false)
  })

  it('R1 F1: a record of an older engine with cwdGranted and no copy says the grant may still be there; it does not fail the release', () => {
    const c = labelledRun(seam())
    editRec(c.runId, rec => { rec.cwdGranted = true; delete rec.grants })
    const res = releaseContainment(c, { platform: 'win32', run: seam().run })
    expect(res.relabelled, res.note).toBe(true)
    expect(res.note).toContain(`the access list of ${L.mission}, ${L.extra} was widened for this run by an engine that kept no copy of it, so it was not put back`)
  })
})

// ─── sweepSandboxes and containmentRecords ──────────────────────────────────────────────────────

describe('sweepSandboxes', () => {
  const daysAgo = (d: number) => () => new Date(Date.now() - d * 24 * 3600_000)
  const quiet = () => undefined

  it('removes a run folder 8 days old and keeps one 6 days old', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const young = established(establishContainment(base({ now: daysAgo(6) })))
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: quiet })
    expect(res.removed).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
    expect(existsSync(join(L.root, young.runId))).toBe(true)
    expect(readRec(young.runId).releasedBy).toBe('holder-gone')
  })

  it('releases an active record whose holder is gone without removing it; never removes a held one', () => {
    const gone = established(establishContainment(base({ now: () => new Date(Date.now() - 3600_000) })))
    const held = established(establishContainment(base({ now: daysAgo(9) })))
    editRec(held.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: quiet })
    expect(res.removed).toEqual([])
    expect(readRec(gone.runId).releasedBy).toBe('holder-gone')
    expect(readRec(held.runId).releasedAt).toBeNull()
  })

  it('never touches what is not a run folder with its own record', () => {
    const design = join(L.root, '_design')
    mkdirSync(design)
    const noRecord = join(L.root, mintRunId('norecord'))
    mkdirSync(noRecord)
    const old = established(establishContainment(base({ now: daysAgo(10) })))
    const otherName = join(L.root, mintRunId('renamed'))
    mkdirSync(otherName)
    writeFileSync(join(otherName, 'containment.json'), readFileSync(recPath(old.runId)))
    writeFileSync(join(L.root, 'a-file.txt'), 'x')
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: quiet })
    expect(res.removed).toEqual([join(L.root, old.runId)])
    for (const p of [design, noRecord, otherName, join(L.root, 'a-file.txt')]) expect(existsSync(p), p).toBe(true)
  })

  it('a link inside an old sandbox is removed as an entry; what it points at is intact', () => {
    const sentinel = join(dir, 'sentinel')
    mkdirSync(sentinel)
    writeFileSync(join(sentinel, 'keep.txt'), 'keep')
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    symlinkSync(sentinel, join(old.sandbox.scratch, 'link'), 'junction')
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: quiet })
    expect(res.removed).toEqual([join(L.root, old.runId)])
    expect(readFileSync(join(sentinel, 'keep.txt'), 'utf-8')).toBe('keep')
  })

  it('a file symbolic link inside an old sandbox is removed as an entry; the file it points at is intact', t => {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'keep')
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const at = join(old.sandbox.scratch, 'fl')
    try {
      symlinkSync(target, at, 'file')
    } catch (e) {
      // What Windows' rmdir answers for a file symbolic link is then not measured on this system.
      console.log(`[containment] SKIPPED: a file symbolic link could not be made here (${(e as Error).message}); on Windows that takes Developer Mode or elevation`)
      t.skip()
      return
    }
    links.push(at)
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(readFileSync(target, 'utf-8')).toBe('keep')
  })

  it('refuses a root that contains the home folder, and removes nothing', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const homeInRoot = join(L.root, 'h')
    mkdirSync(homeInRoot)
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: homeInRoot, platform: 'linux', log: l => lines.push(l) })
    expect(res).toEqual({ removed: [], kept: 0 })
    expect(lines.join('\n')).toContain('the sweep refused')
    expect(existsSync(join(L.root, old.runId))).toBe(true)
  })

  // NOW.md:78: a sandbox released by an engine of before 2026-11-24 is still low when it is swept.
  it('NOW.md:78: on Windows the sweep sets a released sandbox back before it deletes; one that cannot be set back is kept and said', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const stuck = established(establishContainment(base({ now: daysAgo(9) })))
    for (const c of [old, stuck]) editRec(c.runId, rec => { rec.releasedAt = new Date(Date.now() - 7 * 24 * 3600_000).toISOString(); rec.releasedBy = 'release' })
    const s = seam({ icacls: args => (args[0] === stuck.sandbox.scratch && args[1] === '/setintegritylevel' ? { ok: false, out: 'scratch: Access is denied.' } : undefined) })
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s.run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(s.sandboxM()).toEqual(expect.arrayContaining([old.sandbox.home, old.sandbox.tmp, old.sandbox.scratch]))
    expect(existsSync(join(L.root, stuck.runId, 'containment.json'))).toBe(true)
    expect(lines).toContain(`[containment] the sweep keeps ${join(L.root, stuck.runId)}: the sandbox ${join(L.root, stuck.runId)} may still be labelled low in 1 place (${stuck.sandbox.scratch} could not be set back to medium integrity (scratch: Access is denied.))`)
    // Each sandbox is set back once in a pass: a record the sweep releases itself is not set back again.
    const fresh = established(establishContainment(base({ now: daysAgo(10) })))
    const s2 = seam()
    sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s2.run, log: () => undefined })
    expect(s2.sandboxM().filter(p => p.startsWith(fresh.sandbox.root))).toEqual([fresh.sandbox.home, fresh.sandbox.tmp, fresh.sandbox.scratch])
  })

  /** N folders of one file each under `at`. */
  const fill = (at: string, n: number) => {
    for (let i = 0; i < n; i++) {
      mkdirSync(join(at, `d${i}`))
      writeFileSync(join(at, `d${i}`, 'f.txt'), 'x')
    }
  }

  // Wave 15c: a release that stops at the set-back budget leaves the rest of its sandbox low, as every
  // release did before wave 15; the sweep removes such a sandbox exactly as it did then: by its listing
  // walk, which never enters a link, and without walking it again to set it back.
  it('wave 15c: a sandbox its release left low past the budget is removed by the listing walk, never set back again; a link in it is removed as an entry', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    fill(old.sandbox.scratch, SANDBOX_SET_BACK_BUDGET.folders + 40)
    const sentinel = join(dir, 'sentinel')
    mkdirSync(sentinel)
    writeFileSync(join(sentinel, 'keep.txt'), 'keep')
    link(sentinel, join(old.sandbox.scratch, 'zz-link'))
    const rel = releaseContainment(old, { platform: 'win32', run: seam().run })
    expect(rel.note).toContain(`the sandbox was not set back past ${SANDBOX_SET_BACK_BUDGET.folders} folders; the sweep removes it`)
    const s = seam()
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s.run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(s.calls.filter(x => x.args.some(a => fold(a).startsWith(fold(old.sandbox.root))))).toEqual([])
    expect(lines).toContain(`[containment] ${join(L.root, old.runId)}: its release did not set the sandbox back past ${SANDBOX_SET_BACK_BUDGET.folders} folders; the sweep removes it by its listing, never entering a link`)
    expect(readFileSync(join(sentinel, 'keep.txt'), 'utf-8')).toBe('keep')
  })

  it('wave 15c: the sweep\'s own set-back stops at the budget too, and the sandbox is removed all the same', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    // Released by an engine of before wave 15: nothing was set back, and the record says nothing about it.
    editRec(old.runId, rec => { rec.releasedAt = new Date(Date.now() - 7 * 24 * 3600_000).toISOString(); rec.releasedBy = 'release' })
    fill(old.sandbox.scratch, SANDBOX_SET_BACK_BUDGET.folders + 40)
    const s = seam()
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s.run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(s.calls.filter(x => x.args.length === 2 && x.args[1] === '/L' && x.args[0].endsWith('*') && fold(x.args[0]).startsWith(fold(old.sandbox.root)))).toHaveLength(SANDBOX_SET_BACK_BUDGET.folders)
    expect(lines).toContain(`[containment] ${join(L.root, old.runId)}: the sandbox was not set back past ${SANDBOX_SET_BACK_BUDGET.folders} folders; the sweep removes it`)
  })

  // C8 (wave 19): a sandbox its release had set back whole was walked again by the sweep, and every old
  // record got a budget of its own, so one sweep held its caller (the daemon's loop) N times 5 s.
  it('C8: a sandbox its release set back whole is recorded so, and the sweep removes it without walking it again', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    fill(old.sandbox.scratch, 5)
    const rel = releaseContainment(old, { platform: 'win32', run: seam().run })
    expect(rel.relabelled, rel.note).toBe(true)
    expect(typeof readRec(old.runId).sandboxSetBackAt).toBe('string')
    const s = seam()
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s.run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(s.calls.filter(x => x.args.some(a => fold(a).startsWith(fold(old.sandbox.root))))).toEqual([])
  })

  it('C8: one budget for the whole sweep pass: once it is spent, an old sandbox that still needs setting back is left to the next pass', () => {
    const first = established(establishContainment(base({ now: daysAgo(9) })))
    const second = established(establishContainment(base({ now: daysAgo(8) })))
    for (const c of [first, second]) editRec(c.runId, rec => { rec.releasedAt = new Date(Date.now() - 7 * 24 * 3600_000).toISOString(); rec.releasedBy = 'release' })
    fill(first.sandbox.scratch, SANDBOX_SET_BACK_BUDGET.folders + 40)
    fill(second.sandbox.scratch, 3)
    const s = seam()
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: s.run, log: l => lines.push(l) })
    // The first spends the pass's budget and is removed by its listing walk, as before; the second is not touched.
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, first.runId)])
    expect(s.calls.filter(x => x.args.some(a => fold(a).startsWith(fold(second.sandbox.root))))).toEqual([])
    expect(lines).toContain(`[containment] the sweep leaves ${join(L.root, second.runId)} to its next pass: this pass has spent its budget for setting sandboxes back (${SANDBOX_SET_BACK_BUDGET.folders} folders or ${SANDBOX_SET_BACK_BUDGET.ms / 1000} s)`)
    expect(existsSync(join(L.root, second.runId, 'containment.json'))).toBe(true)
    // The next pass takes it.
    const next = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: () => undefined })
    expect(next.removed).toEqual([join(L.root, second.runId)])
  })

  // F2 (check B, wave 19): the pass budget also went to the releases the sweep makes itself, so a
  // holder-gone run met after a big sandbox was released with a spent budget, stopped at 0 folders and
  // stayed labelled low for its whole week. Each such release has a budget of its own again.
  it('F2 (wave 19b): a release the sweep makes itself has a budget of its own: a holder-gone run after a big one is set back whole', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const big = established(establishContainment(base()))
    const small = established(establishContainment(base()))
    // Both unreleased, their holders gone, young (the sweep releases them and keeps them), big first.
    const dead = deadPid()
    editRec(big.runId, rec => { rec.releasedAt = null; delete rec.releasedBy; rec.holder = { pid: dead, startedAt: rec.createdAt }; rec.createdAt = new Date(Date.now() - 3 * 3600_000).toISOString() })
    editRec(small.runId, rec => { rec.releasedAt = null; delete rec.releasedBy; rec.holder = { pid: dead, startedAt: rec.createdAt }; rec.createdAt = new Date(Date.now() - 2 * 3600_000).toISOString() })
    fill(big.sandbox.scratch, SANDBOX_SET_BACK_BUDGET.folders + 40)
    fill(small.sandbox.scratch, 3)
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: l => lines.push(l) })
    // Both are young (kept), and both were released by the sweep because their holder is gone.
    expect(res.removed, lines.join('\n')).toEqual([])
    expect(readRec(big.runId).releasedBy).toBe('holder-gone')
    expect(readRec(big.runId).sandboxLeftLow?.folders).toBe(SANDBOX_SET_BACK_BUDGET.folders)
    const rec = readRec(small.runId)
    expect(rec.releasedBy).toBe('holder-gone')
    expect(rec.sandboxLeftLow, lines.join('\n')).toBeUndefined()
    expect(typeof rec.sandboxSetBackAt).toBe('string')
  })

  // R2 (check B, wave 19): a folder whose name ends in a dot or a space in a sandbox made the sandbox's
  // set-back fail, so the sweep kept that sandbox for ever, walking it again on every pass. In a sandbox
  // it is left low like a budget stop, and the sweep removes it by its listing walk (Node and Bun act on
  // the literal name: measured 2026-11-25, scratch r2-node-literal.txt: x. went, x stayed).
  it('R2 (wave 19b): a sandbox folder named x. is left low and said, not failed; the sweep removes the sandbox by its listing walk', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const asWritten = (p: string) => (process.platform === 'win32' ? `\\\\?\\${p}` : p)
    const odd = join(old.sandbox.scratch, 'x.')
    mkdirSync(asWritten(odd))
    writeFileSync(asWritten(join(odd, 'run.txt')), 'run')
    const rel = releaseContainment(old, { platform: 'win32', run: seam().run })
    expect(rel.relabelled, rel.note).toBe(true)
    expect(rel.note).toContain(`${odd} was not entered: Windows reads its name as another entry (it ends in a dot or a space), so what is under it stays as the run left it`)
    const rec = readRec(old.runId)
    expect(rec.sandboxLeftLow, rel.note).toBeDefined()
    expect(rec.sandboxSetBackAt).toBeUndefined()
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
  })

  // BB-6 (check B, wave 19b): the record of R2's stop held the folders walked as `folders`, so the sweep and
  // status said "past N folders", a budget stop that did not happen. The record now says why.
  it('BB-6: a sandbox left low for a folder named x. records why, and the sweep says that, not a budget stop', () => {
    const old = established(establishContainment(base({ now: daysAgo(8) })))
    const asWritten = (p: string) => (process.platform === 'win32' ? `\\\\?\\${p}` : p)
    mkdirSync(asWritten(join(old.sandbox.scratch, 'x.')))
    mkdirSync(asWritten(join(old.sandbox.scratch, 'y ')))
    const rel = releaseContainment(old, { platform: 'win32', run: seam().run })
    expect(rel.relabelled, rel.note).toBe(true)
    const rec = readRec(old.runId)
    expect(rec.sandboxLeftLow, rel.note).toMatchObject({ notEntered: 2, budgetStopped: false, at: rec.releasedAt })
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(lines).toContain(`[containment] ${join(L.root, old.runId)}: its release did not set the sandbox back under 2 folders whose name ends in a dot or a space; the sweep removes it by its listing, never entering a link`)
    expect(lines.join('\n')).not.toMatch(/past \d+ folders/)
  })

  it('P2-B4: the sweep keeps a run folder whose release kept a grant and names the command; it goes once the grant is put back', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let tries = 0
    const granting = seam({
      icacls: args => {
        if (args[1] === '/save') {
          writeFileSync(args[2], Buffer.from(`${basename(args[0])}\r\nD:AI(A;;FR;;;BU)\r\n`, 'utf16le'))
          return { ok: true, out: 'ok' }
        }
        return args[0] === L.mission && args[1] === '/setintegritylevel' && tries++ === 0 ? { ok: false, out: 'Access is denied.' } : undefined
      },
    })
    const c = established(establishContainment(winBase(granting.run, { now: daysAgo(8) })))
    link(L.outside, join(L.mission, 'out'))
    releaseContainment(c, { platform: 'win32', run: seam().run })
    const runDir = join(L.root, c.runId)
    const lines: string[] = []
    const kept = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: l => lines.push(l) })
    expect(kept.removed).toEqual([])
    expect(lines).toContain(`[containment] the sweep keeps ${runDir}: the access list saved before this run's grant on ${L.mission} was not put back (${join(runDir, 'acl-0.before')}); put it back with: bun scripts/cynco-sandbox.mjs restore-acl ${c.runId}`)
    expect(existsSync(join(runDir, 'acl-0.before'))).toBe(true)
    removeLinkEntry(join(L.mission, 'out'))
    expect(restoreKeptGrants(c.runId, { sandboxRoot: L.root, platform: 'win32', run: seam().run }).done).toBe(true)
    const gone = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'win32', run: seam().run, log: () => undefined })
    expect(gone.removed).toEqual([runDir])
  })

  it('containmentRecords lists oldest first, and an unreadable root is empty', () => {
    const b = established(establishContainment(base({ now: daysAgo(1) })))
    const a = established(establishContainment(base({ now: daysAgo(2) })))
    expect(containmentRecords({ sandboxRoot: L.root }).map(r => r.runId)).toEqual([a.runId, b.runId])
    expect(containmentRecords({ sandboxRoot: join(dir, 'none') })).toEqual([])
  })
})

// ─── The walks judge an entry by its folder's listing (F242, the first live-fire run) ──────────────

const daysBack = (d: number) => () => new Date(Date.now() - d * 24 * 3600_000)

/**
 * A listing of `at`'s folder in which the entry `name` has the kind `kind`, whatever it is on disk;
 * `isLinkEntry` of that entry answers the same.
 */
function listedAs(at: string, name: string, kind: EntryKind): void {
  listing.entries = (d, real) => real(d).map(e => (fold(d) === fold(at) && e.name === name ? { name, kind } : e))
  listing.isLink = (p, real) => (fold(p) === fold(join(at, name)) ? kind === 'link' : real(p))
}

/** The real-path check answers that `name` in the folder `at` resolves elsewhere, as a link to another folder does. */
function redirected(at: string, name: string): void {
  listing.whyNot = (r, n, real) => (fold(r) === fold(at) && n === name ? `resolves to ${join(dir, 'elsewhere')}, not to ${join(r, n)}` : real(r, n))
}

describe('the walks take an entry\'s kind from the listing, not from lstat (pure: a listing that disagrees)', () => {
  it('sweep: an entry the listing calls a link is never entered, even when lstat calls it a folder', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const looks = join(old.sandbox.scratch, 'looks-linked')
    mkdirSync(looks)
    writeFileSync(join(looks, 'keep.txt'), 'keep')
    listedAs(old.sandbox.scratch, 'looks-linked', 'link')
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    // Removed as an entry: a folder that is not a link and is not empty cannot be, so the sweep stops.
    expect(res.removed).toEqual([])
    expect(readFileSync(join(looks, 'keep.txt'), 'utf-8')).toBe('keep')
    expect(lines.join('\n')).toContain(`the sweep could not finish ${join(L.root, old.runId)}: ${looks} could not be removed as a link`)
  })

  it('sweep: a file the listing calls a link (what a file carrying a reparse tag is) is removed as an entry, and the run folder goes', () => {
    // On Windows rmdirSync of a file answers ENOENT, not ENOTDIR (measured under Bun and Node).
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const rp = join(old.sandbox.scratch, 'rp.dat')
    writeFileSync(rp, 'x')
    listedAs(old.sandbox.scratch, 'rp.dat', 'link')
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
    expect(lines.join('\n')).toContain(`${rp} is not a folder link (rmdir answered `)
  })

  it('sweep: a run folder whose walk stops keeps its record, so every later sweep tries it again and says why; it goes once the cause is gone', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const runDir = join(L.root, old.runId)
    const stuck = join(old.sandbox.home, 'stuck')
    mkdirSync(stuck)
    writeFileSync(join(stuck, 'keep.txt'), 'keep')
    writeFileSync(join(old.sandbox.scratch, 'later.txt'), 'x')
    // A real folder holding a file, which the listing calls a link: it cannot be removed as an entry.
    listedAs(old.sandbox.home, 'stuck', 'link')
    for (const pass of [1, 2]) {
      const lines: string[] = []
      const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
      expect(res, `pass ${pass}: ${lines.join('\n')}`).toEqual({ removed: [], kept: 1 })
      expect(lines.join('\n'), `pass ${pass}`).toContain(`the sweep could not finish ${runDir}: ${stuck} could not be removed as a link`)
      expect(existsSync(join(runDir, 'containment.json')), `pass ${pass}`).toBe(true)
      expect(containmentRecords({ sandboxRoot: L.root }).map(r => r.runId), `pass ${pass}`).toEqual([old.runId])
    }
    expect(readFileSync(join(stuck, 'keep.txt'), 'utf-8')).toBe('keep')
    listing.entries = null
    listing.isLink = null
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: () => undefined })
    expect(res.removed).toEqual([runDir])
    expect(existsSync(runDir)).toBe(false)
  })

  it('sweep: once a folder is no longer where its path says, nothing more in it is removed', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    for (const n of ['a.txt', 'b.txt']) writeFileSync(join(old.sandbox.scratch, n), n)
    // The scratch folder passes the check before and after it is listed and fails from then on: a
    // swap for a link while its entries are being removed.
    let calls = 0
    listing.whyNot = (r, n, real) => (n === 'scratch' && ++calls > 2 ? `resolves to ${join(dir, 'elsewhere')}, not to ${join(r, n)}` : real(r, n))
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed).toEqual([])
    for (const n of ['a.txt', 'b.txt']) expect(existsSync(join(old.sandbox.scratch, n)), `${n}\n${lines.join('\n')}`).toBe(true)
    expect(lines.join('\n')).toContain(`${old.sandbox.scratch} resolves to ${join(dir, 'elsewhere')}, not to ${old.sandbox.scratch} before an entry in it was removed; the sweep stops there`)
  })

  it('sweep: a folder that is no longer where its path says after it was listed is not emptied', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    writeFileSync(join(old.sandbox.scratch, 'a.txt'), 'a')
    let calls = 0
    listing.whyNot = (r, n, real) => (n === 'scratch' && ++calls === 2 ? `resolves to ${join(dir, 'elsewhere')}, not to ${join(r, n)}` : real(r, n))
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed).toEqual([])
    expect(existsSync(join(old.sandbox.scratch, 'a.txt'))).toBe(true)
    expect(lines.join('\n')).toContain(`${old.sandbox.scratch} resolves to ${join(dir, 'elsewhere')}, not to ${old.sandbox.scratch} after it was listed; the sweep stops there`)
  })

  it('sweep: a run folder its root\'s listing calls a link, or does not show, is kept, and the line says which', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const runDir = join(L.root, old.runId)
    for (const answer of [true, null] as const) {
      listing.isLink = (p, real) => (fold(p) === fold(runDir) ? answer : real(p))
      const lines: string[] = []
      const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
      expect(res, String(answer)).toEqual({ removed: [], kept: 1 })
      expect(existsSync(join(runDir, 'containment.json'))).toBe(true)
      expect(lines.join('\n')).toContain(answer
        ? `${runDir} is a link; the sweep does not touch it`
        : `${runDir} is not in the listing of ${L.root}, so whether it is a link is not known; the sweep does not touch it`)
    }
  })

  it('sweep: the delete itself refuses a top folder its parent\'s listing calls a link, or does not show', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const runDir = join(L.root, old.runId)
    for (const second of [true, null] as const) {
      // The sweep's own check sees a folder; the delete's check, a moment later, does not.
      let n = 0
      listing.isLink = (p, real) => (fold(p) === fold(runDir) ? (++n === 1 ? false : second) : real(p))
      const lines: string[] = []
      const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
      expect(res, String(second)).toEqual({ removed: [], kept: 1 })
      expect(existsSync(join(runDir, 'containment.json'))).toBe(true)
      expect(lines.join('\n')).toContain(second
        ? `the sweep could not finish ${runDir}: ${runDir} is a link; the sweep stops there and enters nothing`
        : `the sweep could not finish ${runDir}: ${runDir} is not in the listing of ${L.root}, so whether it is a link is not known; the sweep stops there and enters nothing`)
    }
  })

  it('containmentRecords: a run folder the root\'s listing calls a link is not a record, and the sweep does not touch it', () => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    listedAs(L.root, old.runId, 'link')
    expect(containmentRecords({ sandboxRoot: L.root })).toEqual([])
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: () => undefined })
    expect(res.removed).toEqual([])
    expect(existsSync(join(L.root, old.runId, 'containment.json'))).toBe(true)
  })

  it('release (rule R4): a folder the listing calls a link, which resolves elsewhere, is not walked', () => {
    mkdirSync(join(L.mission, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(L.mission, 'sub', 'deeper', 'h.txt'), 'x')
    const c = established(establishContainment(winBase(seam().run)))
    listedAs(L.mission, 'sub', 'link')
    redirected(L.mission, 'sub')
    const r = seam()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    expect(listed).toContain(join(L.mission, '*'))
    expect(listed.some(a => a.startsWith(join(L.mission, 'sub') + (process.platform === 'win32' ? '\\' : '/')))).toBe(false)
  })

  it('release (rule R4): a folder the listing calls a link that resolves to its own path (a folder carrying a reparse tag) is walked as the folder it is', () => {
    mkdirSync(join(L.mission, 'tagged', 'deeper'), { recursive: true })
    writeFileSync(join(L.mission, 'tagged', 'deeper', 'h.txt'), 'x')
    const c = established(establishContainment(winBase(seam().run)))
    listedAs(L.mission, 'tagged', 'link')
    const tagged = join(L.mission, 'tagged')
    const r = seam({
      icacls: args => (args[0] === join(L.mission, '*') && args[1] === '/L' && args.length === 2
        ? { ok: true, out: `${tagged} NT AUTHORITY\\SYSTEM:(I)(F)\r\n          Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` }
        : undefined),
    })
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled, res.note).toBe(true)
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    expect(listed).toContain(join(tagged, '*'))
    expect(listed).toContain(join(tagged, 'deeper', '*'))
    const resets = r.calls.filter(x => x.args[1] === '/L' && x.args[2] === '/setintegritylevel').map(x => [x.args[0], x.args[3]])
    expect(resets).toEqual([[tagged, '(OI)(CI)M']])
  })

  it('release (rule R4): a folder the listing calls a folder that resolves elsewhere is not entered, and the release says so', () => {
    writeFileSync(join(L.outside, 'o.txt'), 'x')
    const c = established(establishContainment(winBase(seam().run)))
    const jn = join(L.mission, 'jn')
    link(L.outside, jn)
    listedAs(L.mission, 'jn', 'dir')
    const r = seam()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    expect(listed).not.toContain(join(jn, '*'))
    expect(listed.some(a => fold(a).startsWith(fold(L.outside)))).toBe(false)
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${jn} was not entered: it resolves to ${L.outside}, not to ${jn}`)
  })

  it('release (rule R4): a folder swapped for a link after it was queued is not entered', () => {
    mkdirSync(join(L.mission, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(L.mission, 'zz.txt'), 'x')
    writeFileSync(join(L.outside, 'o.txt'), 'x')
    const c = established(establishContainment(winBase(seam().run)))
    const sub = join(L.mission, 'sub')
    let swapped = false
    const r = seam({
      icacls: args => (args[0] === join(L.mission, '*') && args[1] === '/L' && args.length === 2
        ? { ok: true, out: `${join(L.mission, 'zz.txt')} NT AUTHORITY\\SYSTEM:(I)(F)\r\n          Mandatory Label\\Low Mandatory Level:(NW)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` }
        : undefined),
      before: call => {
        // zz.txt is set back after sub was queued (the listing is in name order on NTFS): sub is
        // swapped for a link to a folder outside then, as a live low process could.
        if (swapped || call.args[0] !== join(L.mission, 'zz.txt') || call.args[2] !== '/setintegritylevel') return
        swapped = true
        renameSync(sub, join(L.mission, 'sub-away'))
        link(L.outside, sub)
      },
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(swapped).toBe(true)
    const listed = r.calls.filter(x => x.args.length === 2 && x.args[1] === '/L').map(x => x.args[0])
    expect(listed).not.toContain(join(sub, '*'))
    expect(res.note).toContain(`${sub} was not entered: it resolves to ${L.outside}, not to ${sub}`)
  })

  it('release (rule R4): an entry the listing shows and lstat cannot see, whose label cannot be read, is said', () => {
    // A junction a low process made whose target is gone: lstat follows it and answers ENOENT (F4),
    // the folder's listing still shows it.
    const c = established(establishContainment(winBase(seam().run)))
    const ghost = join(L.mission, 'ghost')
    listing.entries = (d, real) => (fold(d) === fold(L.mission) ? [...real(d), { name: 'ghost', kind: 'link' }] : real(d))
    listing.isLink = (p, real) => (fold(p) === fold(ghost) ? true : real(p))
    const r = seam({ icacls: args => (args[0] === ghost && args[1] === '/L' && args.length === 2 ? { ok: false, out: 'The system cannot find the file specified.' } : undefined) })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`the label of ${ghost} could not be read (The system cannot find the file specified.)`)
  })

  it('create (hard links): a file with a second name inside what the listing calls a link, which resolves elsewhere, is not counted', () => {
    mkdirSync(join(L.mission, 'vendor'))
    writeFileSync(join(L.outside, 'secret.txt'), 'x')
    linkSync(join(L.outside, 'secret.txt'), join(L.mission, 'vendor', 'alias.txt'))
    listedAs(L.mission, 'vendor', 'link')
    redirected(L.mission, 'vendor')
    expect(establishContainment(winBase(seam().run)).ok).toBe(true)
  })

  it('create (hard links): a folder the listing calls a link that resolves to its own path is walked: a file with a second name in it is refused', () => {
    mkdirSync(join(L.mission, 'tagged'))
    writeFileSync(join(L.outside, 'secret.txt'), 'x')
    linkSync(join(L.outside, 'secret.txt'), join(L.mission, 'tagged', 'alias.txt'))
    listedAs(L.mission, 'tagged', 'link')
    expect(refusal(establishContainment(winBase(seam().run)))).toContain(`holds a file with more than one name (${join(L.mission, 'tagged', 'alias.txt')} has 2)`)
  })

  it('create (hard links): a file the listing calls a link that has a second name is refused', () => {
    writeFileSync(join(L.outside, 'secret.txt'), 'x')
    linkSync(join(L.outside, 'secret.txt'), join(L.mission, 'alias.txt'))
    listedAs(L.mission, 'alias.txt', 'link')
    expect(refusal(establishContainment(winBase(seam().run)))).toContain(`holds a file with more than one name (${join(L.mission, 'alias.txt')} has 2)`)
  })

  it('create (hard links): a folder the listing calls a folder that is not where its path says is refused for that, without the clone advice', () => {
    mkdirSync(join(L.mission, 'packages', 'a'), { recursive: true })
    const linked = join(L.mission, 'linked-a')
    link(join(L.mission, 'packages', 'a'), linked)
    listedAs(L.mission, 'linked-a', 'dir')
    expect(refusal(establishContainment(winBase(seam().run)))).toBe(
      `the mission folder ${L.mission} holds a folder that is not where its path says (${linked} resolves to ${join(L.mission, 'packages', 'a')}, not to ${linked}), so whether a file under it has another name cannot be told; the folder is not labelled`,
    )
  })

  it('create (rule M8): an entry the listing calls a link is judged where it lands and never entered', () => {
    mkdirSync(join(L.mission, 'vendor'))
    link(L.outside, join(L.mission, 'vendor', 'out'))
    // Listed as a link that lands inside the folder: not reported, and what is under it is not read.
    listedAs(L.mission, 'vendor', 'link')
    redirected(L.mission, 'vendor')
    expect(establishContainment(base()).ok).toBe(true)
    // The same folder read as a folder is entered, and the link under it leads out.
    listing.entries = null
    listing.isLink = null
    listing.whyNot = null
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'vendor', 'out')} -> ${L.outside})`)
  })

  it('create (rule M8): a folder the listing calls a folder that resolves outside is judged where it lands', () => {
    const jn = join(L.mission, 'jn')
    link(L.outside, jn)
    listedAs(L.mission, 'jn', 'dir')
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${jn} -> ${L.outside})`)
  })

  it('create (rule M9): a .git that is a link is refused by name', () => {
    const realGit = join(L.mission, 'realgit')
    mkdirSync(realGit)
    writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/main\n')
    rmSync(join(L.mission, '.git'), { recursive: true })
    link(realGit, join(L.mission, '.git'))
    expect(refusal(establishContainment(base()))).toContain('(.git is a link)')
  })

  it('create (rule M9): a .git folder its listing calls a link, which lstat calls a folder, is refused as a link', () => {
    listedAs(L.mission, '.git', 'link')
    expect(lstatSync(join(L.mission, '.git')).isDirectory()).toBe(true)
    expect(refusal(establishContainment(base()))).toContain('(.git is a link)')
  })
})

// ─── The same walks against a junction a low-integrity process made (Windows) ──────────────────────

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const canMakeLow = process.platform === 'win32' && existsSync(join(SYSTEM32, 'icacls.exe')) && existsSync(join(SYSTEM32, 'cmd.exe'))
if (!canMakeLow) console.log('[containment] SKIPPED: the low-made junction cases need Windows with icacls.exe and cmd.exe; a junction made at low integrity exists only there')

function sys(exe: string, args: string[], verbatim = false): { status: number | null; out: string } {
  const r = spawnSync(join(SYSTEM32, exe), args, { encoding: 'utf-8', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: verbatim })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` }
}

let sidCache: string | null = null
function ownSid(): string {
  if (sidCache) return sidCache
  const m = /"(S-1-5-[\d-]+)"/.exec(sys('whoami.exe', ['/user', '/fo', 'csv', '/nh']).out)
  if (!m) throw new Error('whoami /user printed no SID')
  sidCache = m[1]
  return sidCache
}

/** Label a folder (or, with `file`, a program) low, as a run's folders are during the run. Null, or why not. */
function labelLow(p: string, file = false): string | null {
  const g = sys('icacls.exe', [p, '/grant', `*${ownSid()}:${file ? '(F)' : '(OI)(CI)(F)'}`])
  if (g.status !== 0) return `icacls /grant on ${p}: ${g.out.trim()}`
  const s = sys('icacls.exe', [p, '/setintegritylevel', file ? 'low' : '(OI)(CI)low'])
  return s.status === 0 ? null : `icacls /setintegritylevel on ${p}: ${s.out.trim()}`
}

/** Set a folder back to medium, as a release does (F3: a junction made during the run now points at a medium folder). */
function labelMedium(p: string): void {
  const s = sys('icacls.exe', [p, '/setintegritylevel', '(OI)(CI)M'])
  if (s.status !== 0) throw new Error(`icacls could not set ${p} back to medium: ${s.out.trim()}`)
}

/** The mandatory-label line icacls prints for `p` itself (`''` when it prints none). */
function labelOf(p: string): string {
  return sys('icacls.exe', [p, '/L']).out.split(/\r?\n/).find(l => /Mandatory Label/i.test(l))?.trim().replace(/^.*?(Mandatory Label)/i, '$1') ?? ''
}

/**
 * A junction at `at` to `target` made by a copy of cmd.exe labelled low (so it runs at
 * S-1-16-4096): the folder holding `at` and `target` must be writable at low integrity. Checked
 * with fsutil to be stored in the low form (`\??\Global\...`, fact F1) before a case relies on it;
 * `skip` names why it could not be made. Every junction made is removed as an entry after the test.
 */
function lowJunction(at: string, target: string): { ok: true } | { skip: string } {
  const cmd = join(dir, 'lowcmd.exe')
  if (!existsSync(cmd)) {
    copyFileSync(join(SYSTEM32, 'cmd.exe'), cmd)
    const why = labelLow(cmd, true)
    if (why) return { skip: `the copy of cmd.exe could not be labelled low (${why})` }
  }
  const made = spawnSync(cmd, ['/c', `mklink /J "${at}" "${target}"`], { encoding: 'utf-8', timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true, cwd: dir })
  if (made.status !== 0) return { skip: `a low-integrity cmd could not make the junction ${at} -> ${target} (status ${made.status}: ${`${made.stdout ?? ''}${made.stderr ?? ''}`.trim()})` }
  links.push(at)
  const q = sys('fsutil.exe', ['reparsepoint', 'query', at]).out
  const sub = /Substitute Name:\s*(.*)/i.exec(q)?.[1]?.trim() ?? ''
  if (!sub.startsWith('\\??\\Global\\')) return { skip: `the junction ${at} is not stored in the low form (substitute name ${JSON.stringify(sub)}); fsutil said: ${q.trim().split(/\r?\n/)[0] ?? ''}` }
  return { ok: true }
}

function need(t: { skip: () => void }, r: { ok: true } | { skip: string } | string | null): boolean {
  const why = r === null ? null : typeof r === 'string' ? r : 'skip' in r ? r.skip : null
  if (why === null) return true
  console.log(`[containment] SKIPPED: ${why}`)
  t.skip()
  return false
}

/**
 * Put a reparse point with a tag no filter owns (0x99) on each of `paths` (files this test made),
 * through FSCTL_SET_REPARSE_POINT, which needs no privilege: a low-integrity process can do the same
 * to a file it wrote (measured 2026-11-24 by the review of wave 7). The folder's listing then calls
 * the file a link, lstat answers EACCES and rmdirSync answers ENOENT. Null, or why it could not be set.
 */
const TAG_PS = `param([string]$Paths)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CyncoTestReparse {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inSize, IntPtr outBuf, int outSize, out int ret, IntPtr ov);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string Set(string path) {
    IntPtr h = CreateFileW(path, 0x40000000 | 0x80000000, 7, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "open failed: " + Marshal.GetLastWin32Error();
    byte[] data = new byte[] { 1, 2, 3, 4 };
    byte[] buf = new byte[24 + data.Length];
    BitConverter.GetBytes((uint)0x00000099).CopyTo(buf, 0);
    BitConverter.GetBytes((ushort)data.Length).CopyTo(buf, 4);
    Guid.NewGuid().ToByteArray().CopyTo(buf, 8);
    data.CopyTo(buf, 24);
    int ret;
    bool ok = DeviceIoControl(h, 0x000900A4, buf, buf.Length, IntPtr.Zero, 0, out ret, IntPtr.Zero);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(h);
    return ok ? "set" : "FSCTL_SET_REPARSE_POINT failed: " + err;
  }
}
'@
foreach ($p in $Paths.Split('|')) { [CyncoTestReparse]::Set($p) }
`
function tagFiles(...paths: string[]): string | null {
  const ps1 = join(dir, 'tag-reparse.ps1')
  writeFileSync(ps1, TAG_PS)
  const r = sys(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, paths.join('|')])
  unlinkSync(ps1)
  const said = r.out.trim().split(/\r?\n/)
  if (r.status !== 0 || said.length !== paths.length || said.some(l => l.trim() !== 'set')) return `a reparse tag could not be set on ${paths.join(', ')} (status ${r.status}: ${r.out.trim().slice(0, 300)})`
  for (const p of paths) links.push(p)
  return null
}

/** A runner that runs the real program and records the call. */
function realRunner(): { run: ContainmentRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: ContainmentRunner = (file, args) => {
    calls.push({ file, args: [...args] })
    const r = spawnSync(file, args, { encoding: 'utf-8', timeout: 60_000, windowsHide: true })
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
  }
  return { run, calls }
}

describe.skipIf(!canMakeLow)('the walks against a junction a low-integrity process made (Windows, F4)', () => {
  it('the fixture: lstat calls the low-made junction a folder, its folder\'s listing calls it a link', t => {
    const target = join(dir, 'low-target')
    mkdirSync(target)
    if (!need(t, labelLow(dir)) || !need(t, lowJunction(join(dir, 'j'), target))) return
    const st = lstatSync(join(dir, 'j'))
    expect(st.isSymbolicLink()).toBe(false)
    expect(st.isDirectory()).toBe(true)
    expect(isLinkEntry(join(dir, 'j'))).toBe(true)
    expect(listEntries(dir).find(e => e.name === 'j')?.kind).toBe('link')
    expect(whyNotAtOwnPath(dir, 'j')).toBe(`resolves to ${target}, not to ${join(dir, 'j')}`)
  })

  it('sweep (a): a junction in the scratch folder to the mission folder is removed; every file of the mission is still there', t => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    mkdirSync(join(L.mission, 'src'))
    writeFileSync(join(L.mission, 'work.txt'), 'owner work')
    writeFileSync(join(L.mission, 'src', 'a.txt'), 'a')
    // During the run the scratch folder and the mission folder are labelled low; the junction is made then.
    if (!need(t, labelLow(old.sandbox.scratch)) || !need(t, labelLow(L.mission))) return
    const j = join(old.sandbox.scratch, 'repo')
    if (!need(t, lowJunction(j, L.mission))) return
    labelMedium(L.mission)
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    for (const f of ['work.txt', join('src', 'a.txt'), join('.git', 'HEAD')]) expect(existsSync(join(L.mission, f)), `${f}\n${lines.join('\n')}`).toBe(true)
    expect(readFileSync(join(L.mission, 'work.txt'), 'utf-8')).toBe('owner work')
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
  })

  it('sweep (b): a run folder whose junction points at its own home is removed completely', t => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    writeFileSync(join(old.sandbox.home, 'h.txt'), 'h')
    if (!need(t, labelLow(old.sandbox.scratch)) || !need(t, labelLow(old.sandbox.home))) return
    if (!need(t, lowJunction(join(old.sandbox.scratch, 'myhome'), old.sandbox.home))) return
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
  })

  it('release (c): a junction that loops back and one to a folder with its own Low label: the walk ends, the canary\'s labels are unchanged', t => {
    const c = established(establishContainment(winBase(seam().run)))
    mkdirSync(join(L.mission, 'sub'))
    writeFileSync(join(L.mission, 'work.txt'), 'x')
    writeFileSync(join(L.mission, 'sub', 'a.txt'), 'x')
    const canary = join(dir, 'canary')
    mkdirSync(join(canary, 'inner'), { recursive: true })
    writeFileSync(join(canary, 'inner', 'c.txt'), 'c')
    if (!need(t, labelLow(L.mission)) || !need(t, labelLow(canary)) || !need(t, labelLow(join(canary, 'inner')))) return
    if (!need(t, lowJunction(join(L.mission, 'loop'), L.mission)) || !need(t, lowJunction(join(L.mission, 'out'), canary))) return
    const before = { canary: labelOf(canary), inner: labelOf(join(canary, 'inner')) }
    expect(before.inner).toMatch(/^Mandatory Label\\Low Mandatory Level:\(OI\)\(CI\)/)
    // A junction a low process makes in a folder labelled (OI)(CI) low inherits that label (measured:
    // `Low Mandatory Level:(I)(OI)(CI)(NW)`). One of them is given a Low label of its own, on the link
    // itself (/L), as a run could set one, so that the release has a link's own label to set back.
    for (const l of ['loop', 'out']) expect(labelOf(join(L.mission, l)), l).toMatch(/^Mandatory Label\\Low Mandatory Level:\(I\)/)
    const own = sys('icacls.exe', [join(L.mission, 'out'), '/L', '/setintegritylevel', 'low'])
    if (!need(t, own.status === 0 ? null : `icacls could not set the junction's own label: ${own.out.trim()}`)) return
    expect(labelOf(join(L.mission, 'out'))).toMatch(/^Mandatory Label\\Low Mandatory Level:\((?!I\))/)
    expect({ canary: labelOf(canary), inner: labelOf(join(canary, 'inner')) }).toEqual(before)
    const r = realRunner()
    const t0 = Date.now()
    const res = releaseContainment(c, { platform: 'win32', run: r.run })
    const ms = Date.now() - t0
    expect({ canary: labelOf(canary), inner: labelOf(join(canary, 'inner')) }).toEqual(before)
    // The link's own label was set back with /L, so its target's was not touched; the inherited one
    // went with the mission folder's.
    for (const l of ['loop', 'out']) expect(labelOf(join(L.mission, l)), l).not.toMatch(/Low Mandatory Level/)
    expect(r.calls.some(x => fold(x.args[0]) === fold(join(L.mission, 'out')) && x.args[1] === '/L' && x.args[2] === '/setintegritylevel' && x.args[3] === 'M')).toBe(true)
    expect(r.calls.some(x => fold(x.args[0]) === fold(join(L.mission, 'loop')) && x.args[2] === '/setintegritylevel')).toBe(false)
    // The real folders under the mission folder that hold entries: itself, .git and sub.
    expect(res.note).toMatch(/set back to medium integrity \(3 folders read for labels set under it[;)]/)
    expect(res.relabelled, res.note).toBe(true)
    const throughLink = r.calls.flatMap(x => x.args).filter(a => fold(a).startsWith(fold(join(L.mission, 'loop')) + '/') || fold(a).startsWith(fold(join(L.mission, 'out')) + '/'))
    expect(throughLink).toEqual([])
    expect(ms).toBeLessThan(60_000)
  }, 240_000)

  it('create (d): a low-made junction leading out of the mission folder is refused with rule M\'s words', t => {
    const oldSandbox = join(dir, 'old-sandbox')
    mkdirSync(oldSandbox)
    if (!need(t, labelLow(oldSandbox)) || !need(t, labelLow(L.mission))) return
    if (!need(t, lowJunction(join(L.mission, 'out'), oldSandbox))) return
    labelMedium(L.mission)
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'out')} -> ${oldSandbox})`)
  })

  // NOW.md:77, measured by the review of wave 7: a low-made junction whose target is gone resolved to
  // its own path, so rule M passed it, and it leads out again once its target is made again.
  it('create (d): a low-made junction leading out whose target is gone is refused as a link that cannot be resolved', t => {
    const gone = join(dir, 'gone-later')
    mkdirSync(gone)
    if (!need(t, labelLow(dir)) || !need(t, labelLow(L.mission))) return
    if (!need(t, lowJunction(join(L.mission, 'out'), gone))) return
    labelMedium(L.mission)
    rmdirSync(gone)
    const why = refusal(establishContainment(base()))
    expect(why.startsWith(`the mission folder ${L.mission} holds a link whose target cannot be resolved (${join(L.mission, 'out')}: `), why).toBe(true)
  })

  it('create (d): a low-made junction pointing inside the mission folder is not refused', t => {
    mkdirSync(join(L.mission, 'packages', 'a'), { recursive: true })
    writeFileSync(join(L.mission, 'packages', 'a', 'index.js'), '')
    if (!need(t, labelLow(L.mission))) return
    if (!need(t, lowJunction(join(L.mission, 'linked-a'), join(L.mission, 'packages', 'a')))) return
    labelMedium(L.mission)
    expect(establishContainment(base()).ok).toBe(true)
  })

  it('create (d): the hard-link walk returns at once on a junction that loops back', t => {
    if (!need(t, labelLow(L.mission))) return
    if (!need(t, lowJunction(join(L.mission, 'loop'), L.mission))) return
    labelMedium(L.mission)
    const t0 = Date.now()
    const r = establishContainment(winBase(seam().run))
    expect(r.ok, r.ok ? '' : r.reason).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5_000)
  }, 120_000)

  it('the fixture under Bun: the helpers answer as they do under Node (the engine and the acceptance run under Bun)', t => {
    const target = join(dir, 'low-target')
    mkdirSync(target)
    if (!need(t, labelLow(dir)) || !need(t, lowJunction(join(dir, 'j'), target))) return
    const probe = join(dir, 'probe.mjs')
    const helpers = pathToFileURL(fileURLToPath(new URL('../realPath.ts', import.meta.url))).href
    writeFileSync(probe, [
      `import { isLinkEntry, listEntries, whyNotAtOwnPath } from ${JSON.stringify(helpers)}`,
      `import { join } from 'node:path'`,
      `const [d, n] = process.argv.slice(2)`,
      `console.log(JSON.stringify({ kind: listEntries(d).find(e => e.name === n)?.kind ?? null, isLink: isLinkEntry(join(d, n)), why: whyNotAtOwnPath(d, n) }))`,
    ].join('\n'))
    const r = spawnSync('bun', [probe, dir, 'j'], { encoding: 'utf-8', timeout: 60_000, windowsHide: true, cwd: dir })
    if (r.error) {
      need(t, `bun could not be started (${r.error.message}), so the helpers were not run under Bun`)
      return
    }
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!)).toEqual({ kind: 'link', isLink: true, why: `resolves to ${target}, not to ${join(dir, 'j')}` })
  }, 120_000)

  // R1 F1 and NOW.md:78 on real folders: real icacls and the real access-list restore; only the
  // first label of the mission folder is made to fail (what a folder outside the home, where the user
  // holds no WRITE_OWNER, answers), and the volume listing is answered, so no drive is read.
  it('R1 F1 (real): the grant is undone at release, an explicit entry the folder had before stays; home, tmp and scratch read medium', () => {
    const pre = sys('icacls.exe', [L.mission, '/grant', '*S-1-5-32-545:(R)'])
    expect(pre.status, pre.out).toBe(0)
    const explicitOf = (p: string) => sys('icacls.exe', [p]).out.split(/\r?\n/).map(l => l.trim()).filter(l => /:\(/.test(l) && !/\(I\)/.test(l) && !/Mandatory Label/i.test(l))
      .map(l => l.replace(/^.*?\s(?=\S+:\()/, ''))
    const before = explicitOf(L.mission)
    expect(before.some(l => /\(R\)$/.test(l)), before.join(' | ')).toBe(true)
    const real = realRunner()
    let failedOnce = false
    const run: ContainmentRunner = (file, args, cap) => {
      if (exeOf(file) === 'powershell.exe' && String(args.at(-1)).includes('Win32_LogicalDisk')) return { ok: true, out: 'C:|3|NTFS|0\r\n', code: 0 }
      if (!failedOnce && exeOf(file) === 'icacls.exe' && fold(args[0]) === fold(L.mission) && args[1] === '/setintegritylevel') {
        failedOnce = true
        return { ok: false, out: `${args[0]}: Access is denied.`, code: 5 }
      }
      return real.run(file, args, cap)
    }
    const c = established(establishContainment(winBase(run)))
    const rec = readRec(c.runId)
    expect(rec.grants).toEqual([{ folder: L.mission, aclFile: join(c.sandbox.root, 'acl-0.before') }])
    const during = explicitOf(L.mission)
    expect(during.length, during.join(' | ')).toBe(before.length + 1)
    expect(labelOf(L.mission)).toMatch(/Low Mandatory Level/)
    const res = releaseContainment(c, { platform: 'win32', run })
    expect(res.relabelled, res.note).toBe(true)
    expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was put back`)
    expect(explicitOf(L.mission)).toEqual(before)
    expect(labelOf(L.mission)).not.toMatch(/Low Mandatory Level/)
    for (const d of [c.sandbox.home, c.sandbox.tmp, c.sandbox.scratch]) expect(labelOf(d), d).not.toMatch(/Low Mandatory Level/)
  }, 120_000)

  /** A run that answers the volume listing and makes the first label of the mission folder fail (so it is granted); the rest is real. */
  function grantingRunner(): ContainmentRunner {
    const real = realRunner()
    let failedOnce = false
    return (file, args, cap) => {
      if (exeOf(file) === 'powershell.exe' && String(args.at(-1)).includes('Win32_LogicalDisk')) return { ok: true, out: 'C:|3|NTFS|0\r\n', code: 0 }
      if (!failedOnce && exeOf(file) === 'icacls.exe' && fold(args[0]) === fold(L.mission) && args[1] === '/setintegritylevel') {
        failedOnce = true
        return { ok: false, out: `${args[0]}: Access is denied.`, code: 5 }
      }
      return real.run(file, args, cap)
    }
  }
  const aclLines = (p: string) => sys('icacls.exe', [p]).out.split(/\r?\n/).filter(l => !/Mandatory Label/i.test(l)).join('\n')

  // P2-F2 on real folders: a junction a low process made under the granted mission folder, leading to a
  // folder of the owner's with an access list of its own; the release must leave that folder's list as it was.
  it('P2-F2 (real): a low-made junction under a granted folder that leads out: the owner\'s folder behind it reads the same after the release; the grant is kept and said', t => {
    const canary = join(dir, 'canary-acl')
    mkdirSync(canary)
    writeFileSync(join(canary, 'c.txt'), 'c')
    const g = sys('icacls.exe', [canary, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'])
    expect(g.status, g.out).toBe(0)
    // An inheritable entry only the mission folder has (LOCAL SERVICE, read), so that a rewrite of what
    // is under it that went through the junction would show on the canary.
    const m = sys('icacls.exe', [L.mission, '/grant', '*S-1-5-19:(OI)(CI)(R)'])
    expect(m.status, m.out).toBe(0)
    const run = grantingRunner()
    const c = established(establishContainment(winBase(run)))
    expect(readRec(c.runId).grants).toEqual([{ folder: L.mission, aclFile: join(c.sandbox.root, 'acl-0.before') }])
    // The low cmd of this fixture makes a junction only to a target labelled low (as in release (c)); the
    // canary's access list is read after that, and it is its access list the release must not change.
    if (!need(t, labelLow(canary)) || !need(t, lowJunction(join(L.mission, 'out'), canary))) return
    const before = { canary: sys('icacls.exe', [canary]).out, file: sys('icacls.exe', [join(canary, 'c.txt')]).out }
    expect(before.canary).not.toMatch(/LOCAL SERVICE/)
    const res = releaseContainment(c, { platform: 'win32', run })
    expect({ canary: sys('icacls.exe', [canary]).out, file: sys('icacls.exe', [join(canary, 'c.txt')]).out }).toEqual(before)
    expect(res.relabelled).toBe(false)
    expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was not put back, because ${join(L.mission, 'out')} leads outside it (to ${canary})`)
    expect(labelOf(L.mission)).not.toMatch(/Low Mandatory Level/)
  }, 120_000)

  // P2-F6 on real files: what the owner protected before the run keeps its access list; what the run protected is reset.
  it('P2-F6 (real): a file the owner protected before the run keeps its access list at release; one protected during the run gets inheritance back', () => {
    const owner = join(L.mission, 'owner-secret.txt')
    writeFileSync(owner, 'x')
    const p = sys('icacls.exe', [owner, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
    expect(p.status, p.out).toBe(0)
    // P2-B1 (wave 15c): the owner's protected entries in the real trees sit two to four levels down
    // (pytest's .pytest_cache under tui\ and in worktrees); a walk that stopped at the top would miss
    // them, and the release would reset them. A file and the folder holding it, two levels down.
    const deepDir = join(L.mission, 'deep', 'sub')
    mkdirSync(deepDir, { recursive: true })
    const deepFile = join(deepDir, 'owner-deep.txt')
    writeFileSync(deepFile, 'x')
    for (const e of [deepFile, deepDir]) {
      const d = sys('icacls.exe', [e, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
      expect(d.status, d.out).toBe(0)
    }
    const ownerBefore = aclLines(owner)
    const deepBefore = { file: aclLines(deepFile), dir: aclLines(deepDir) }
    expect(ownerBefore).not.toMatch(/\(I\)/)
    expect(deepBefore.file).not.toMatch(/\(I\)/)
    expect(deepBefore.dir).not.toMatch(/\(I\)/)
    const run = grantingRunner()
    const c = established(establishContainment(winBase(run)))
    const rec = readRec(c.runId)
    expect(rec.inheritanceBefore?.[0].folder).toBe(L.mission)
    const listed = readFileSync(rec.inheritanceBefore![0].listFile!, 'utf-8').split('\n').map(fold)
    for (const e of [owner, deepDir, deepFile]) expect(listed, e).toContain(fold(e))
    const byRun = join(L.mission, 'run-secret.txt')
    writeFileSync(byRun, 'x')
    const q = sys('icacls.exe', [byRun, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
    expect(q.status, q.out).toBe(0)
    const res = releaseContainment(c, { platform: 'win32', run })
    expect(aclLines(owner)).toBe(ownerBefore)
    expect({ file: aclLines(deepFile), dir: aclLines(deepDir) }).toEqual(deepBefore)
    expect(aclLines(byRun)).toMatch(/\(I\)/)
    expect(res.note).toContain(`inheritance turned back on for 1: ${byRun}`)
    // Three since wave 15c (was 1, the top-level file alone): the deep folder and its file are the owner's too.
    expect(res.note).toContain('inheritance left off for 3, which had it off before this run: ')
    for (const e of [owner, deepDir, deepFile]) expect(res.note, e).toContain(e)
  }, 120_000)

  // Wave 15c (found measuring the release walk on the owner's checkout, which holds one): icacls reads a
  // file named `nul` (or con, aux, prn, com1, lpt1...) as the device, whose descriptor carries an explicit
  // Low label and no inherited entry, so the release tried to set the device back and to reset its
  // inheritance, failed (Access is denied), and said the folder may still be labelled low.
  it('release (real): a file named nul in the mission folder is read as the file it is, not as the device; the release is clean', () => {
    const nul = `\\\\?\\${join(L.mission, 'nul')}`
    writeFileSync(nul, 'x')
    try {
      const real = realRunner()
      const run: ContainmentRunner = (file, args, cap) => (exeOf(file) === 'powershell.exe' && String(args.at(-1)).includes('Win32_LogicalDisk')
        ? { ok: true, out: 'C:|3|NTFS|0\r\n', code: 0 } : real.run(file, args, cap))
      const c = established(establishContainment(winBase(run)))
      const res = releaseContainment(c, { platform: 'win32', run })
      expect(res.note).not.toMatch(/nul could not be|inheritance could not be turned back on/)
      expect(res.relabelled, res.note).toBe(true)
      // The establish's read of inheritance asked the file too, not the device (whose list is protected).
      expect(res.note).not.toContain(join(L.mission, 'nul'))
      expect(readRec(c.runId).inheritanceBefore?.[0].count).toBe(0)
      expect(real.calls.some(x => x.args[0] === join(L.mission, 'nul') && x.args.length > 2)).toBe(false)
    } finally {
      unlinkSync(nul)
    }
  }, 120_000)

  // C4 (wave 19): the check read the builder's `Access is denied` for a label set through \\?\ as the
  // form failing. Measured 2026-11-25 (out/c3-label.txt, c3-label2.txt): the denial was the rights (a
  // folder this user may only modify gives no WRITE_OWNER); in a folder granted full control, as the
  // sandbox and a granted work folder are, icacls sets and resets a label through \\?\ on `nul` and on
  // `foo.`. So a run-made `nul` the run labelled low is set back by the release, through its \\?\ form.
  it('C4 (real): a run-made nul that the run labelled low is set back through its \\\\?\\ form', () => {
    const run = grantingRunner()
    const c = established(establishContainment(winBase(run)))
    const nul = `\\\\?\\${join(L.mission, 'nul')}`
    writeFileSync(nul, 'x')
    try {
      const l = sys('icacls.exe', [nul, '/L', '/setintegritylevel', 'L'])
      expect(l.status, l.out).toBe(0)
      expect(sys('icacls.exe', [nul, '/L']).out).toMatch(/Low Mandatory Level/)
      const res = releaseContainment(c, { platform: 'win32', run })
      expect(res.note).toContain(`1 set back: ${join(L.mission, 'nul')}`)
      expect(sys('icacls.exe', [nul, '/L']).out).not.toMatch(/Low Mandatory Level/)
      expect(res.relabelled, res.note).toBe(true)
    } finally {
      unlinkSync(nul)
    }
  }, 120_000)

  // C3 (wave 19), measured 2026-11-25 (w19 scratch b, out/c3-measure.txt): Win32 drops a trailing dot or
  // space from a name, so `icacls <dir>\foo. /L` read the owner's `foo`, and `icacls <dir>\foo. /reset /L`
  // turned the owner's `foo`'s inheritance back on; through `\\?\` both acted on `foo.`. Node and Bun act
  // on the name as written (out/c3-runtime.txt), so only what icacls and .NET are handed needs the form.
  it('C3 (real): a run-made foo. beside the owner\'s protected foo: the release resets foo. through its \\\\?\\ form and leaves foo\'s access list as it was', () => {
    const foo = join(L.mission, 'foo')
    writeFileSync(foo, 'owner')
    const p = sys('icacls.exe', [foo, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
    expect(p.status, p.out).toBe(0)
    const ownerBefore = aclLines(foo)
    expect(ownerBefore).not.toMatch(/\(I\)/)
    const run = grantingRunner()
    const c = established(establishContainment(winBase(run)))
    const dot = `\\\\?\\${join(L.mission, 'foo.')}`
    writeFileSync(dot, 'run-made')
    try {
      const q = sys('icacls.exe', [dot, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
      expect(q.status, q.out).toBe(0)
      expect(aclLines(dot)).not.toMatch(/\(I\)/)
      const res = releaseContainment(c, { platform: 'win32', run })
      expect(aclLines(foo), res.note).toBe(ownerBefore)
      expect(aclLines(dot), res.note).toMatch(/\(I\)/)
      expect(res.note).toContain(`inheritance turned back on for 1: ${join(L.mission, 'foo.')}`)
      // The grant waits, as for a link that leads out: rule M refuses such a name (C3), and the access-list
      // restore asks rule M first. Kept and said; restore-acl puts it back once foo. is gone.
      expect(res.note).toContain(`${L.mission}: the access list saved before this run's grant was not put back, because the folder holds an entry whose name Windows reads as another entry (${join(L.mission, 'foo.')}: its name ends in a dot or a space)`)
      expect(res.relabelled, res.note).toBe(false)
      expect(readRec(c.runId).grantsKept).toEqual([{ folder: L.mission, aclFile: join(c.sandbox.root, 'acl-0.before'), why: 'link' }])
    } finally {
      unlinkSync(dot)
    }
  }, 120_000)

  it('C3 (real): a run-made folder x. beside x is not entered by the release, which says so; what is under the owner\'s x is untouched', () => {
    const x = join(L.mission, 'x')
    mkdirSync(x)
    const owned = join(x, 'kept.txt')
    writeFileSync(owned, 'owner')
    const p = sys('icacls.exe', [owned, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
    expect(p.status, p.out).toBe(0)
    const ownerBefore = aclLines(owned)
    const run = grantingRunner()
    const c = established(establishContainment(winBase(run)))
    const xdot = `\\\\?\\${join(L.mission, 'x.')}`
    mkdirSync(xdot)
    // The same name as the owner's file, inheritance off: a walk that listed `x.\*` would have read x's.
    const inner = `\\\\?\\${join(L.mission, 'x.', 'kept.txt')}`
    writeFileSync(inner, 'run-made')
    try {
      const res = releaseContainment(c, { platform: 'win32', run })
      expect(aclLines(owned), res.note).toBe(ownerBefore)
      expect(res.note).toContain(`${join(L.mission, 'x.')} was not entered: Windows reads its name as another entry (it ends in a dot or a space), so what is under it was not read`)
      expect(res.relabelled).toBe(false)
    } finally {
      unlinkSync(inner)
      rmdirSync(xdot)
    }
  }, 120_000)

  it('C3 (real): the establish\'s read of inheritance asks foo. through its \\\\?\\ form, so it is listed by what it is, not by what foo is', () => {
    const foo = join(L.mission, 'foo')
    writeFileSync(foo, 'owner')
    const p = sys('icacls.exe', [foo, '/inheritance:r', '/grant:r', `*${ownSid()}:(F)`])
    expect(p.status, p.out).toBe(0)
    const dot = `\\\\?\\${join(L.mission, 'foo.')}`
    writeFileSync(dot, 'inherits')
    const listFile = join(dir, 'inheritance.before')
    try {
      const r = readInheritanceOff(realRunner().run, L.mission, listFile)
      expect('count' in r, JSON.stringify(r)).toBe(true)
      const listed = readFileSync(listFile, 'utf-8').split('\n').filter(l => l !== '').map(fold)
      expect(listed).toContain(fold(foo))
      expect(listed).not.toContain(fold(join(L.mission, 'foo.')))
    } finally {
      unlinkSync(dot)
    }
  }, 120_000)

  it('sweep (e): a file carrying a reparse tag in the scratch folder is removed as an entry, and the run folder goes', t => {
    const old = established(establishContainment(base({ now: daysBack(8) })))
    const rp = join(old.sandbox.scratch, 'rp.dat')
    writeFileSync(rp, 'x')
    if (!need(t, tagFiles(rp))) return
    expect(listEntries(old.sandbox.scratch).find(e => e.name === 'rp.dat')?.kind).toBe('link')
    const lines: string[] = []
    const res = sweepSandboxes({ sandboxRoot: L.root, home: L.home, platform: 'linux', log: l => lines.push(l) })
    expect(res.removed, lines.join('\n')).toEqual([join(L.root, old.runId)])
    expect(existsSync(join(L.root, old.runId))).toBe(false)
  }, 120_000)

  it('create (e): a file with a second name that carries a reparse tag is refused (lstat cannot read it)', t => {
    writeFileSync(join(L.outside, 'secret.txt'), 'x')
    const alias = join(L.mission, 'alias.dat')
    linkSync(join(L.outside, 'secret.txt'), alias)
    if (!need(t, tagFiles(alias))) return
    expect(listEntries(L.mission).find(e => e.name === 'alias.dat')?.kind).toBe('link')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // Changed on purpose (NOW.md:77, 2026-11-24): rule M, which runs before the hard-link walk, now
    // refuses a link whose target cannot be resolved, and a file carrying a reparse tag is one (its
    // realpath answers EACCES); before, rule M passed it and the hard-link walk refused it.
    expect(refusal(establishContainment(winBase(seam().run)))).toContain(`holds a link whose target cannot be resolved (${alias}: EACCES`)
  }, 120_000)
})

// ─── The models folder of a context comes from modelsDir() (S6) ─────────────────────────────────

describe('establishContainment: the models folder default', () => {
  const saved = process.env.LOCALCODE_MODELS_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCALCODE_MODELS_DIR
    else process.env.LOCALCODE_MODELS_DIR = saved
  })

  it('with no folders.models argument, a context carries what LOCALCODE_MODELS_DIR names, else models under the CynCo home', () => {
    const rest = { guard: folders.guard, audit: folders.audit }
    const moved = join(dir, 'moved-models')
    mkdirSync(moved)
    process.env.LOCALCODE_MODELS_DIR = moved
    expect(established(establishContainment(base({ test: true, folders: rest }))).folders.models).toBe(moved)
    delete process.env.LOCALCODE_MODELS_DIR
    const ctx = established(establishContainment(base({ test: true, folders: rest })))
    expect(ctx.folders.state).toBe(cyncoHome())
    expect(ctx.folders.models).toBe(join(cyncoHome(), 'models'))
  })
})

describe('establishContainment: the audit folder default (S5)', () => {
  it('with no folders.audit argument, a context carries what auditDir() answers, never null', () => {
    // Under the suite's setup auditDir() names a folder that is never created, so the audit of such a
    // context refuses (audit-dir-missing or audit-dir-in-home): it is never left unaudited.
    const ctx = established(establishContainment(base({ test: true, folders: { guard: folders.guard } })))
    expect(ctx.folders.audit).toBe(auditDir())
    expect(ctx.folders.audit).not.toBeNull()
  })
})

describe('establishContainment: the guard folder default (S7)', () => {
  it('with no folders.guard argument, a context carries what guardDir() answers', () => {
    // Under the suite's setup guardDir() names a folder that is never created, so every integrity
    // check of such a context refuses (the guard folder does not exist): never "no latch".
    const ctx = established(establishContainment(base({ test: true, folders: { audit: folders.audit } })))
    expect(ctx.folders.guard).toBe(guardDir())
    expect(ctx.folders.guard).not.toBe('C:/cynco-guard')
  })
})

// ─── Source pins ────────────────────────────────────────────────────────────────────────────────

describe('source pins', () => {
  const src = readFileSync(join(engineCheckout(), 'engine', 'containment.ts'), 'utf-8')
  const launcher = join(engineCheckout(), 'engine', 'lowIntegrityLauncher.ts')
  it('no /T, no taskkill, no rmSync in the module or the launcher', () => {
    for (const text of [src, existsSync(launcher) ? readFileSync(launcher, 'utf-8') : '']) {
      expect(text).not.toContain("'/T'")
      expect(text).not.toContain('taskkill')
      expect(text).not.toContain('rmSync(')
    }
  })
  // P2-F4 (wave 15): a literal U+FEFF had been written inside a regular expression of the module.
  it('no invisible character in the module or the launcher (an escape is written instead)', () => {
    for (const [name, text] of [['containment.ts', src], ['lowIntegrityLauncher.ts', existsSync(launcher) ? readFileSync(launcher, 'utf-8') : '']]) {
      const hits = [...text.matchAll(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g)].map(m => `line ${text.slice(0, m.index).split('\n').length}: U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`)
      expect(hits, name).toEqual([])
    }
  })
  it('imports nothing from the tools, the audit, the integrity module or harness git', () => {
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    for (const i of imports) expect(i, i).not.toMatch(/tools|audit|integrity|harnessGit/)
  })
})

// ─── B1 (wave 19): the Git-tools switch and the installed Git's namespace ─────────────────────────

describe('B1: the Git-tools switch (LOCALCODE_CONTAINMENT_MSYS, read by the starter at create)', () => {
  /** A copy of the shape the setup step makes, and an "installed Git" whose msys-2.0.dll it matches. */
  function copyAndGit(o: { dll?: string; noBash?: boolean; noFstab?: boolean } = {}): { copy: string; git: string } {
    const copy = join(dir, 'msys-copy')
    const git = join(dir, 'installed-git')
    mkdirSync(join(copy, 'usr', 'bin'), { recursive: true })
    mkdirSync(join(copy, 'etc'), { recursive: true })
    mkdirSync(join(git, 'usr', 'bin'), { recursive: true })
    if (!o.noBash) writeFileSync(join(copy, 'usr', 'bin', 'bash.exe'), 'bash')
    if (!o.noFstab) writeFileSync(join(copy, 'etc', 'fstab'), 'none / cygdrive binary 0 0\n')
    writeFileSync(join(copy, 'usr', 'bin', 'msys-2.0.dll'), o.dll ?? 'dll-v1')
    writeFileSync(join(git, 'usr', 'bin', 'msys-2.0.dll'), 'dll-v1')
    return { copy, git }
  }
  const est = (run: ContainmentRunner, over: Partial<Parameters<typeof establishContainment>[0]> = {}) => establishContainment(winBase(run, over))

  it('off (unset or empty) is today\'s behaviour: no field in the record, no copy in the context', () => {
    const c = established(est(seam().run))
    expect(c.msysRuntime ?? null).toBeNull()
    expect('msysRuntime' in readRec(c.runId)).toBe(false)
    process.env.LOCALCODE_CONTAINMENT_MSYS = '  '
    const d = established(est(seam().run))
    expect('msysRuntime' in readRec(d.runId)).toBe(false)
  })

  it('on: the copy is checked and its real path written into the record; the context carries it, from the record alone', () => {
    const { copy, git } = copyAndGit()
    process.env.LOCALCODE_CONTAINMENT_MSYS = copy
    const c = established(est(seam().run, { gitRoot: git }))
    expect(c.msysRuntime).toBe(realpathSync.native(copy))
    expect(readRec(c.runId).msysRuntime).toBe(realpathSync.native(copy))
    // A run's environment cannot change it: the launcher and adopt build the context from the record.
    process.env.LOCALCODE_CONTAINMENT_MSYS = join(dir, 'elsewhere')
    const back = containmentFromRecord(c.sandbox.root)
    expect(back.ok && back.containment.msysRuntime).toBe(realpathSync.native(copy))
    delete process.env.LOCALCODE_CONTAINMENT_MSYS
    const off = containmentFromRecord(established(est(seam().run)).sandbox.root)
    expect(off.ok && off.containment.msysRuntime).toBeNull()
  })

  it('every refusal of the copy by its text, before anything is created', () => {
    const before = () => readdirSync(L.root).length
    const n0 = before()
    const r = (over: Partial<Parameters<typeof establishContainment>[0]>, s = seam()) => refusal(est(s.run, over))
    expect(r({ msys: 'relative\\copy' })).toBe('LOCALCODE_CONTAINMENT_MSYS names relative\\copy, which is not an absolute path')
    expect(r({ msys: join(dir, 'no-such') })).toBe(`LOCALCODE_CONTAINMENT_MSYS names ${join(dir, 'no-such')}, which does not exist or is not a folder`)
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    expect(refusal(establishContainment(base({ msys: join(dir, 'x') })))).toBe("LOCALCODE_CONTAINMENT_MSYS is for Windows only (a copy of Git's Unix tools for a contained run there)")
    const g = copyAndGit({ noBash: true })
    expect(r({ msys: g.copy, gitRoot: g.git })).toBe(`the copy of Git's tools at ${g.copy} holds no usr\\bin\\bash.exe; make it with scripts/cynco-containment-setup.ps1 -MsysCopy -Apply`)
    writeFileSync(join(g.copy, 'usr', 'bin', 'bash.exe'), 'bash')
    rmSync(join(g.copy, 'etc', 'fstab'))
    expect(r({ msys: g.copy, gitRoot: g.git })).toBe(`the copy of Git's tools at ${g.copy} holds no etc\\fstab; make it with scripts/cynco-containment-setup.ps1 -MsysCopy -Apply`)
    writeFileSync(join(g.copy, 'etc', 'fstab'), 'x')
    // A copy the run could write: inside the mission folder, the home, the sandbox root.
    for (const [where, what, parent] of [[join(L.mission, 'tools'), 'a folder this run may write', L.mission], [join(L.home, 'tools'), 'the home folder', L.home], [join(L.root, 'tools'), 'the sandbox root', L.root]] as const) {
      mkdirSync(join(where, 'usr', 'bin'), { recursive: true })
      mkdirSync(join(where, 'etc'), { recursive: true })
      for (const f of [['usr', 'bin', 'bash.exe'], ['usr', 'bin', 'msys-2.0.dll'], ['etc', 'fstab']]) writeFileSync(join(where, ...f), 'dll-v1')
      expect(r({ msys: where, gitRoot: g.git }), what).toBe(`the copy of Git's tools at ${where} is, contains or is inside ${parent} (${what}), so the run could change the programs it starts`)
      rmSync(where, { recursive: true, force: true })
    }
    const low = seam({ read: p => (p === g.copy ? { ok: true, out: `${p} Everyone:(RX)\r\n    Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\r\n` } : undefined) })
    expect(r({ msys: g.copy, gitRoot: g.git }, low)).toBe(`the copy of Git's tools at ${g.copy} carries a Low integrity label, so a contained run could change the programs it starts`)
    link(L.outside, join(g.copy, 'usr', 'out'))
    expect(r({ msys: g.copy, gitRoot: g.git })).toBe(`the copy of Git's tools at ${g.copy} holds a link that leads outside it (${join(g.copy, 'usr', 'out')} -> ${L.outside})`)
    removeLinkEntry(join(g.copy, 'usr', 'out'))
    links = []
    expect(r({ msys: g.copy, gitRoot: null })).toBe(`the installed Git's usr\\bin\\msys-2.0.dll was not found, so the copy of Git's tools at ${g.copy} could not be compared with it`)
    writeFileSync(join(g.copy, 'usr', 'bin', 'msys-2.0.dll'), 'dll-v0')
    // The owner's condition on sheet item 2: a copy older than the installed Git is refused, with what to do.
    expect(r({ msys: g.copy, gitRoot: g.git })).toBe(`the copy of Git's tools at ${g.copy} is older than the installed Git; run the setup step again`)
    expect(before()).toBe(n0)
  })

  it('toolEnv: the copy\'s usr\\bin first on a contained child\'s PATH, under every spelling, on Windows only; nowhere without a context', () => {
    const copy = 'C:\\cynco-msys'
    const ctx = ctxOf({ msysRuntime: copy })
    const p = 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd'
    const env = toolEnv({ Path: p, SystemRoot: 'C:\\Windows' }, ctx, 'win32')
    expect(env.Path!.split(';')[0]).toBe('C:\\cynco-msys\\usr\\bin')
    // Nothing removed.
    for (const e of p.split(';')) expect(env.Path!.split(';')).toContain(e)
    const two = toolEnv({ Path: p, PATH: 'C:\\x' }, ctx, 'win32')
    expect([two.Path!.split(';')[0], two.PATH!.split(';')[0]]).toEqual(['C:\\cynco-msys\\usr\\bin', 'C:\\cynco-msys\\usr\\bin'])
    expect(toolEnv({}, ctx, 'win32').PATH).toBe('C:\\cynco-msys\\usr\\bin')
    // Off, on Linux, and with no context (the engine's own, the dispatch's, the harness's): unchanged.
    expect(toolEnv({ Path: p }, ctxOf(), 'win32').Path).toBe(p)
    expect(toolEnv({ PATH: '/usr/bin' }, ctx, 'linux').PATH).toBe('/usr/bin')
    process.env.LOCALCODE_CONTAINMENT_MSYS = copy
    expect(toolEnv({ Path: p }, null, 'win32').Path).toBe(p)
    expect(toolEnv({ Path: p }, ctxOf(), 'win32').Path).toBe(p)
  })

  it('the hint: with the switch on, the msys failure names the copy and the bare names; off, as before', () => {
    const out = '0 [main] bash 12: *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1888ae32e00d56aa): 0xC0000022'
    expect(containmentHint('failure', out, ctxOf({ msysRuntime: 'C:\\cynco-msys' }), 'win32')).toBe(`\n[containment] ${MSYS_WITH_COPY('C:\\cynco-msys')}`)
    expect(containmentHint('failure', out, ctxOf(), 'win32')).toContain(MSYS_IN_CONTAINED_RUN)
  })

  // Package F (wave 19): since the holder, the reason is no longer "while any ordinary Git Bash is
  // running": the installed Git's namespace is held always. Its first words stay (the acceptance pins them).
  it('the hint\'s reason names the holder, keeping its first words', () => {
    expect(MSYS_IN_CONTAINED_RUN.startsWith('Git Bash and the other programs of Git')).toBe(true)
    expect(MSYS_IN_CONTAINED_RUN).not.toContain('while any ordinary Git Bash is running')
    expect(MSYS_IN_CONTAINED_RUN).toContain('the process that starts the run\'s commands holds the installed Git\'s shared namespace at normal integrity')
  })

  /**
   * BB-1 (wave 19c, the lead's decision): the two files besides engine/containment.ts that may name the switch or
   * the copy's folder. The acceptance is a starter of its own inner runs and hands the switch through their
   * environment (or command line), so that the engine's own read of it at create is what the stage proves; the
   * attack catalog names it beside the forms run through the copy. No other file may.
   */
  const MSYS_GUARD_EXCEPTIONS = new Set(['scripts/cynco-containment-acceptance.mjs', 'scripts/cynco-containment-attacks.mjs'])
  /** Every source file under <root>/engine and <root>/scripts (tests left out) that names the switch or the copy. */
  const msysNamers = (root: string): string[] => {
    const hits: string[] = []
    const walkDir = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name === 'node_modules' || e.name === '__tests__' || e.name === 'cybernetics-core') continue
        const p = join(d, e.name)
        if (e.isDirectory()) walkDir(p)
        else if (/\.(ts|mjs|js|sh|cmd)$/.test(e.name) && !/\.test\./.test(e.name) && /LOCALCODE_CONTAINMENT_MSYS|cynco-msys/.test(readFileSync(p, 'utf-8'))) {
          hits.push(p.slice(root.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walkDir(join(root, 'engine'))
    walkDir(join(root, 'scripts'))
    return hits.sort()
  }
  /** The namers the guard refuses: all but engine/containment.ts and the two exceptions. */
  const msysGuardOffenders = (root: string): string[] =>
    msysNamers(root).filter(h => h !== 'engine/containment.ts' && !MSYS_GUARD_EXCEPTIONS.has(h))

  // The guard the brief asks for: the copy's folder reaches only a contained child's PATH. No medium
  // process may start the copy (measured: while one runs, every low start of it fails, and one started
  // after a low one joins the namespace the low one made).
  it('guard: the switch is read in one place, and the copy is named only in toolEnv\'s contained Windows branch', () => {
    // Read as LF: a Windows checkout with core.autocrlf=true hands this test CRLF, and the function ends
    // below are found by '\n}\n' (F231's class; on this PC the main checkout failed here from 3533c4d0).
    const text = readFileSync(fileURLToPath(new URL('../containment.ts', import.meta.url)), 'utf-8').replace(/\r\n/g, '\n')
    expect(text.match(/process\.env\.LOCALCODE_CONTAINMENT_MSYS/g)).toHaveLength(1)
    const est0 = text.indexOf('export function establishContainment(')
    const read = text.indexOf('process.env.LOCALCODE_CONTAINMENT_MSYS')
    expect(read).toBeGreaterThan(est0)
    expect(read).toBeLessThan(text.indexOf('\n}\n', est0))
    // `ctx.msysRuntime` is read in toolEnv after its `if (!ctx) return out` and inside `if (win)`, and in the hint.
    const te = text.indexOf('export function toolEnv(')
    const teEnd = text.indexOf('\n}\n', te)
    const winBranch = text.indexOf('  if (win) {', text.indexOf('if (!ctx) return out', te))
    const hint = text.indexOf('export function containmentHint(')
    const hintEnd = text.indexOf('\n}\n', hint)
    const uses = [...text.matchAll(/ctx\.msysRuntime/g)].map(m => m.index!)
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) {
      expect((u > winBranch && u < teEnd) || (u > hint && u < hintEnd), `ctx.msysRuntime at line ${text.slice(0, u).split('\n').length}`).toBe(true)
    }
    // No other file of the engine or the scripts reads the switch or names the production copy, but for the
    // two named exceptions (MSYS_GUARD_EXCEPTIONS, BB-1).
    const root = engineCheckout()
    expect(msysNamers(root)).toContain('engine/containment.ts')
    expect(msysGuardOffenders(root)).toEqual([])
  })

  // BB-1 (wave 19c, the lead's decision): the guard gains exactly two named exceptions, and still fails for
  // any other file that names the switch or the copy's folder.
  it('BB-1: the guard\'s two exceptions are the acceptance\'s files, and a third file that names the switch or the copy still fails it', () => {
    const t = join(dir, 'tree')
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(t, rel)), { recursive: true })
      writeFileSync(join(t, rel), body)
    }
    put('engine/containment.ts', 'process.env.LOCALCODE_CONTAINMENT_MSYS')
    put('scripts/cynco-containment-acceptance.mjs', '// LOCALCODE_CONTAINMENT_MSYS')
    put('scripts/cynco-containment-attacks.mjs', '// C:\\cynco-msys')
    put('scripts/__tests__/x.test.mjs', 'LOCALCODE_CONTAINMENT_MSYS')
    expect(msysGuardOffenders(t)).toEqual([])
    put('scripts/other.mjs', 'const copy = "C:\\\\cynco-msys"')
    put('engine/daemon/other.ts', 'process.env.LOCALCODE_CONTAINMENT_MSYS')
    expect(msysGuardOffenders(t)).toEqual(['engine/daemon/other.ts', 'scripts/other.mjs'])
    expect([...MSYS_GUARD_EXCEPTIONS].sort()).toEqual(['scripts/cynco-containment-acceptance.mjs', 'scripts/cynco-containment-attacks.mjs'])
  })
})

describe.skipIf(process.platform !== 'win32' || installedGitRoot() === null)('B1: the installed Git\'s namespace is held while this process may start contained children (Windows, real Git)', () => {
  const holderCtx = (name: string) => {
    const runDir = join(L.root, name)
    mkdirSync(runDir, { recursive: true })
    return testContainment({
      missionCwd: L.mission, runId: `${name}-20261125T010203-abcd`,
      sandbox: { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }, home: L.home, folders,
    })
  }
  const image = (pid: number) => ((spawnSync(join(SYSTEM32, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' }).stdout ?? '').split(',')[0] ?? '').replace(/"/g, '')
  const gone = async (pid: number) => {
    for (let i = 0; i < 200; i++) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true
      }
      await new Promise(r => setTimeout(r, 25))
    }
    return false
  }

  it('one holder (the installed Git\'s sh.exe) for every run of the process; the last release ends it; its ready file is gone', async () => {
    const a = holderCtx('hold-a'), b = holderCtx('hold-b')
    expect(holdGitNamespace(a)).toBeNull()
    const h = gitNamespaceHolder()!
    expect(h).not.toBeNull()
    expect(image(h.pid).toLowerCase()).toBe('sh.exe')
    expect(holdGitNamespace(b)).toBeNull()
    expect(gitNamespaceHolder()).toEqual({ pid: h.pid, runs: [a.runId, b.runId] })
    expect(readdirSync(a.sandbox.root).filter(n => n.endsWith('.ready'))).toEqual([])
    releaseGitNamespace(a.runId)
    expect(gitNamespaceHolder()?.pid).toBe(h.pid)
    releaseGitNamespace(b.runId)
    expect(gitNamespaceHolder()).toBeNull()
    expect(await gone(h.pid)).toBe(true)
  }, 60_000)

  it('a holder that ends while its run is held poisons that run: nothing contained starts in the process until it is released', async () => {
    const a = holderCtx('hold-c')
    expect(holdGitNamespace(a)).toBeNull()
    const pid = gitNamespaceHolder()!.pid
    // This test ends the holder it started (as something else on the machine might).
    process.kill(pid)
    expect(await gone(pid)).toBe(true)
    await new Promise(r => setTimeout(r, 100))
    const why = holdGitNamespace(a)
    expect(why).toBe(`the process that held Git's shared namespace for run ${a.runId} ended before that run was released; no contained command starts in this process until it is, because a low process could then have made that namespace`)
    expect(holdGitNamespace(holderCtx('hold-d'))).toBe(why)
    releaseGitNamespace(a.runId)
    const e = holderCtx('hold-e')
    expect(holdGitNamespace(e)).toBeNull()
    const again = gitNamespaceHolder()!.pid
    expect(again).not.toBe(pid)
    releaseGitNamespace(e.runId)
    expect(await gone(again)).toBe(true)
  }, 60_000)

  it('no installed Git: nothing to hold, nothing started', () => {
    expect(holdGitNamespace(holderCtx('hold-f'), { gitRoot: null })).toBeNull()
    expect(gitNamespaceHolder()).toBeNull()
  })

  // R3 (check B, wave 19): a spawn that fails without throwing (Node and Bun then report it as an
  // 'error' event and give no pid: measured 2026-11-25 with a folder named sh.exe, scratch r3probe) waited
  // the full 10 s on the caller's event loop, and every later contained spawn tried again.
  it('R3 (wave 19b): a holder that cannot be started refuses at once, and is not started again for a while', () => {
    const fake = join(dir, 'fake-git')
    const sh = join(fake, 'usr', 'bin', 'sh.exe')
    mkdirSync(sh, { recursive: true })
    const t0 = Date.now()
    const why = holdGitNamespace(holderCtx('hold-g'), { gitRoot: fake })
    expect(Date.now() - t0, String(why)).toBeLessThan(3_000)
    expect(why).toBe(`the holder of Git's namespace (${sh}) could not be started (no process was made)`)
    expect(gitNamespaceHolder()).toBeNull()
    // Not started again inside the window: with sh.exe gone, the same refusal still comes back, at once.
    rmdirSync(sh)
    expect(holdGitNamespace(holderCtx('hold-h'), { gitRoot: fake })).toBe(`${why} (a failed start is not tried again for ${GIT_HOLDER_RETRY_MS / 1000} s)`)
    // After the window it is tried again (and now finds no sh.exe at all).
    expect(holdGitNamespace(holderCtx('hold-i'), { gitRoot: fake, now: () => Date.now() + GIT_HOLDER_RETRY_MS + 1_000 })).toBe(`the installed Git at ${fake} has no usr\\bin\\sh.exe to hold its namespace with`)
    // Another Git's holder is not held back by this one's failure.
    const fake2 = join(dir, 'fake-git-2')
    mkdirSync(fake2)
    mkdirSync(sh)
    holdGitNamespace(holderCtx('hold-j'), { gitRoot: fake })
    expect(holdGitNamespace(holderCtx('hold-k'), { gitRoot: fake2 })).toBe(`the installed Git at ${fake2} has no usr\\bin\\sh.exe to hold its namespace with`)
  })

  // R4 (check B, wave 19): the holder is unref'd, so a process that holds the namespace and ends without
  // a release (a one-shot script, a grader's spawn) must not hang on it. Measured 2026-11-25 under Bun and
  // Node (scratch r4-before.txt: ended 5 ms and 1 ms after holding; the holder gone at once); this is
  // the Bun case, the engine's own runtime, kept as a test.
  it('R4 (wave 19b): a Bun process that holds the namespace and returns without a release ends by itself, and its holder with it', async t => {
    const bun = (() => {
      const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 15_000 })
      const exe = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() ?? '' : ''
      return exe !== '' && existsSync(exe) ? exe : null
    })()
    if (bun === null) {
      console.log('[containment] SKIPPED R4: bun is not on PATH (or did not name its executable within 15 s)')
      t.skip()
      return
    }
    const runDir = join(L.root, 'r4')
    mkdirSync(runDir)
    const mod = pathToFileURL(fileURLToPath(new URL('../containment.ts', import.meta.url))).href
    const code = [
      `const C = await import(${JSON.stringify(mod)})`,
      `const ctx = C.testContainment({ missionCwd: ${JSON.stringify(L.mission)}, runId: 'r4-20261125T010203-abcd', sandbox: { root: ${JSON.stringify(runDir)}, home: ${JSON.stringify(join(runDir, 'home'))}, tmp: ${JSON.stringify(join(runDir, 'tmp'))}, scratch: ${JSON.stringify(join(runDir, 'scratch'))} }, home: ${JSON.stringify(L.home)}, folders: ${JSON.stringify(folders)} })`,
      'const why = C.holdGitNamespace(ctx)',
      "console.log('HELD ' + (why === null ? 'ok' : why) + ' HOLDER ' + (C.gitNamespaceHolder()?.pid ?? 'none'))",
    ].join('\n')
    const p = spawn(bun, ['--no-install', '--no-env-file', '-e', code], { cwd: dir, windowsHide: true, env: { ...process.env, BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/' } })
    let out = ''
    let heldAt = 0
    p.stdout.on('data', d => { out += String(d); if (!heldAt && out.includes('HOLDER')) heldAt = Date.now() })
    p.stderr.on('data', d => { out += String(d) })
    const ended = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { p.kill(); resolve(null) }, 30_000)
      p.on('close', () => { clearTimeout(timer); resolve(Date.now()) })
    })
    const m = /HELD ok HOLDER (\d+)/.exec(out)
    expect(m, out).not.toBeNull()
    expect(ended, `the process did not end within 30 s: ${out}`).not.toBeNull()
    expect(ended! - heldAt, out).toBeLessThan(2_000)
    expect(await gone(Number(m![1]))).toBe(true)
  }, 60_000)

  it('installedGitRoot finds the root above usr\\bin, cmd or mingw64\\bin on PATH, and nothing elsewhere', () => {
    const g = join(dir, 'G')
    for (const d of [['usr', 'bin'], ['cmd'], ['mingw64', 'bin']]) mkdirSync(join(g, ...d), { recursive: true })
    writeFileSync(join(g, 'usr', 'bin', 'msys-2.0.dll'), 'x')
    writeFileSync(join(g, 'cmd', 'git.exe'), 'x')
    writeFileSync(join(g, 'mingw64', 'bin', 'git.exe'), 'x')
    expect(installedGitRoot({ PATH: `C:\\nothing;${join(g, 'usr', 'bin')}` })).toBe(g)
    expect(installedGitRoot({ Path: join(g, 'cmd') })).toBe(g)
    expect(installedGitRoot({ PATH: join(g, 'mingw64', 'bin') })).toBe(g)
    expect(installedGitRoot({ PATH: join(dir, 'nothing'), ProgramFiles: join(dir, 'pf') })).toBeNull()
  })
})
