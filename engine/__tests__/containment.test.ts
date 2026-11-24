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
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acknowledgedVolumes, adoptContainment, containedCommand, containmentHint, containmentOff,
  containmentRecords, containmentSwitch, engineCheckout, establishContainment, launcherFaultOf,
  LAUNCHER_UNAVAILABLE, mintRunId, MSYS_IN_CONTAINED_RUN, NO_CONTAINMENT, operatorRefusal,
  refusalLayerOf, refusalPrefix, refusalText, releaseContainment, runContainment, setRunContainment,
  sweepSandboxes, SWITCH_IN_UNATTENDED, testContainment, toolEnv, toolSpawnRefusal,
  type ContainmentRecord, type ContainmentRunner, type RunContainment,
} from '../containment.js'
import { RUN_ID_RE } from '../missionEnv.js'
import { auditDir, cyncoHome, guardDir } from '../paths.js'
import { isLinkEntry, listEntries, whyNotAtOwnPath, type EntryKind } from '../realPath.js'

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

const ENV_KEYS = ['LOCALCODE_CONTAINMENT_OFF', 'LOCALCODE_UNPROTECTED_VOLUMES_OK', 'LOCALCODE_MISSION_MARKER']

let dir: string
let L: { root: string; home: string; mission: string; extra: string; state: string; models: string; guard: string; outside: string }
let folders: RunContainment['folders']
let links: string[]

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
  return { run, calls, icacls, labels }
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
    rmdirSync(join(L.mission, 'out1'))
    links = []
    mkdirSync(join(L.mission, 'sub'))
    link(L.outside, join(L.mission, 'sub', 'out2'))
    expect(refusal(establishContainment(base()))).toBe(`the mission folder ${L.mission} holds a link that leads outside it (${join(L.mission, 'sub', 'out2')} -> ${L.outside})`)
    rmdirSync(join(L.mission, 'sub', 'out2'))
    links = []
    mkdirSync(join(L.mission, 'inner'))
    link(join(L.mission, 'inner'), join(L.mission, 'sub', 'in'))
    expect(establishContainment(base()).ok).toBe(true)
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
    expect(s.labels('M')).toEqual([L.mission])
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
    const s = seam({ icacls: args => (args[0] === L.extra ? { ok: false, out: `${L.extra}: Access is denied.` } : undefined) })
    const r = establishContainment(winBase(s.run, { extraRoots: [L.extra] }))
    expect(refusal(r)).toBe(`the extra folder ${L.extra} could not be labelled low integrity (${L.extra}: Access is denied.)`)
    expect(s.labels('M')).toEqual([L.mission])
    const [rec] = containmentRecords({ sandboxRoot: L.root })
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
    expect(r.labels('M')).toEqual([L.mission, L.extra])
    expect(r.calls.some(x => x.args.some(a => a.toUpperCase() === '/T'))).toBe(false)
    expect(readRec(c.runId).releasedBy).toBe('release')
    const again = releaseContainment(c.runId, { sandboxRoot: L.root, platform: 'win32', run: r.run })
    expect(again.note).toBe(`run ${c.runId} was already released at ${readRec(c.runId).releasedAt}`)
    expect(r.labels('M')).toHaveLength(2)
  })

  it('leaves a folder another live run holds, and says which', () => {
    const first = labelledRun(seam())
    const second = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = { pid: process.pid, startedAt: new Date().toISOString() } })
    const r = seam()
    const res = releaseContainment(second, { platform: 'win32', run: r.run })
    expect(r.labels('M')).toEqual([])
    expect(res.note).toContain(`${L.mission} stays labelled low: run ${first.runId} still holds it`)
  })

  it('relabels when the other run\'s holder is gone, or it has had no holder for 15 minutes', () => {
    const first = labelledRun(seam())
    const second = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = { pid: deadPid(), startedAt: new Date().toISOString() } })
    const r = seam()
    releaseContainment(second, { platform: 'win32', run: r.run })
    expect(r.labels('M')).toEqual([L.mission, L.extra])
    const third = labelledRun(seam())
    editRec(first.runId, rec => { rec.holder = null; rec.createdAt = new Date(Date.now() - 20 * 60_000).toISOString() })
    const r2 = seam()
    releaseContainment(third, { platform: 'win32', run: r2.run })
    expect(r2.labels('M')).toEqual([L.mission, L.extra])
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
    expect(refusal(establishContainment(winBase(seam().run)))).toContain(`holds an entry that could not be read for hard links (${alias}: EACCES`)
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
  it('imports nothing from the tools, the audit, the integrity module or harness git', () => {
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    for (const i of imports) expect(i, i).not.toMatch(/tools|audit|integrity|harnessGit/)
  })
})
