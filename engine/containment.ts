/**
 * engine/containment.ts: the containment of unattended runs (F242).
 *
 * On 2026-11-22 one Bash call of an unattended campaign mission deleted every dot-folder of the
 * owner's home folder. This module is the run context every layer consults (`runContainment()`),
 * the per-run sandbox and its record (`<sandbox root>/<run id>/containment.json`), the one
 * environment builder for every child that runs workspace code (`toolEnv`), the one place that
 * decides how such a child is started (`containedCommand`: as it is, or on Windows through the
 * low-integrity launcher `engine/lowIntegrityLauncher.ts`), `toolExec` / `toolExecSync`, and the
 * one refusal format every layer uses.
 *
 * It imports node built-ins, `./paths.js`, `./missionEnv.js` and `./realPath.js` only, and no Bun
 * API, so the tools, the audit and the integrity module can import it without a cycle and vitest's
 * Node can load it. Every synchronous child it starts (`icacls`, `whoami`, the launcher probe, the
 * volume listing) goes through `runVia`, which applies the F155 rule. No `icacls` call carries
 * `/T`, and the module never calls a recursive remove: `removeTreeNoFollow` is the one walk that
 * deletes, and only `sweepSandboxes` calls it.
 */
import { exec, execFile, execFileSync, execSync, spawnSync } from 'node:child_process'
import type { ChildProcess, ExecException, ExecSyncOptions } from 'node:child_process'
import type { BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditDir, cyncoHome, modelsDir, sandboxRoot } from './paths.js'
import { isContainedRun, RUN_ID_RE } from './missionEnv.js'
import { isInside, realPathOf } from './realPath.js'

// ─── Types and module state ──────────────────────────────────────────────────────────────────

export const CONTAINMENT_LAYERS = ['lowil', 'paths'] as const
export type ContainmentLayer = (typeof CONTAINMENT_LAYERS)[number]
export type ContainmentKind = 'mission' | 'daemon-task' | 'precheck' | 'grader'

export interface RunContainment {
  runId: string
  kind: ContainmentKind
  test: boolean
  missionCwd: string
  cwdLabel: 'low' | 'none'
  extraRoots: string[]
  sandbox: { root: string; home: string; tmp: string; scratch: string }
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  unprotectedVolumes: string[]
  isolation: 'verified' | 'overlay'
}

export interface ContainmentRecord {
  schema: 1
  runId: string; kind: ContainmentKind; test: boolean
  missionCwd: string; cwdLabel: 'low' | 'none'; cwdGranted: boolean
  extraRoots: string[]
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  unprotectedVolumes: string[]
  createdAt: string
  createdByPid: number
  holder: { pid: number; startedAt: string } | null
  releasedAt: string | null
  releasedBy?: 'release' | 'sweep' | 'failed-establish' | 'holder-gone'
}

/** The injectable synchronous runner (the test seam). `out` is stdout plus stderr. */
export type ContainmentRunner = (file: string, args: string[], capMs: number) => { ok: boolean; out: string; code: number | null }

let current: RunContainment | null = null

/** The context of this process, or null when it is not a contained run. */
export function runContainment(): RunContainment | null {
  return current
}

/** Set by the engine's boot block, by the driver after its adopt, and by tests (restored to null). */
export function setRunContainment(c: RunContainment | null): void {
  current = c
}

function frozen(c: RunContainment): RunContainment {
  Object.freeze(c.sandbox)
  Object.freeze(c.folders)
  Object.freeze(c.extraRoots)
  Object.freeze(c.unprotectedVolumes)
  return Object.freeze(c)
}

/**
 * A context for a test, built from the folders the test names. Pure: it touches no disk. Refuses
 * to run inside a process that is itself an unattended run.
 */
export function testContainment(a: {
  missionCwd: string
  sandbox: { root: string; home: string; tmp: string; scratch: string }
  home: string
  folders: { state: string; models: string; guard: string; audit: string | null }
  kind?: ContainmentKind
  extraRoots?: string[]
  unprotectedVolumes?: string[]
  isolation?: 'verified' | 'overlay'
  runId?: string
}): RunContainment {
  if (isContainedRun(process.env, process.argv)) {
    throw new Error('testContainment() was called in a process that is itself an unattended run')
  }
  return frozen({
    runId: a.runId ?? mintRunId('test'),
    kind: a.kind ?? 'mission',
    test: true,
    missionCwd: resolve(a.missionCwd),
    cwdLabel: 'none',
    extraRoots: (a.extraRoots ?? []).map(p => resolve(p)),
    sandbox: { ...a.sandbox },
    home: a.home,
    folders: { ...a.folders },
    unprotectedVolumes: [...(a.unprotectedVolumes ?? [])],
    isolation: a.isolation ?? 'overlay',
  })
}

// ─── The refusal text, one format for every layer ────────────────────────────────────────────

export type RefusalLayer = 'containment' | 'protected path' | 'audit' | 'integrity'
const REFUSAL_LAYERS: readonly RefusalLayer[] = ['containment', 'protected path', 'audit', 'integrity']

const DEFAULT_ADVICE: Record<RefusalLayer, string> = {
  containment: 'The command was not run, and retrying it will not help: this is an unattended run and its tools start only inside its sandbox.',
  audit: 'Nothing was run. No tool will run until that is fixed, and it cannot be fixed from inside the run: do not retry and do not try another tool. Say in your reply that the run stopped because the record could not be written, and stop.',
  integrity: 'Nothing was run. A protected folder changed during this run; the run has been stopped and the owner has been paged. Do not retry and do not try another tool. Say in your reply what you did last, and stop.',
  // The protected-path layer always passes its own advice (`Nothing was run.`, a blank line and
  // its advice paragraph); this is the floor when it does not.
  'protected path': 'Nothing was run.',
}

export function refusalPrefix(layer: RefusalLayer): string {
  return `Refused [${layer}]:`
}

/** `Refused [<layer>]: <reason>. <advice>`, what the model is shown as a tool result. */
export function refusalText(layer: RefusalLayer, reason: string, advice?: string): string {
  return `${refusalPrefix(layer)} ${reason}. ${advice ?? DEFAULT_ADVICE[layer]}`
}

/** The layer a refusal text was made by, read from its prefix; null for any other text. */
export function refusalLayerOf(output: string): RefusalLayer | null {
  if (typeof output !== 'string') return null
  for (const layer of REFUSAL_LAYERS) if (output.startsWith(refusalPrefix(layer))) return layer
  return null
}

/**
 * The reason a refusal text carries, as every fault is raised with it: the first line after the
 * `Refused [<layer>]:` prefix, at most 300 characters. One form for the executor and for the sites
 * that start a process without it, so the operator reads the same text from every source.
 */
export function refusalReasonOf(text: string): string {
  const line = String(text).slice(String(text).indexOf(':') + 1).trim().split('\n')[0] ?? ''
  return line.trim().slice(0, 300)
}

/** `<tag> REFUSED: <layer>: <reason> — nothing was <run | dispatched>`, for stderr, a log or an outcome. */
export function operatorRefusal(tag: string, layer: RefusalLayer, reason: string, what: 'run' | 'dispatched'): string {
  return `${tag} REFUSED: ${layer}: ${reason} — nothing was ${what}`
}

export const NO_CONTAINMENT = 'no containment was established for this unattended run'
export const SWITCH_IN_UNATTENDED = 'LOCALCODE_CONTAINMENT_OFF switches a containment layer off and may not be set for a dispatched mission, a daemon task, a precheck or a grader'
export const LAUNCHER_UNAVAILABLE = (why: string) => `the low-integrity launcher is unavailable on this Windows runtime (${why})`
export const MSYS_IN_CONTAINED_RUN = 'Git Bash and the other programs of Git\\usr\\bin (bash, sh, grep, sed, tail, head, ls) cannot start inside a contained run on Windows while any ordinary Git Bash is running, and one always is during a dispatched mission'

/** The line `dispatch-mission.sh` prints and the campaign runner reads back (ruling 3.3). */
export const DISPATCH_RUN_PREFIX = '[dispatch] run '

/** The launcher's own exit codes (entry 1.M1): "did not run" and "ended with no status". */
export const LAUNCHER_REFUSED_EXIT = 197
export const LAUNCHER_CHILD_GONE_EXIT = 198

/**
 * The per-spawn seal (review of slice S5): `containedCommand` puts a fresh random value in the
 * launcher's OWN environment under this key, the launcher takes it out of its environment before it
 * builds the child's (and `toolEnv` strips the key for every child), and the launcher ends its own
 * 197 and 198 with `[containment] sealed <seal> <status>` on stderr. The child shares that stderr and
 * passes its status through, so without the seal a command could print the refused line, exit 197
 * and have its own call booked as one that never ran. The child's environment never holds the value,
 * and a low-integrity process cannot read the memory of the medium-integrity processes that do
 * (Windows' no-read-up policy on process objects; not measured here).
 */
export const LAUNCHER_SEAL_ENV = 'CYNCO_LAUNCHER_SEAL'
export const LAUNCHER_SEAL_PREFIX = '[containment] sealed '

/** A sandbox is removed by the sweep this many days after it was created. */
export const SANDBOX_KEEP_DAYS = 7

const HOLDERLESS_GRACE_MS = 15 * 60_000
const LONG_COMMAND_CHARS = 8000
const LAUNCHER_SCRIPT = 'lowIntegrityLauncher.ts'
const LAUNCHER_CONFIG = 'lowIntegrityLauncher.bunfig.toml'

/**
 * A refusal made before a spawn, or a launcher that could not run (codes ECONTAINMENT / ECHILDGONE).
 * `ran` is true when a process the caller started did run (the launcher's child ended with no status,
 * or a Bun it started could not load its script): then `exitCode` is that process's status, or null.
 */
export class ContainmentRefusal extends Error {
  code: 'ECONTAINMENT' | 'ECHILDGONE'
  reason: string
  ran: boolean
  exitCode: number | null
  constructor(code: 'ECONTAINMENT' | 'ECHILDGONE', reason: string, text: string, ran = false, exitCode: number | null = null) {
    super(text)
    this.name = 'ContainmentRefusal'
    this.code = code
    this.reason = reason
    this.ran = ran
    this.exitCode = exitCode
  }
}

// ─── The checkout, the switch ────────────────────────────────────────────────────────────────

let checkoutCache: string | null = null

/** The checkout the running engine was loaded from: the parent of `engine/`, as a real path. */
export function engineCheckout(): string {
  if (checkoutCache === null) checkoutCache = realPathOf(dirname(dirname(fileURLToPath(import.meta.url))), { quiet: true })
  return checkoutCache
}

/** The ONE read of `LOCALCODE_CONTAINMENT_OFF`: a comma list of layer words. */
export function containmentSwitch(env: Record<string, string | undefined> = process.env)
  : { raw: string | null; off: ContainmentLayer[]; unknown: string[] } {
  const v = env.LOCALCODE_CONTAINMENT_OFF
  if (typeof v !== 'string' || v.trim() === '') return { raw: null, off: [], unknown: [] }
  const off: ContainmentLayer[] = []
  const unknown: string[] = []
  for (const word of v.split(',').map(w => w.trim().toLowerCase()).filter(w => w !== '')) {
    if ((CONTAINMENT_LAYERS as readonly string[]).includes(word)) off.push(word as ContainmentLayer)
    else unknown.push(word)
  }
  return { raw: v, off, unknown }
}

function switchedOff(layer: ContainmentLayer, test: boolean, env: Record<string, string | undefined> = process.env): boolean {
  const sw = containmentSwitch(env)
  return test && sw.unknown.length === 0 && sw.off.includes(layer)
}

/** Is `layer` switched off for this context? Only ever for a test context, and never with an unknown word. */
export function containmentOff(layer: ContainmentLayer, ctx: RunContainment | null,
  env: Record<string, string | undefined> = process.env): boolean {
  return switchedOff(layer, ctx?.test === true, env)
}

function unknownLayerReason(word: string): string {
  return `LOCALCODE_CONTAINMENT_OFF names an unknown layer: ${word}`
}

// ─── The environment builder ─────────────────────────────────────────────────────────────────

export const SECRET_ENV = [/^CYNCO_NTFY_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^LOCALCODE_API_KEY$/, /^OPENAI_API_KEY$/]

/** Keys the harness reads and no tool child may hold, in every mode (Phase 7 final review I1). */
const ALWAYS_STRIP = [/^LOCALCODE_MISSION_/, /^CYNCO_MARKER_CHECK/, /^CYNCO_MISSION_ALSO_LABEL$/, /^CYNCO_LAUNCHER_SEAL$/]
/** Keys that name the containment's own folders and switches; stripped when a context is set. */
const CONTEXT_STRIP = /^LOCALCODE_(SANDBOX_ROOT|GUARD_DIR|AUDIT_DIR|MODELS_DIR|CONTAINMENT_|UNPROTECTED_VOLUMES_OK)/

/**
 * The environment of every child that runs workspace code. With no context: `base` without the
 * harness-only keys, with UTF-8 forced for Python. With a context: also without the containment's
 * own keys and the secrets, and with home, temp and scratch pointed into the sandbox. Applied
 * exactly once per child (it is not idempotent: PYTHONUSERBASE is derived from the base APPDATA).
 */
export function toolEnv(base: Record<string, string | undefined> = process.env, ctx: RunContainment | null = runContainment(),
  platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  const win = platform === 'win32'
  const norm = (k: string) => (win ? k.toUpperCase() : k)
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) {
    const nk = norm(k)
    if (ALWAYS_STRIP.some(re => re.test(nk))) continue
    if (ctx && (CONTEXT_STRIP.test(nk) || SECRET_ENV.some(re => re.test(nk)))) continue
    out[k] = v
  }
  const get = (key: string): string | undefined => {
    if (!win) return base[key]
    for (const [k, v] of Object.entries(base)) if (k.toUpperCase() === key && typeof v === 'string') return v
    return undefined
  }
  // On Windows a key differing only in case is the same variable: keep one spelling.
  const set = (key: string, value: string) => {
    if (win) for (const k of Object.keys(out)) if (k !== key && k.toUpperCase() === key) delete out[k]
    out[key] = value
  }
  set('PYTHONIOENCODING', 'utf-8')
  set('PYTHONUTF8', '1')
  if (!ctx) return out

  const sb = ctx.sandbox
  set('HOME', sb.home)
  set('TEMP', sb.tmp)
  set('TMP', sb.tmp)
  set('TMPDIR', sb.tmp)
  set('CYNCO_SCRATCH', sb.scratch)
  set('GIT_CONFIG_GLOBAL', join(sb.home, '.gitconfig'))
  const userBase = get('PYTHONUSERBASE')
  if (userBase !== undefined && userBase !== '') set('PYTHONUSERBASE', userBase)
  else if (win) set('PYTHONUSERBASE', join(get('APPDATA') || join(ctx.home, 'AppData', 'Roaming'), 'Python'))
  else set('PYTHONUSERBASE', join(ctx.home, '.local'))
  if (win) {
    set('USERPROFILE', sb.home)
    const m = /^([A-Za-z]:)(.*)$/.exec(sb.home)
    set('HOMEDRIVE', m ? m[1] : '')
    set('HOMEPATH', m ? (m[2].replace(/\//g, '\\') || '\\') : sb.home)
    set('APPDATA', join(sb.home, 'AppData', 'Roaming'))
    set('LOCALAPPDATA', join(sb.home, 'AppData', 'Local'))
  }
  const xdg: Array<[string, string[]]> = [
    ['XDG_CONFIG_HOME', ['.config']], ['XDG_CACHE_HOME', ['.cache']],
    ['XDG_DATA_HOME', ['.local', 'share']], ['XDG_STATE_HOME', ['.local', 'state']],
  ]
  for (const [key, parts] of xdg) if (get(key) !== undefined) set(key, join(sb.home, ...parts))
  return out
}

// ─── How a contained child is started ────────────────────────────────────────────────────────

export interface ToolCommand { file: string; args: string[]; shell?: string | true }
export interface ContainedSpawn {
  file: string; args: string[]; cwd: string | undefined
  env: Record<string, string | undefined>; viaLauncher: boolean
  /** A long command written to the run folder; the caller deletes it when the child has ended. */
  commandFile?: string
  /** The launcher's seal for this spawn (`LAUNCHER_SEAL_ENV`); set exactly when `viaLauncher`. */
  seal?: string
}

let commandFileSeq = 0

function launcherPaths(): { script: string; config: string } {
  const engineDir = join(engineCheckout(), 'engine')
  return { script: join(engineDir, LAUNCHER_SCRIPT), config: join(engineDir, LAUNCHER_CONFIG) }
}

/** The launcher's start form, up to and including its script path. */
function launcherHead(): string[] {
  const { script, config } = launcherPaths()
  return ['--no-env-file', `--config=${config}`, script]
}

/**
 * The ONE place that decides the file, arguments, working folder and environment of a child that
 * runs workspace code. Pass-through with no context, off Windows, or for a test context with
 * `lowil` switched off; otherwise the low-integrity launcher's argv, started in the checkout with
 * the engine's own environment (the launcher builds the child's environment after it has lowered
 * its token).
 */
export function containedCommand(cmd: ToolCommand, o: {
  ctx?: RunContainment | null; cwd?: string
  env?: Record<string, string | undefined>; extraEnv?: Record<string, string>
  platform?: NodeJS.Platform; execPath?: string
} = {}): ContainedSpawn {
  const ctx = o.ctx === undefined ? runContainment() : o.ctx
  const platform = o.platform ?? process.platform
  if (!ctx || platform !== 'win32' || containmentOff('lowil', ctx)) {
    return {
      file: cmd.file, args: [...cmd.args], cwd: o.cwd, viaLauncher: false,
      env: toolEnv({ ...(o.env ?? process.env), ...(o.extraEnv ?? {}) }, ctx, platform),
    }
  }
  const pairs = new Map<string, string>()
  for (const [k, v] of Object.entries(o.env ?? {})) if (typeof v === 'string' && v !== process.env[k]) pairs.set(k, v)
  for (const [k, v] of Object.entries(o.extraEnv ?? {})) pairs.set(k, v)
  let mode: string[]
  let commandFile: string | undefined
  if (cmd.shell !== undefined) {
    const shell = cmd.shell === true ? '' : cmd.shell
    if (cmd.file.length > LONG_COMMAND_CHARS) {
      commandFile = join(ctx.sandbox.root, `cmd-${process.pid}-${++commandFileSeq}.txt`)
      writeFileSync(commandFile, cmd.file, 'utf-8')
      mode = ['--shell', shell, '--command-file', commandFile]
    } else {
      mode = ['--shell', shell, cmd.file]
    }
  } else {
    mode = ['--exec', cmd.file, ...cmd.args]
  }
  const args = [
    ...launcherHead(),
    '--run-dir', ctx.sandbox.root,
    '--cwd', o.cwd ?? process.cwd(),
    ...[...pairs].flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...mode,
  ]
  const seal = randomBytes(16).toString('hex')
  const out: ContainedSpawn = {
    file: o.execPath ?? process.execPath, args, cwd: engineCheckout(),
    env: { ...process.env, [LAUNCHER_SEAL_ENV]: seal }, viaLauncher: true, seal,
  }
  if (commandFile !== undefined) out.commandFile = commandFile
  return out
}

function runningUnderBun(): boolean {
  return typeof (globalThis as { Bun?: { version?: string } }).Bun?.version === 'string'
}

/** Why the launcher cannot run in this process, or null when it can. */
function launcherUnavailable(bun: boolean): string | null {
  if (!bun) return LAUNCHER_UNAVAILABLE('not Bun')
  const { script, config } = launcherPaths()
  for (const p of [script, config]) if (!existsSync(p)) return LAUNCHER_UNAVAILABLE(`launcher file missing: ${p}`)
  return null
}

function spawnRefusalReason(o: { ctx?: RunContainment | null; required?: boolean; platform?: NodeJS.Platform; bun?: boolean } = {}): string | null {
  const ctx = o.ctx === undefined ? runContainment() : o.ctx
  if (!ctx) return o.required === true ? NO_CONTAINMENT : null
  const sw = containmentSwitch()
  if (sw.unknown.length > 0) return unknownLayerReason(sw.unknown[0])
  if (sw.raw !== null && !ctx.test) return SWITCH_IN_UNATTENDED
  if ((o.platform ?? process.platform) !== 'win32') return null
  if (containmentOff('lowil', ctx)) return null
  return launcherUnavailable(o.bun ?? runningUnderBun())
}

/**
 * Null when a child may be started now; otherwise the complete refusal text the caller returns
 * (`Refused [containment]: ...`). There is no downgrade: on Windows a contained run whose launcher
 * cannot run starts nothing.
 */
export function toolSpawnRefusal(o: { ctx?: RunContainment | null; required?: boolean; platform?: NodeJS.Platform; bun?: boolean } = {}): string | null {
  const reason = spawnRefusalReason(o)
  return reason === null ? null : refusalText('containment', reason)
}

/**
 * Bun's own line when it could not read a module it was asked to load. Measured 2026-11-23 on Bun
 * 1.3.13: a Bun process at low integrity gets it for ANY file in a folder that is not labelled low
 * (a script in the engine's checkout, `C:\Windows\System32\drivers\etc\hosts`), exit 1, before the
 * script has run a line; node and PowerShell at the same level read the same files.
 */
const BUN_LOW_READ = /^error: EPERM reading "([^"\r\n]+)"\s*$/m

/**
 * A launcher exit that means "did not run" (197 with its refused line), "ended with no status"
 * (198 with its line), or a Bun the launcher started that could not load its own script at low
 * integrity (exit 1 with Bun's `error: EPERM reading "<file>"` line; the gate-authoring check is
 * the known case, 01-isolation entry 1.B2 part 2). A 197 or 198 counts only when stderr carries the
 * launcher's seal line for THIS spawn (`seal`, from `containedCommand`): the child shares the
 * launcher's stderr and passes its own status through, so a command that prints the refused line
 * and exits 197 itself is an ordinary exit code (review of slice S5). With no seal no 197 or 198 is
 * a fault. A command that prints Bun's line itself and exits 1 reads as "did not run" for a harness
 * check, never as a pass; `ran` is true for it and for 198, because a process did run, so a tool
 * result built from either carries an exit code and is never read as a refusal made before a spawn.
 */
export function launcherFaultOf(status: number | null | undefined, stderr: string | Buffer | null | undefined, seal: string | undefined)
  : { code: 'ECONTAINMENT' | 'ECHILDGONE'; reason: string; text: string; ran: boolean; exitCode: number | null } | null {
  if (status === 1) {
    const m = BUN_LOW_READ.exec(stderr == null ? '' : String(stderr))
    if (m === null) return null
    const reason = `Bun at low integrity could not read ${m[1]} (EPERM), a file outside the folders the run may write, so the command did not run`
    return {
      code: 'ECONTAINMENT', reason, ran: true, exitCode: 1,
      text: refusalText('containment', reason, 'A Bun script that lives outside the mission folder cannot be run inside a contained run on this Bun; nothing it would have done was done.'),
    }
  }
  if (status !== LAUNCHER_REFUSED_EXIT && status !== LAUNCHER_CHILD_GONE_EXIT) return null
  if (typeof seal !== 'string' || seal.length < 16) return null
  const lines = (stderr == null ? '' : String(stderr)).split(/\r?\n/)
  const sealAt = lines.lastIndexOf(`${LAUNCHER_SEAL_PREFIX}${seal} ${status}`)
  if (sealAt < 0) return null
  const before = lines.slice(0, sealAt).reverse()
  if (status === LAUNCHER_REFUSED_EXIT) {
    const line = before.find(l => l.startsWith('[containment] refused: '))
    if (line === undefined) return null
    const reason = line.slice('[containment] refused: '.length).trim()
    return { code: 'ECONTAINMENT', reason, text: refusalText('containment', reason), ran: false, exitCode: null }
  }
  const line = before.find(l => l.startsWith('[containment] child ended: '))
  if (line === undefined) return null
  const reason = `the contained command ended without an exit status (${line.slice('[containment] child ended: '.length).trim()})`
  return {
    code: 'ECHILDGONE', reason, ran: true, exitCode: null,
    text: refusalText('containment', reason, 'It started and then ended without an exit status, so its result is unknown: check what it changed before running it again.'),
  }
}

function removeCommandFile(p: string | undefined): void {
  if (p === undefined) return
  try {
    unlinkSync(p)
  } catch (e) {
    console.log(`[containment] the command file ${p} could not be removed: ${(e as Error).message}`)
  }
}

function refuseBeforeSpawn(ctx: RunContainment | null): void {
  const reason = spawnRefusalReason({ ctx })
  if (reason !== null) throw new ContainmentRefusal('ECONTAINMENT', reason, refusalText('containment', reason))
}

/**
 * `exec` with the shared environment and, in a contained run on Windows, the launcher. The same
 * callback, error fields, encoding and `maxBuffer` as `exec`; the returned child is the one whose
 * pid the caller owns (the launcher's, when there is one). Throws `ContainmentRefusal` when
 * `toolSpawnRefusal` is non-null: callers ask first, the throw is the backstop.
 */
export function toolExec(command: string, options: {
  cwd?: string; shell?: string; encoding: 'utf-8'; timeout?: number; maxBuffer?: number
  windowsHide?: boolean; env?: Record<string, string | undefined>
}, callback: (err: ExecException | null, stdout: string, stderr: string) => void,
ctx: RunContainment | null = runContainment()): ChildProcess {
  refuseBeforeSpawn(ctx)
  const c = containedCommand({ file: command, args: [], shell: options.shell ?? true }, { ctx, cwd: options.cwd, env: options.env })
  if (!c.viaLauncher) return exec(command, { ...options, cwd: c.cwd, env: c.env }, callback)
  const { shell: _shell, ...rest } = options
  return execFile(c.file, c.args, { ...rest, cwd: c.cwd, env: c.env }, (err, stdout, stderr) => {
    removeCommandFile(c.commandFile)
    const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
    const fault = err ? launcherFaultOf(code, stderr, c.seal) : null
    if (fault) {
      callback(new ContainmentRefusal(fault.code, fault.reason, fault.text, fault.ran, fault.exitCode) as unknown as ExecException, stdout, stderr)
      return
    }
    // execFile's error carries the same fields exec's does (code, killed, signal, cmd).
    callback(err as ExecException | null, stdout, stderr)
  })
}

/** `execSync` over the same answer as `toolExec`; a launcher fault throws `ContainmentRefusal`. */
export function toolExecSync(command: string, options: ExecSyncOptions = {}, ctx: RunContainment | null = runContainment()): string | Buffer {
  refuseBeforeSpawn(ctx)
  const c = containedCommand({ file: command, args: [], shell: options.shell ?? true }, {
    ctx, cwd: typeof options.cwd === 'string' ? options.cwd : options.cwd?.toString(),
    env: options.env as Record<string, string | undefined> | undefined,
  })
  if (!c.viaLauncher) return execSync(command, { ...options, cwd: c.cwd, env: c.env })
  const { shell: _shell, ...rest } = options
  try {
    return execFileSync(c.file, c.args, { ...rest, cwd: c.cwd, env: c.env })
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string | Buffer | null }
    const fault = launcherFaultOf(err.status, err.stderr, c.seal)
    if (fault) throw new ContainmentRefusal(fault.code, fault.reason, fault.text, fault.ran, fault.exitCode)
    throw e
  } finally {
    removeCommandFile(c.commandFile)
  }
}

const MSYS_SIGNATURE = /NtCreateDirectoryObject\(\\BaseNamedObjects\\msys-/

/** What a contained command's output is followed by, so a failure the containment caused says so. Pure. */
export function containmentHint(kind: 'failure' | 'success' | 'timeout', output: string,
  ctx: RunContainment | null = runContainment(), platform: NodeJS.Platform = process.platform): string {
  if (!ctx || platform !== 'win32') return ''
  if (kind === 'timeout') {
    return '\n[containment] This run may write only in its mission folder and in $env:CYNCO_SCRATCH. A Python program that asks for a temporary file or folder anywhere else can spin until the timeout instead of failing; pytest does that from a folder it may not write unless it is run with -p no:cacheprovider.'
  }
  if (MSYS_SIGNATURE.test(output)) {
    return `\n[containment] ${MSYS_IN_CONTAINED_RUN}. Use the PowerShell form instead (Select-String, Select-Object -First / -Last, Get-Content -Tail, Get-ChildItem). A git hook written as a shell script fails the same way.`
  }
  const bun = kind === 'failure' ? BUN_LOW_READ.exec(output) : null
  if (bun !== null) {
    return `\n[containment] Bun at low integrity could not load ${bun[1]} (EPERM): a Bun script outside the folders this run may write cannot be run inside a contained run on this Bun. The shell itself ran, so whatever the command did before that line was done.`
  }
  return ''
}

// ─── Run ids, integrity level, volumes ───────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `<label>-<YYYYMMDD>T<HHMMSS>-<4 hex>` in local time; always matches RUN_ID_RE. */
export function mintRunId(label: string, now: Date = new Date()): string {
  let safe = String(label ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40)
  if (safe === '') safe = 'run'
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${safe}-${stamp}-${randomBytes(2).toString('hex')}`
}

function sys(exe: string): string {
  return join(process.env.SystemRoot || 'C:/Windows', 'System32', exe)
}

/** One synchronous child, never through a shell, in the checkout. A timeout says ETIMEDOUT in `out`. */
function runOnce(file: string, args: string[], capMs: number): { ok: boolean; out: string; code: number | null } {
  const r = spawnSync(file, args, { cwd: engineCheckout(), windowsHide: true, timeout: capMs, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code ?? r.error.message
    return { ok: false, out: `${out}${out && !out.endsWith('\n') ? '\n' : ''}${code}`, code: r.status ?? null }
  }
  return { ok: r.status === 0, out, code: r.status ?? null }
}

/**
 * Every synchronous child of this module goes through here. bun's stale spawn deadline (F155)
 * can end a call with ETIMEDOUT long before its cap: a timeout that arrived before half the cap
 * had passed is retried once, and said out loud.
 */
function runVia(runner: ContainmentRunner | undefined, file: string, args: string[], capMs: number) {
  const r = runner ?? runOnce
  const t0 = Date.now()
  const first = r(file, args, capMs)
  const ms = Date.now() - t0
  if (!first.ok && first.code === null && /ETIMEDOUT/.test(first.out) && ms < capMs / 2) {
    console.log(`[containment] ${file}: an impossible ETIMEDOUT after ${ms} ms; retried once (F155)`)
    return r(file, args, capMs)
  }
  return first
}

function lastLine(out: string): string {
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  return lines.length ? lines[lines.length - 1] : '(no output)'
}

function levelFromGroups(out: string): 'low' | 'medium' | 'high' | 'unknown' {
  const m = /S-1-16-(\d+)/.exec(out)
  if (!m) return 'unknown'
  const rid = Number(m[1])
  if (rid <= 0x1000) return 'low'
  if (rid < 0x3000) return 'medium'
  return 'high'
}

function readIntegrityLevel(runner?: ContainmentRunner): 'low' | 'medium' | 'high' | 'unknown' {
  const r = runVia(runner, sys('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], 10_000)
  if (!r.ok) {
    console.log(`[containment] the integrity level of this process could not be read (${lastLine(r.out)})`)
    return 'unknown'
  }
  return levelFromGroups(r.out)
}

let ownLevelCache: 'low' | 'medium' | 'high' | 'unknown' | null = null

/** This process's integrity level, read from its own token (never from a variable); cached. */
export function ownIntegrityLevel(): 'low' | 'medium' | 'high' | 'unknown' {
  if (process.platform !== 'win32') return 'medium'
  if (ownLevelCache === null) ownLevelCache = readIntegrityLevel()
  return ownLevelCache
}

let sidCache: string | null = null

function userSid(runner?: ContainmentRunner): { sid: string } | { error: string } {
  if (!runner && sidCache !== null) return { sid: sidCache }
  const r = runVia(runner, sys('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], 10_000)
  const m = /"(S-1-[\d-]+)"/.exec(r.out)
  if (!r.ok || !m) return { error: `the user SID could not be read: ${lastLine(r.out)}` }
  if (!runner) sidCache = m[1]
  return { sid: m[1] }
}

/**
 * Every attached volume that integrity labels cannot protect: a removable or network volume with a
 * file system, or a local volume whose file system is not NTFS. `[]` off Windows. One read-only
 * query; it reads nothing on the volumes themselves. Throws when the listing itself fails, because
 * an unknown answer is never "no such volume".
 */
export function listUnprotectedVolumes(o: { platform?: NodeJS.Platform; run?: ContainmentRunner } = {})
  : Array<{ root: string; fileSystem: string; kind: 'local' | 'removable' | 'network' }> {
  if ((o.platform ?? process.platform) !== 'win32') return []
  const script = 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.DriveType)|$($_.FileSystem)" }'
  const r = runVia(o.run, sys('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], 20_000)
  if (!r.ok) throw new Error(`the attached volumes could not be listed (${lastLine(r.out)})`)
  const out: Array<{ root: string; fileSystem: string; kind: 'local' | 'removable' | 'network' }> = []
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]:)\|(\d+)\|(.*?)\s*$/.exec(line)
    if (!m) continue
    const type = Number(m[2])
    const fs = m[3]
    const root = `${m[1].toUpperCase()}\\`
    if ((type === 2 || type === 4) && fs !== '') out.push({ root, fileSystem: fs, kind: type === 2 ? 'removable' : 'network' })
    else if (type === 3 && fs !== '' && fs.toUpperCase() !== 'NTFS') out.push({ root, fileSystem: fs, kind: 'local' })
  }
  return out
}

/** The ONE read of `LOCALCODE_UNPROTECTED_VOLUMES_OK`: volume roots as `X:\`; anything else as written. */
export function acknowledgedVolumes(env: Record<string, string | undefined> = process.env): string[] {
  const v = env.LOCALCODE_UNPROTECTED_VOLUMES_OK
  if (typeof v !== 'string') return []
  const out: string[] = []
  for (const raw of v.split(';').map(s => s.trim()).filter(s => s !== '')) {
    const m = /^([A-Za-z]):?[\\/]?$/.exec(raw)
    const entry = m ? `${m[1].toUpperCase()}:\\` : raw
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

// ─── Paths ───────────────────────────────────────────────────────────────────────────────────

function real(p: string): string {
  return realPathOf(p, { quiet: true })
}

function samePath(a: string, b: string): boolean {
  const ra = real(a), rb = real(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/** `child` is `parent` or beneath it, on real paths. */
function within(parent: string, child: string): boolean {
  return isInside(real(parent), real(child))
}

function isVolumeRoot(p: string): boolean {
  return dirname(p) === p
}

function volumeOf(p: string): string | null {
  const m = /^([A-Za-z]):/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\` : null
}

function isUnc(p: string): boolean {
  return /^(\\\\|\/\/)/.test(p)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[containment] ${p} could not be read: ${(e as Error).message}`)
    return false
  }
}

function processStartedAt(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Is this record's holder gone? A holder is gone when its pid is not running; a record with no
 * holder is held for 15 minutes after it was created (the starter has handed it to an engine by then).
 */
function holderGone(rec: ContainmentRecord, nowMs: number): boolean {
  if (rec.holder) return !pidAlive(rec.holder.pid)
  return nowMs - Date.parse(rec.createdAt) > HOLDERLESS_GRACE_MS
}

// ─── Records ─────────────────────────────────────────────────────────────────────────────────

const RECORD = 'containment.json'

function readRecord(path: string): { ok: true; rec: ContainmentRecord } | { ok: false; error: string } {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf-8')) as ContainmentRecord
    if (rec === null || typeof rec !== 'object') return { ok: false, error: 'not a JSON object' }
    return { ok: true, rec }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** A temporary file and a rename, so a reader never sees half a record. Null, or why it failed. */
function writeRecord(path: string, rec: ContainmentRecord): string | null {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
    return null
  } catch (e) {
    console.log(`[containment] the record ${path} could not be written: ${(e as Error).message}`)
    return (e as Error).message
  }
}

function markReleased(path: string, rec: ContainmentRecord, by: NonNullable<ContainmentRecord['releasedBy']>, now: Date): string | null {
  rec.releasedAt = now.toISOString()
  rec.releasedBy = by
  return writeRecord(path, rec)
}

function namedFolders(rec: ContainmentRecord): string[] {
  return [rec.missionCwd, ...(rec.extraRoots ?? [])]
}

function labelledFolders(rec: ContainmentRecord): string[] {
  return rec.cwdLabel === 'low' ? namedFolders(rec) : []
}

/**
 * Every parseable record of a direct child of the root whose folder name is a run id and equals
 * the record's own run id, oldest first. A link is never followed. An unreadable root gives [].
 */
export function containmentRecords(o: { sandboxRoot?: string } = {}): ContainmentRecord[] {
  const root = o.sandboxRoot ?? sandboxRoot()
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.log(`[containment] the sandbox root ${root} could not be listed: ${(e as Error).message}`)
    return []
  }
  const out: ContainmentRecord[] = []
  for (const name of names) {
    if (!RUN_ID_RE.test(name)) continue
    const dir = join(root, name)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch (e) {
      console.log(`[containment] ${dir} could not be read: ${(e as Error).message}`)
      continue
    }
    const r = readRecord(join(dir, RECORD))
    if (!r.ok) continue
    if (r.rec.schema !== 1 || r.rec.runId !== name) continue
    out.push(r.rec)
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/** Another record (not `exceptId`) that labels `folder`, is not released and whose holder is not gone. */
function activeHolderOf(root: string, folder: string, exceptId: string, nowMs: number): ContainmentRecord | null {
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    if (rec.runId === exceptId || rec.releasedAt) continue
    if (!labelledFolders(rec).some(f => samePath(f, folder))) continue
    if (!holderGone(rec, nowMs)) return rec
  }
  return null
}

function sandboxOf(runDir: string): RunContainment['sandbox'] {
  return { root: runDir, home: join(runDir, 'home'), tmp: join(runDir, 'tmp'), scratch: join(runDir, 'scratch') }
}

function contextOf(rec: ContainmentRecord, runDir: string, isolation: 'verified' | 'overlay'): RunContainment {
  return frozen({
    runId: rec.runId, kind: rec.kind, test: rec.test === true,
    missionCwd: rec.missionCwd, cwdLabel: rec.cwdLabel, extraRoots: [...(rec.extraRoots ?? [])],
    sandbox: sandboxOf(runDir), home: rec.home, folders: { ...rec.folders },
    unprotectedVolumes: [...(rec.unprotectedVolumes ?? [])], isolation,
  })
}

/**
 * The context a run folder's record describes, with no probe and no holder written: what
 * `adoptContainment` builds on, and what the launcher reads before it lowers its token.
 */
export function containmentFromRecord(runDir: string)
  : { ok: true; containment: RunContainment; record: ContainmentRecord } | { ok: false; reason: string; unread?: string } {
  const path = join(runDir, RECORD)
  const r = readRecord(path)
  if (!r.ok) return { ok: false, reason: `the containment record ${path} could not be read (${r.error})`, unread: r.error }
  if (r.rec.schema !== 1) return { ok: false, reason: `the containment record ${path} is not a version this engine reads (schema ${String(r.rec.schema)})` }
  return { ok: true, containment: contextOf(r.rec, runDir, 'overlay'), record: r.rec }
}

// ─── Labels ──────────────────────────────────────────────────────────────────────────────────

function setLabel(runner: ContainmentRunner | undefined, dir: string, level: 'L' | 'M') {
  return runVia(runner, sys('icacls.exe'), [dir, '/setintegritylevel', `(OI)(CI)${level}`], 30_000)
}

function grantFull(runner: ContainmentRunner | undefined, dir: string, sid: string) {
  return runVia(runner, sys('icacls.exe'), [dir, '/grant', `*${sid}:(OI)(CI)F`], 30_000)
}

/** The probe's own file names: `probe-<pid>.tmp` in the sandbox, the dotted form in a folder the run works in. */
const SANDBOX_PROBE_FILE = /^probe-\d+\.tmp$/
const WORK_FOLDER_PROBE_FILE = /^\.cynco-containment-probe-\d+\.tmp$/

/** Remove the probe's own leftovers at the top of `dir`: only names matching `pattern`, nothing else. */
function removeProbeLeftovers(dir: string, pattern: RegExp): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    console.log(`[containment] ${dir} could not be listed for probe leftovers: ${(e as Error).message}`)
    return
  }
  for (const n of names) {
    if (!pattern.test(n)) continue
    try {
      unlinkSync(join(dir, n))
    } catch (e) {
      console.log(`[containment] the probe leftover ${join(dir, n)} could not be removed: ${(e as Error).message}`)
    }
  }
}

/**
 * The probe (Windows): the launcher lowers itself and tries one create that must fail (the run
 * folder, medium) and one per folder that must succeed (the sandbox tmp and each labelled folder).
 * Null when it passed; otherwise the reason.
 */
function probe(runner: ContainmentRunner | undefined, runDir: string, labelled: Array<{ path: string; word: string }>): string | null {
  const sb = sandboxOf(runDir)
  const mustFail = join(runDir, `probe-${process.pid}.tmp`)
  const mustSucceed = [join(sb.tmp, `probe-${process.pid}.tmp`), ...labelled.map(f => join(f.path, `.cynco-containment-probe-${process.pid}.tmp`))]
  // The sandbox tmp folder and the run folder hold `probe-<pid>.tmp`; a folder the run works in
  // only ever the dotted name, so a `probe-1.tmp` of the owner's in the repository is never touched.
  const tops: Array<[string, RegExp]> = [[sb.tmp, SANDBOX_PROBE_FILE], [runDir, SANDBOX_PROBE_FILE], ...labelled.map(f => [f.path, WORK_FOLDER_PROBE_FILE] as [string, RegExp])]
  for (const [d, pattern] of tops) removeProbeLeftovers(d, pattern)
  const r = runVia(runner, process.execPath, [...launcherHead(), '--run-dir', runDir, '--probe', mustFail, ...mustSucceed], 20_000)
  for (const [d, pattern] of tops) removeProbeLeftovers(d, pattern)
  const refused = r.out.split(/\r?\n/).find(l => l.startsWith('[containment] refused: '))
  let answer: { outside?: string; inside?: string[] } | null = null
  for (const line of r.out.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      answer = JSON.parse(t) as { outside?: string; inside?: string[] }
      break
    } catch (e) {
      console.log(`[containment] the probe printed a line that is not JSON (${(e as Error).message})`)
    }
  }
  if (r.code === LAUNCHER_REFUSED_EXIT || answer === null) {
    const own = refused ? refused.slice('[containment] refused: '.length).trim() : 'the probe printed nothing'
    return own.startsWith('the low-integrity launcher is unavailable') ? own : LAUNCHER_UNAVAILABLE(own)
  }
  if (answer.outside === 'created') return `the sandbox root ${dirname(runDir)} gives no protection: a low-integrity process created a file in ${runDir}`
  // Only a denial proves the boundary; EEXIST, ENOENT or no answer measured nothing.
  if (answer.outside !== 'EPERM' && answer.outside !== 'EACCES') return `the probe could not show that ${runDir} is closed to a low-integrity process (its create there answered ${answer.outside ?? 'nothing'}, not a denial)`
  const inside = answer.inside ?? []
  if (inside[0] !== 'created') return `the sandbox ${sb.tmp} is not writable at low integrity (${inside[0] ?? 'no answer'})`
  for (let i = 0; i < labelled.length; i++) {
    const code = inside[i + 1]
    if (code !== 'created') return `${labelled[i].word} ${labelled[i].path} is not writable at low integrity (${code ?? 'no answer'}); its label was not set or has been removed`
  }
  return null
}

// ─── establishContainment ────────────────────────────────────────────────────────────────────

function defaultFolders(): RunContainment['folders'] {
  return { state: cyncoHome(), models: modelsDir(), guard: 'C:/cynco-guard', audit: auditDir() }
}

/** Rules M1 to M9 for one folder; null when it may be a write root of the run. */
function folderRefusal(input: string, word: string, o: {
  kind: ContainmentKind; checkout: string; home: string; folders: RunContainment['folders']; sandboxRoot: string
  unprotected: string[]; checkGit: boolean; checkHardLinks: boolean
}): string | null {
  if (!isDir(input)) return `${word} ${input} does not exist or is not a folder`
  const p = real(input)
  if (within(o.checkout, p) || within(p, o.checkout)) return `${word} ${p} is, contains or is inside the checkout this engine runs from (${o.checkout})`
  if (within(p, o.home)) return `${word} ${p} is the home folder ${o.home} or contains it`
  if (isVolumeRoot(p)) return `${word} ${p} is a volume root`
  const vol = volumeOf(p)
  if (isUnc(input) || isUnc(p) || (vol !== null && o.unprotected.includes(vol))) return `${word} ${p} is on a network share or on a volume without integrity labels`
  const authoring = join(o.folders.state, 'authoring')
  const inAuthoring = within(authoring, p) && !samePath(authoring, p)
  const protectedList: Array<[string | null, string]> = [
    [o.folders.guard, 'the guard folder'], [o.folders.audit, 'the audit folder'], [o.folders.models, 'the models folder'],
    [o.sandboxRoot, 'the sandbox root'], [o.folders.state, "CynCo's state folder"],
  ]
  for (const [path, name] of protectedList) {
    if (path === null || !isAbsolute(path)) continue
    if (name === "CynCo's state folder" && inAuthoring) continue
    if (within(path, p) || within(p, path)) return `${word} ${p} is, contains or is inside ${path} (${name})`
  }
  const realHome = real(o.home)
  if (isInside(realHome, p) && !inAuthoring) {
    const first = relative(realHome, p).split(/[\\/]/)[0]
    if (first.startsWith('.')) return `${word} ${p} is inside ${join(o.home, first)}, a dot-folder of the home folder`
  }
  const linkOut = linkLeadingOut(p)
  if (linkOut) return `${word} ${p} holds a link that leads outside it (${linkOut.link} -> ${linkOut.target})`
  if (o.checkGit) {
    const git = join(p, '.git')
    let why: string | null = null
    try {
      const st = lstatSync(git)
      if (!st.isDirectory()) why = '.git is a file: a worktree or a submodule'
      else if (!existsSync(join(git, 'HEAD'))) why = '.git holds no HEAD'
    } catch (e) {
      why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? '.git is missing' : `.git could not be read: ${(e as Error).message}`
    }
    if (why) return `${word} ${p} is not the top of its own git repository (${why}); a mission works in a clone made with git clone --no-hardlinks, not in a worktree or a subfolder`
  }
  if (o.checkHardLinks) {
    const hard = fileWithOtherNames(p)
    if (hard) return `${word} ${p} ${hard}; a low label set on such a file reaches every other name of it, so the folder is not labelled: work in a clone made with git clone --no-hardlinks`
  }
  return null
}

/**
 * Why `dir` may not be labelled because of a hard link: the first regular file under it with more
 * than one name, or a folder under it that could not be read (so the answer is unknown). Null when
 * the whole tree was read and no file has a second name. Walks every level, never entering a link.
 */
function fileWithOtherNames(dir: string): string | null {
  const pending = [dir]
  while (pending.length > 0) {
    const d = pending.pop()!
    let names: string[]
    try {
      names = readdirSync(d)
    } catch (e) {
      return `holds a folder that could not be read for hard links (${d}: ${(e as Error).message})`
    }
    for (const n of names) {
      const p = join(d, n)
      let st
      try {
        st = lstatSync(p)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        return `holds an entry that could not be read for hard links (${p}: ${(e as Error).message})`
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) pending.push(p)
      else if (st.isFile() && st.nlink > 1) return `holds a file with more than one name (${p} has ${st.nlink})`
    }
  }
  return null
}

/** A symbolic link or junction in the top two levels of `dir` whose target is outside it. */
function linkLeadingOut(dir: string): { link: string; target: string } | null {
  const scan = (d: string, depth: number): { link: string; target: string } | null => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch (e) {
      console.log(`[containment] ${d} could not be listed: ${(e as Error).message}`)
      return null
    }
    for (const n of names) {
      const p = join(d, n)
      let st
      try {
        st = lstatSync(p)
      } catch (e) {
        console.log(`[containment] ${p} could not be read: ${(e as Error).message}`)
        continue
      }
      if (st.isSymbolicLink()) {
        const target = real(p)
        if (!isInside(dir, target)) return { link: p, target }
      } else if (st.isDirectory() && depth < 2) {
        const hit = scan(p, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  return scan(dir, 1)
}

/**
 * Create the sandbox of one run, write its record, label it and the folders it works in, and
 * probe the result. Never throws, and never creates the sandbox ROOT: a root that does not exist
 * is a refusal. The refusals and their texts are `01-isolation.md` section 8.2.
 */
export function establishContainment(a: {
  kind: ContainmentKind; label?: string; runId?: string
  missionCwd: string; labelCwd?: boolean
  extraRoots?: string[]
  test?: boolean
  sandboxRoot?: string; home?: string
  folders?: Partial<RunContainment['folders']>
  probe?: boolean; platform?: NodeJS.Platform
  run?: ContainmentRunner
  now?: () => Date
}): { ok: true; containment: RunContainment; ms: number } | { ok: false; reason: string } {
  const t0 = Date.now()
  const now = a.now ?? (() => new Date())
  const test = a.test === true
  const platform = a.platform ?? process.platform
  const win = platform === 'win32'
  const sw = containmentSwitch()
  // E1, E2: the switch.
  if (!test && sw.raw !== null) return { ok: false, reason: SWITCH_IN_UNATTENDED }
  if (test && sw.unknown.length > 0) return { ok: false, reason: unknownLayerReason(sw.unknown[0]) }
  // E3: a low process never establishes a second containment.
  const level = !win ? 'medium' : a.run ? readIntegrityLevel(a.run) : ownIntegrityLevel()
  if (level === 'low') return { ok: false, reason: 'this process is already running at low integrity, and a contained run does not establish a second containment' }
  // E4: exactly one of a label and a well-formed run id.
  const hasLabel = typeof a.label === 'string', hasId = typeof a.runId === 'string'
  if (hasLabel === hasId || (hasId && !RUN_ID_RE.test(a.runId!))) {
    return { ok: false, reason: `establishContainment needs exactly one of a label and a well-formed run id (got ${hasLabel && hasId ? `label ${a.label} and run id ${a.runId}` : hasId ? `run id ${a.runId}` : 'neither'})` }
  }
  const checkout = engineCheckout()
  // E5: no cwd.
  if (typeof a.missionCwd !== 'string' || a.missionCwd.trim() === '') {
    return { ok: false, reason: `this task names no cwd, so it would work in the engine's own checkout ${checkout}; give the mission a cwd` }
  }
  // E6: asked before anything is created, so a refusal under vitest's Node touches no folder.
  const lowilOff = switchedOff('lowil', test)
  if (win && !lowilOff) {
    const why = launcherUnavailable(runningUnderBun())
    if (why) return { ok: false, reason: why }
  }
  // S1, S2: the sandbox root.
  const rootIn = a.sandboxRoot ?? sandboxRoot()
  const home = a.home ?? homedir()
  if (!isAbsolute(rootIn) || !isDir(rootIn)) {
    return { ok: false, reason: `the sandbox root ${rootIn} is not an absolute path to an existing folder; create it once with scripts/cynco-containment-setup.ps1 or name another folder in LOCALCODE_SANDBOX_ROOT` }
  }
  const root = real(rootIn)
  if (isVolumeRoot(root) || within(root, home)) return { ok: false, reason: `the sandbox root ${root} is a drive root, or is or contains the home folder ${home}` }
  // V1, V2, V3: volumes integrity labels cannot protect.
  let volumes: Array<{ root: string; fileSystem: string }>
  try {
    volumes = listUnprotectedVolumes({ platform, run: a.run })
  } catch (e) {
    const msg = (e as Error).message
    const inner = /^the attached volumes could not be listed \((.*)\)$/.exec(msg)?.[1] ?? msg
    return { ok: false, reason: `the attached volumes could not be listed (${inner}), so it is not known whether one of them is unprotected` }
  }
  const acked = acknowledgedVolumes()
  for (const v of volumes) {
    if (!acked.includes(v.root)) return { ok: false, reason: `${v.root} (${v.fileSystem}) cannot be protected by integrity labels and is not acknowledged` }
  }
  for (const entry of acked) {
    if (!volumes.some(v => v.root === entry)) return { ok: false, reason: `the entry ${entry} of LOCALCODE_UNPROTECTED_VOLUMES_OK is not the root of an attached volume that integrity labels cannot protect` }
  }
  const unprotected = volumes.map(v => v.root)
  // S3: the sandbox root itself on such a volume.
  const rootVol = volumeOf(root)
  if (rootVol !== null && unprotected.includes(rootVol)) return { ok: false, reason: `the sandbox root ${root} is on ${rootVol}, a volume without integrity labels` }
  // H1: a home folder that is itself labelled low is protected by nothing.
  if (win) {
    const r = runVia(a.run, sys('icacls.exe'), [home], 10_000)
    if (!r.ok) return { ok: false, reason: `the integrity label of the home folder ${home} could not be read (${lastLine(r.out)})` }
    if (/Mandatory Label\\Low Mandatory Level/i.test(r.out)) return { ok: false, reason: `the home folder ${home} is itself labelled low integrity, so low integrity protects nothing in it` }
  }
  // M1 to M9: the mission folder and each extra root.
  const folders: RunContainment['folders'] = { ...defaultFolders(), ...(a.folders ?? {}) }
  const labelCwd = a.labelCwd !== false && win
  const common = { kind: a.kind, checkout, home, folders, sandboxRoot: root, unprotected, checkHardLinks: labelCwd }
  const missionWhy = folderRefusal(a.missionCwd, 'the mission folder', { ...common, checkGit: a.kind === 'mission' })
  if (missionWhy) return { ok: false, reason: missionWhy }
  for (const extra of a.extraRoots ?? []) {
    const why = folderRefusal(extra, 'the extra folder', { ...common, checkGit: false })
    if (why) return { ok: false, reason: why }
  }
  const missionCwd = real(a.missionCwd)
  const extraRoots = (a.extraRoots ?? []).map(real)
  const runId = hasId ? a.runId! : mintRunId(a.label!, now())
  const runDir = join(root, runId)
  const workFolders = [{ path: missionCwd, word: 'the mission folder' }, ...extraRoots.map(p => ({ path: p, word: 'the extra folder' }))]

  // Step 1: a record that names one of these folders and whose holder is gone is released now,
  // its labels set back as a release sets them (so a dead run's label is not mistaken below for
  // one a release failed to remove).
  const nowMs = now().getTime()
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    if (rec.releasedAt || !holderGone(rec, nowMs)) continue
    if (!namedFolders(rec).some(f => workFolders.some(w => samePath(f, w.path)))) continue
    releaseRecord(rec, join(root, rec.runId), 'holder-gone', { platform, run: a.run, now })
  }
  // Step 1b: a folder that still reads low with no live run holding it is one an earlier release
  // could not set back (the run may have changed its permissions). It is refused, loudly, before
  // anything is created: labelling it again would hide that.
  if (labelCwd) {
    for (const f of workFolders) {
      if (activeHolderOf(root, f.path, '', now().getTime())) continue
      const r = runVia(a.run, sys('icacls.exe'), [f.path], 10_000)
      if (!r.ok) return { ok: false, reason: `the integrity label of ${f.word} ${f.path} could not be read (${lastLine(r.out)})` }
      if (/Mandatory Label\\Low Mandatory Level/i.test(r.out)) {
        return { ok: false, reason: `${f.word} ${f.path} is already labelled low integrity and no live run holds it (an earlier run's release did not set it back, or it sits in a folder labelled low). Look at what changed in it, then set it back with icacls "${f.path}" /setintegritylevel (OI)(CI)M` }
      }
    }
  }
  // Step 2: the run folder (never recursive: an existing one is a refusal) and its five subfolders.
  const sb = sandboxOf(runDir)
  try {
    mkdirSync(runDir)
    for (const d of [sb.home, join(sb.home, 'AppData', 'Roaming'), join(sb.home, 'AppData', 'Local'), sb.tmp, sb.scratch]) mkdirSync(d, { recursive: true })
  } catch (e) {
    return { ok: false, reason: `the sandbox ${runDir} could not be created (${(e as Error).message})` }
  }
  // Step 3: the record, BEFORE any label (rule R1).
  const recPath = join(runDir, RECORD)
  const rec: ContainmentRecord = {
    schema: 1, runId, kind: a.kind, test,
    missionCwd, cwdLabel: labelCwd ? 'low' : 'none', cwdGranted: false,
    extraRoots, home, folders, unprotectedVolumes: unprotected,
    createdAt: now().toISOString(), createdByPid: process.pid,
    holder: a.kind === 'precheck' || a.kind === 'grader' ? { pid: process.pid, startedAt: processStartedAt() } : null,
    releasedAt: null,
  }
  try {
    writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' })
  } catch (e) {
    return { ok: false, reason: `the sandbox ${runDir} could not be created (${(e as Error).message})` }
  }
  const labelled: string[] = []
  const fail = (reason: string): { ok: false; reason: string } => {
    for (const f of labelled) {
      const other = activeHolderOf(root, f, runId, now().getTime())
      if (other) continue
      const r = setLabel(a.run, f, 'M')
      if (!r.ok) console.log(`[containment] ${f} could not be set back to medium integrity after a failed establish (${lastLine(r.out)})`)
    }
    markReleased(recPath, rec, 'failed-establish', now())
    return { ok: false, reason }
  }
  // Step 4: the sandbox's own labels. The run folder itself stays medium, so the run cannot change its record.
  let sid: string | null = null
  if (win) {
    const s = userSid(a.run)
    if ('error' in s) return fail(`the sandbox ${runDir} could not be labelled low integrity (${s.error})`)
    sid = s.sid
    const g = grantFull(a.run, runDir, sid)
    if (!g.ok) return fail(`the sandbox ${runDir} could not be labelled low integrity (${lastLine(g.out)})`)
    for (const d of [sb.home, sb.tmp, sb.scratch]) {
      const r = setLabel(a.run, d, 'L')
      if (!r.ok) return fail(`the sandbox ${d} could not be labelled low integrity (${lastLine(r.out)})`)
    }
  } else {
    try {
      chmodSync(runDir, 0o700)
    } catch (e) {
      return fail(`the sandbox ${runDir} could not be created (${(e as Error).message})`)
    }
  }
  // Step 5: git identity through an include of the owner's file, which the run cannot write.
  const ownerGitconfig = join(home, '.gitconfig')
  const seeded = existsSync(ownerGitconfig)
    ? `[include]\n\tpath = ${ownerGitconfig.replace(/\\/g, '/')}\n`
    : '# No .gitconfig in the home folder to include; this run has its own git identity only if it sets one.\n'
  try {
    writeFileSync(join(sb.home, '.gitconfig'), seeded, 'utf-8')
  } catch (e) {
    return fail(`the sandbox ${runDir} could not be created (${(e as Error).message})`)
  }
  // Step 6: the folders the run works in.
  if (labelCwd && sid !== null) {
    for (const f of workFolders) {
      let r = setLabel(a.run, f.path, 'L')
      if (!r.ok) {
        const g = grantFull(a.run, f.path, sid)
        if (g.ok) {
          rec.cwdGranted = true
          writeRecord(recPath, rec)
          r = setLabel(a.run, f.path, 'L')
        } else {
          r = g
        }
      }
      if (!r.ok) return fail(`${f.word} ${f.path} could not be labelled low integrity (${lastLine(r.out)})`)
      labelled.push(f.path)
    }
  }
  // Step 7: the probe, measured by this process.
  let isolation: 'verified' | 'overlay' = 'overlay'
  if (win && a.probe !== false && !lowilOff) {
    const why = probe(a.run, runDir, labelCwd ? workFolders : [])
    if (why) return fail(why)
    isolation = 'verified'
  }
  return { ok: true, containment: contextOf(rec, runDir, isolation), ms: Date.now() - t0 }
}

// ─── adoptContainment ────────────────────────────────────────────────────────────────────────

/**
 * Verify the sandbox a starter created for this run and hold it. Never creates; never throws. The
 * context is built from the RECORD, never from this process's environment. Does not set module
 * state: the caller calls `setRunContainment`.
 */
export function adoptContainment(a: {
  runId: string | null; missionCwd: string; who: 'engine' | 'one-shot' | 'driver'
  sandboxRoot?: string; probe?: boolean; platform?: NodeJS.Platform
}): { ok: true; containment: RunContainment; probeMs: number } | { ok: false; reason: string } {
  const platform = a.platform ?? process.platform
  if (containmentSwitch().raw !== null) return { ok: false, reason: SWITCH_IN_UNATTENDED }
  const runId = typeof a.runId === 'string' && RUN_ID_RE.test(a.runId) ? a.runId : null
  if (runId === null) {
    if (a.who === 'engine') return { ok: false, reason: 'no run id was handed to this engine (LOCALCODE_MISSION_RUN_ID is unset or malformed); a mission is started with scripts/dispatch-mission.sh, which creates the sandbox' }
    if (a.who === 'one-shot') return { ok: false, reason: 'the task file names no sandbox (runId); a one-shot is started by the daemon or the campaign runner, which create it' }
    return { ok: false, reason: 'the driver was handed no run id (LOCALCODE_MISSION_RUN_ID is unset or malformed); it is started by scripts/dispatch-mission.sh' }
  }
  if (typeof a.missionCwd !== 'string' || a.missionCwd.trim() === '') return { ok: false, reason: 'this run was not told its mission folder' }
  const runDir = join(a.sandboxRoot ?? sandboxRoot(), runId)
  const path = join(runDir, RECORD)
  // The read and the schema check are the launcher's own (containmentFromRecord); A8 to A12 follow.
  const read = containmentFromRecord(runDir)
  if (!read.ok) return { ok: false, reason: read.unread !== undefined ? `no containment record at ${path} (${read.unread})` : read.reason }
  const rec = read.record
  if (rec.test === true) return { ok: false, reason: 'this containment record was made by a test and cannot serve a run' }
  if (rec.releasedAt) return { ok: false, reason: `the containment record ${path} was released at ${rec.releasedAt}` }
  const wanted: ContainmentKind = a.who === 'one-shot' ? 'daemon-task' : 'mission'
  if (rec.kind !== wanted) {
    return { ok: false, reason: `the containment record ${path} is for a ${String(rec.kind)} run; ${a.who === 'one-shot' ? 'a one-shot adopts only a daemon-task' : `the ${a.who} adopts only a mission`} record` }
  }
  if (typeof rec.missionCwd !== 'string' || !samePath(rec.missionCwd, a.missionCwd)) {
    return { ok: false, reason: `the containment record ${path} is for ${String(rec.missionCwd)}, not for this run's folder ${real(a.missionCwd)}` }
  }
  const sb = sandboxOf(runDir)
  for (const d of [sb.home, sb.tmp, sb.scratch]) if (!isDir(d)) return { ok: false, reason: `the sandbox folder ${d} is missing` }
  const holds = a.who === 'engine' || a.who === 'one-shot'
  if (holds && rec.holder && rec.holder.pid !== process.pid && pidAlive(rec.holder.pid)) {
    return { ok: false, reason: `the containment record ${path} is already held by pid ${rec.holder.pid}` }
  }
  const win = platform === 'win32'
  if (win) {
    const why = launcherUnavailable(runningUnderBun())
    if (why) return { ok: false, reason: why }
  }
  let isolation: 'verified' | 'overlay' = 'overlay'
  let probeMs = 0
  if (win && a.probe !== false) {
    const t0 = Date.now()
    const labelled = rec.cwdLabel === 'low'
      ? [{ path: rec.missionCwd, word: 'the mission folder' }, ...(rec.extraRoots ?? []).map(p => ({ path: p, word: 'the extra folder' }))]
      : []
    const why = probe(undefined, runDir, labelled)
    probeMs = Date.now() - t0
    if (why) return { ok: false, reason: why }
    isolation = 'verified'
  }
  if (holds && rec.holder?.pid !== process.pid) {
    rec.holder = { pid: process.pid, startedAt: processStartedAt() }
    const err = writeRecord(path, rec)
    if (err !== null) return { ok: false, reason: `the containment record ${path} could not be written (${err})` }
  }
  return { ok: true, containment: contextOf(rec, runDir, isolation), probeMs }
}

// ─── releaseContainment ──────────────────────────────────────────────────────────────────────

/**
 * Mark a run released and set the folders it labelled back to medium integrity, unless another
 * live run still holds one. Never throws, idempotent; the note says what it did and did not do,
 * and is logged whenever a folder that was due was not set back. Never deletes the sandbox.
 */
export function releaseContainment(c: RunContainment | string, o: {
  sandboxRoot?: string; platform?: NodeJS.Platform; run?: ContainmentRunner
} = {}): { relabelled: boolean; note: string } {
  const runId = typeof c === 'string' ? c : c.runId
  const runDir = typeof c === 'string' ? join(o.sandboxRoot ?? sandboxRoot(), c) : c.sandbox.root
  if (!RUN_ID_RE.test(runId)) return { relabelled: false, note: `no containment record for ${runId}` }
  const path = join(runDir, RECORD)
  const r = readRecord(path)
  if (!r.ok) return { relabelled: false, note: `no containment record for ${runId}` }
  if (r.rec.releasedAt) return { relabelled: true, note: `run ${runId} was already released at ${r.rec.releasedAt}` }
  return releaseRecord(r.rec, runDir, 'release', { platform: o.platform, run: o.run })
}

function releaseRecord(rec: ContainmentRecord, runDir: string, by: NonNullable<ContainmentRecord['releasedBy']>,
  o: { platform?: NodeJS.Platform; run?: ContainmentRunner; now?: () => Date }): { relabelled: boolean; note: string } {
  const now = o.now ?? (() => new Date())
  const root = dirname(runDir)
  const path = join(runDir, RECORD)
  const lines: string[] = []
  let allDone = true
  const markErr = markReleased(path, rec, by, now())
  if (markErr !== null) {
    allDone = false
    lines.push(`the record could not be marked released (${markErr})`)
  }
  const due = labelledFolders(rec)
  if ((o.platform ?? process.platform) !== 'win32' || due.length === 0) {
    lines.unshift(`run ${rec.runId} released${due.length ? ' (no integrity labels on this system)' : ''}`)
    return { relabelled: allDone, note: lines.join('; ') }
  }
  for (const f of due) {
    const holder = activeHolderOf(root, f, rec.runId, now().getTime())
    if (holder) {
      lines.push(`${f} stays labelled low: run ${holder.runId} still holds it`)
      continue
    }
    if (!isDir(f)) {
      allDone = false
      lines.push(`${f} is missing, so its label was not set back`)
      continue
    }
    const res = setLabel(o.run, f, 'M')
    if (!res.ok) {
      allDone = false
      lines.push(`${f} could not be set back to medium integrity (${lastLine(res.out)})`)
      continue
    }
    // Rule R1: a run that became active during the relabel keeps its label.
    const relabelForLateRun = (): boolean => {
      const late = activeHolderOf(root, f, rec.runId, now().getTime())
      if (!late) return false
      const again = setLabel(o.run, f, 'L')
      lines.push(again.ok
        ? `${f} was labelled low again: run ${late.runId} became active during the release`
        : `${f} could not be labelled low again for run ${late.runId}, which became active during the release (${lastLine(again.out)})`)
      return true
    }
    if (relabelForLateRun()) continue
    // Rule R4: a label the run set itself on something under the folder (measured: it survives the
    // root relabel) is found and set back, one listing per folder, never entering a link.
    const walk = resetLowResidue(o.run, f)
    if (walk.failed.length > 0) {
      allDone = false
      lines.push(`${f}: ${walk.failed.length} entr${walk.failed.length === 1 ? 'y' : 'ies'} under it may still be labelled low (${walk.failed.slice(0, 3).join('; ')}${walk.failed.length > 3 ? '; ...' : ''})`)
    }
    if (relabelForLateRun()) continue
    lines.push(`${f} set back to medium integrity (${walk.dirs} folder${walk.dirs === 1 ? '' : 's'} read for labels set under it${walk.reset.length ? `; ${walk.reset.length} set back: ${walk.reset.slice(0, 3).join(', ')}${walk.reset.length > 3 ? ', ...' : ''}` : ''})`)
  }
  const note = [`run ${rec.runId} released`, ...lines].join('; ')
  if (!allDone) console.log(`[containment] ${note}`)
  return { relabelled: allDone, note }
}

type LowState = 'explicit' | 'inherited' | 'none'

/** Is there an entry at `p` (a link counts as itself, its target is not asked)? */
function presentNoFollow(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** The low label of one icacls block: set on the entry itself, inherited (`(I)`), or none. */
function lowStateOf(block: string): LowState {
  const m = /Mandatory Label\\Low Mandatory Level:(\S*)/i.exec(block)
  if (!m) return 'none'
  return m[1].includes('(I)') ? 'inherited' : 'explicit'
}

/**
 * Read `icacls "<dir>\*" /L` output: each entry's block starts at column 0 with its full path,
 * and its ACE lines follow, indented. Only the paths in `entries` are recognised (a name with a
 * space cannot be told from the first ACE otherwise); keys are folded on Windows.
 */
function lowStatesOfListing(out: string, entries: string[]): Map<string, LowState> {
  const fold = (p: string) => p.toLowerCase()
  const known = [...entries].sort((a, b) => b.length - a.length)
  const blocks = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line !== '' && !/^\s/.test(line)) {
      const hit = known.find(p => fold(line) === fold(p) || fold(line).startsWith(`${fold(p)} `))
      current = hit === undefined ? null : []
      if (hit !== undefined) {
        blocks.set(fold(hit), current!)
        current!.push(line.slice(hit.length))
      }
      continue
    }
    current?.push(line)
  }
  const states = new Map<string, LowState>()
  for (const [k, lines] of blocks) states.set(k, lowStateOf(lines.join('\n')))
  return states
}

/**
 * Rule R4 of the release: walk `top` without ever entering a link, list each folder's entries
 * with ONE `icacls "<dir>\*" /L`, and set back every entry that carries a low label of its own
 * (not inherited): `(OI)(CI)M` on a folder, `M` on anything else, always with `/L` so a link's own
 * label is what changes. An entry the listing does not show is asked on its own. Never `/T`.
 */
function resetLowResidue(runner: ContainmentRunner | undefined, top: string): { dirs: number; reset: string[]; failed: string[] } {
  const out = { dirs: 0, reset: [] as string[], failed: [] as string[] }
  const icacls = sys('icacls.exe')
  const pending = [top]
  while (pending.length > 0) {
    const d = pending.pop()!
    let names: string[]
    try {
      names = readdirSync(d)
    } catch (e) {
      out.failed.push(`${d} could not be listed (${(e as Error).message})`)
      continue
    }
    if (names.length === 0) continue
    out.dirs++
    const entries: Array<{ path: string; kind: 'dir' | 'link' | 'file' }> = []
    for (const n of names) {
      const p = join(d, n)
      try {
        const st = lstatSync(p)
        entries.push({ path: p, kind: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file' })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.failed.push(`${p} could not be read (${(e as Error).message})`)
      }
    }
    const listing = runVia(runner, icacls, [join(d, '*'), '/L'], 60_000)
    const states = lowStatesOfListing(listing.out, entries.map(e => e.path))
    for (const e of entries) {
      let state = states.get(e.path.toLowerCase())
      if (state === undefined) {
        const one = runVia(runner, icacls, [e.path, '/L'], 10_000)
        if (!one.ok) {
          if (presentNoFollow(e.path)) out.failed.push(`the label of ${e.path} could not be read (${lastLine(one.out)})`)
          continue
        }
        state = lowStateOf(one.out)
      }
      if (state === 'explicit') {
        const r = runVia(runner, icacls, [e.path, '/L', '/setintegritylevel', e.kind === 'dir' ? '(OI)(CI)M' : 'M'], 30_000)
        if (r.ok) out.reset.push(e.path)
        else out.failed.push(`${e.path} could not be set back (${lastLine(r.out)})`)
      }
      if (e.kind === 'dir') pending.push(e.path)
    }
  }
  return out
}

// ─── sweepSandboxes ──────────────────────────────────────────────────────────────────────────

/**
 * Remove a tree without ever following a link: a symbolic link or junction is removed as an entry
 * and never entered. The one walk in this change that deletes; only `sweepSandboxes` calls it.
 * Each folder is read with lstat before and after it is listed, and compared with what its parent
 * saw: a folder swapped for a link (by a low process still alive outside the job) between two
 * reads stops the walk there, with nothing entered. A swap inside the remaining window, between
 * that check and the removal of one entry, is not excluded by a path-based walk.
 */
function removeTreeNoFollow(dir: string, log: (line: string) => void, seen?: BigIntStats): void {
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  const changed = (why: string) => new Error(`${dir} ${why}; the sweep stops there and enters nothing`)
  const before = lstatSync(dir, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory()) throw changed('is no longer a folder')
  if (seen && !same(before, seen)) throw changed('was replaced after it was read')
  const names = readdirSync(dir)
  const after = lstatSync(dir, { bigint: true })
  if (after.isSymbolicLink() || !same(before, after)) throw changed('was replaced while it was listed')
  for (const name of names) {
    const p = join(dir, name)
    const st = lstatSync(p, { bigint: true })
    if (st.isSymbolicLink()) {
      try {
        rmdirSync(p)
      } catch (e) {
        log(`[containment] ${p} is not a folder link (${(e as NodeJS.ErrnoException).code}); removing it as a file link`)
        unlinkSync(p)
      }
    } else if (st.isDirectory()) {
      removeTreeNoFollow(p, log, st)
      rmdirSync(p)
    } else {
      unlinkSync(p)
    }
  }
}

/**
 * Release the records whose holder is gone and remove the run folders older than `keepDays` whose
 * holder is not alive. Only a direct child of the root whose name is a run id and whose own record
 * names that id is ever touched; links are removed as entries and never entered. Refuses, removing
 * nothing, when the root is a drive root or is or contains the home folder.
 */
export function sweepSandboxes(o: {
  sandboxRoot?: string; now?: () => Date; keepDays?: number; log?: (line: string) => void
  home?: string; platform?: NodeJS.Platform; run?: ContainmentRunner
} = {}): { removed: string[]; kept: number } {
  const log = o.log ?? ((line: string) => console.log(line))
  const now = o.now ?? (() => new Date())
  const rootIn = o.sandboxRoot ?? sandboxRoot()
  const home = o.home ?? homedir()
  if (!isAbsolute(rootIn) || !isDir(rootIn)) return { removed: [], kept: 0 }
  const root = real(rootIn)
  if (isVolumeRoot(root) || within(root, home)) {
    log(`[containment] the sweep refused: the sandbox root ${root} is a drive root, or is or contains the home folder ${home}; nothing was removed`)
    return { removed: [], kept: 0 }
  }
  const keepMs = (o.keepDays ?? SANDBOX_KEEP_DAYS) * 24 * 3600_000
  const removed: string[] = []
  let kept = 0
  for (const rec of containmentRecords({ sandboxRoot: root })) {
    const runDir = join(root, rec.runId)
    try {
      const nowMs = now().getTime()
      const gone = holderGone(rec, nowMs)
      if (!rec.releasedAt && gone) {
        const res = releaseRecord(rec, runDir, 'holder-gone', { platform: o.platform, run: o.run, now })
        log(`[containment] ${res.note} (its holder is gone)`)
      }
      const old = nowMs - Date.parse(rec.createdAt) > keepMs
      const holderAlive = rec.holder !== null && pidAlive(rec.holder.pid)
      if (!old || holderAlive) {
        kept++
        continue
      }
      if (!rec.releasedAt) {
        const res = releaseRecord(rec, runDir, 'sweep', { platform: o.platform, run: o.run, now })
        log(`[containment] ${res.note}`)
      }
      if (lstatSync(runDir).isSymbolicLink()) {
        log(`[containment] ${runDir} is a link; the sweep does not touch it`)
        kept++
        continue
      }
      removeTreeNoFollow(runDir, log)
      rmdirSync(runDir)
      removed.push(runDir)
      log(`[containment] removed the sandbox ${runDir} (created ${rec.createdAt})`)
    } catch (e) {
      kept++
      log(`[containment] the sweep could not finish ${runDir}: ${(e as Error).message}`)
    }
  }
  return { removed, kept }
}
