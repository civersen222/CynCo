/**
 * engine/lowIntegrityLauncher.ts: the low-integrity launcher (F242).
 *
 * On Windows a contained run's child is not started directly. `containedCommand`
 * (engine/containment.ts) starts this script instead, always as
 *
 *   <bun> --no-env-file --config=<checkout>/engine/lowIntegrityLauncher.bunfig.toml
 *         <checkout>/engine/lowIntegrityLauncher.ts --run-dir <sandbox.root> --cwd <child cwd>
 *         [--env K=V]... <mode>
 *
 * with the checkout as its working folder and the starting process's own environment, so nothing
 * a run can write (a bunfig.toml or a .env in the mission folder, a .bunfig.toml in the sandbox
 * home) is read while this process is still at medium integrity (entry 1.B1). Then, in this order:
 * it reads the run's record, lowers its OWN token to low integrity and reads the level back, and
 * only then builds the child's environment (`toolEnv` over the engine's environment and the
 * `--env` pairs) and starts the child in `--cwd`. Everything the child starts is low as well.
 *
 * Modes:
 *   --shell <shell-or-empty> <command>                  the command through a shell (`exec`'s shape;
 *                                                       PowerShell with -NoProfile -NonInteractive: `shellStart`)
 *   --shell <shell-or-empty> --command-file <path>      the same, the command read from a UTF-8 file
 *   --exec <file> [args...]                             a program and its arguments, no shell
 *   --probe <mustFail> <mustSucceed>...                 in THIS process: one create that must be
 *                                                       denied, one per folder that must succeed
 *
 * Exit codes: the child's own; 197 with one stderr line `[containment] refused: <reason>` when it
 * could not lower itself or could not start the child (nothing was run); 198 with
 * `[containment] child ended: <signal or no status>` when the child ended with no status. When the
 * starter put a seal in this process's environment (`LAUNCHER_SEAL_ENV`, taken out before anything
 * else, so the child never holds it), each of the two lines is followed by
 * `[containment] sealed <seal> <status>`: the child shares this stderr, and only the seal tells the
 * starter the line is this process's own (`launcherFaultOf`). The
 * launcher holds no handle to its child beyond the spawn and asks for no breakaway from a job, so
 * the Job Object the caller takes on this process's pid holds the child and everything it starts
 * (F201, F210).
 *
 * Imports node built-ins and ./containment.js only; bun:ffi is loaded when the token is lowered.
 * Every file module is imported statically, so it is loaded before the lowering: Bun at low
 * integrity cannot load a module from a folder that is not labelled low (measured 2026-11-23,
 * engine/tools/CLAUDE.md), so an `import()` after the lowering would fail.
 */
import { readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  containmentFromRecord, LAUNCHER_CHILD_GONE_EXIT, LAUNCHER_REFUSED_EXIT, LAUNCHER_SEAL_ENV, LAUNCHER_SEAL_PREFIX,
  LAUNCHER_UNAVAILABLE, toolEnv,
} from './containment.js'

/** This spawn's seal, taken out of the environment first thing in `main`; undefined when none was given. */
let seal: string | undefined

/** TokenIntegrityLevel, the TOKEN_INFORMATION_CLASS of the mandatory label. */
const TOKEN_INTEGRITY_LEVEL = 25
/** TOKEN_ADJUST_DEFAULT | TOKEN_QUERY. */
const TOKEN_ACCESS = 0x0080 | 0x0008
/** SE_GROUP_INTEGRITY. */
const SE_GROUP_INTEGRITY = 0x20
/** The low mandatory level's RID; anything above it is not low. */
const LOW_RID = 0x1000
const LOW_SID = 'S-1-16-4096'

type Kernel32 = {
  GetCurrentProcess(): unknown
  CloseHandle(handle: unknown): number
  GetLastError(): number
  LocalFree(mem: unknown): unknown
}

type Advapi32 = {
  OpenProcessToken(process: unknown, access: number, tokenOut: unknown): number
  ConvertStringSidToSidW(sid: unknown, sidOut: unknown): number
  GetLengthSid(sid: unknown): number
  SetTokenInformation(token: unknown, cls: number, info: unknown, length: number): number
  GetTokenInformation(token: unknown, cls: number, info: unknown, length: number, returned: unknown): number
  GetSidSubAuthorityCount(sid: unknown): unknown
  GetSidSubAuthority(sid: unknown, index: number): unknown
}

type Ffi = {
  dlopen(lib: string, symbols: Record<string, { args: unknown[]; returns: unknown }>): { symbols: unknown }
  FFIType: Record<string, unknown>
  ptr(view: ArrayBufferView): number
  read: { u8(p: unknown, offset?: number): number; u32(p: unknown, offset?: number): number }
}

function loadFfi(): Ffi {
  // A computed specifier keeps vitest's Node-side module graph from trying to resolve bun:ffi
  // (the same pattern as engine/processTree.ts and engine/security/jobObject.ts).
  const ffiModule = 'bun:ffi'
  return require(ffiModule) as Ffi
}

/**
 * Lower this process's own token to low integrity and read the level back. Null when the token
 * now reads low; otherwise the reason, already worded as `LAUNCHER_UNAVAILABLE(...)`.
 */
export function lowerOwnIntegrity(): string | null {
  let ffi: Ffi
  try {
    ffi = loadFfi()
  } catch (e) {
    return LAUNCHER_UNAVAILABLE(`bun:ffi did not load: ${e instanceof Error ? e.message : String(e)}`)
  }
  const { dlopen, FFIType: T, ptr, read } = ffi
  let k: Kernel32
  let a: Advapi32
  try {
    k = dlopen('kernel32.dll', {
      GetCurrentProcess: { args: [], returns: T.ptr },
      CloseHandle: { args: [T.ptr], returns: T.i32 },
      GetLastError: { args: [], returns: T.u32 },
      LocalFree: { args: [T.ptr], returns: T.ptr },
    }).symbols as Kernel32
    a = dlopen('advapi32.dll', {
      OpenProcessToken: { args: [T.ptr, T.u32, T.ptr], returns: T.i32 },
      ConvertStringSidToSidW: { args: [T.ptr, T.ptr], returns: T.i32 },
      GetLengthSid: { args: [T.ptr], returns: T.u32 },
      SetTokenInformation: { args: [T.ptr, T.u32, T.ptr, T.u32], returns: T.i32 },
      GetTokenInformation: { args: [T.ptr, T.u32, T.ptr, T.u32, T.ptr], returns: T.i32 },
      GetSidSubAuthorityCount: { args: [T.ptr], returns: T.ptr },
      GetSidSubAuthority: { args: [T.ptr, T.u32], returns: T.ptr },
    }).symbols as Advapi32
  } catch (e) {
    return LAUNCHER_UNAVAILABLE(`bun:ffi did not load: ${e instanceof Error ? e.message : String(e)}`)
  }

  const tokenOut = new BigUint64Array(1)
  if (!a.OpenProcessToken(k.GetCurrentProcess(), TOKEN_ACCESS, ptr(tokenOut))) {
    return LAUNCHER_UNAVAILABLE(`OpenProcessToken failed: ${k.GetLastError()}`)
  }
  const token = Number(tokenOut[0])
  try {
    const sidText = Buffer.from(`${LOW_SID}\0`, 'utf16le')
    const sidOut = new BigUint64Array(1)
    if (!a.ConvertStringSidToSidW(ptr(sidText), ptr(sidOut))) {
      return LAUNCHER_UNAVAILABLE(`ConvertStringSidToSidW failed: ${k.GetLastError()}`)
    }
    const sid = Number(sidOut[0])
    try {
      // TOKEN_MANDATORY_LABEL on x64: { PSID Sid at 0; DWORD Attributes at 8 }, 16 bytes, followed
      // here by a copy of the SID itself, so the length passed is the buffer's real size and the
      // Sid pointer points inside it.
      const sidLength = a.GetLengthSid(sid)
      const label = new Uint8Array(16 + sidLength)
      for (let i = 0; i < sidLength; i++) label[16 + i] = read.u8(sid, i)
      const view = new DataView(label.buffer)
      view.setBigUint64(0, BigInt(ptr(label) + 16), true)
      view.setUint32(8, SE_GROUP_INTEGRITY, true)
      if (!a.SetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, ptr(label), label.byteLength)) {
        return LAUNCHER_UNAVAILABLE(`SetTokenInformation failed: ${k.GetLastError()}`)
      }
    } finally {
      k.LocalFree(sid)
    }
    // Read the level back from the token itself: only what the token says counts.
    const info = new BigUint64Array(32)
    const returned = new Uint32Array(1)
    if (!a.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, ptr(info), info.byteLength, ptr(returned))) {
      return LAUNCHER_UNAVAILABLE(`GetTokenInformation failed: ${k.GetLastError()}`)
    }
    const readSid = Number(info[0])
    const count = read.u8(a.GetSidSubAuthorityCount(readSid))
    const rid = count > 0 ? read.u32(a.GetSidSubAuthority(readSid, count - 1)) : -1
    if (rid < 0 || rid > LOW_RID) {
      return LAUNCHER_UNAVAILABLE(`the token still reads integrity RID 0x${rid < 0 ? 'none' : rid.toString(16)} after lowering`)
    }
    return null
  } finally {
    k.CloseHandle(token)
  }
}

/**
 * Makes every handle this process holds non-inheritable, except its three standard handles, which the
 * child is given its own copies of. The launcher inherits whatever its medium starter left inheritable
 * (measured: a Git Bash starter's process handles, through which a low child read a live medium bash's
 * environment block, since a handle's access is not checked again against the integrity label; review of
 * wave 5). A child started after this inherits none of them. Null on success, else why not (the caller
 * refuses: a child that could read its starter's environment is not started).
 */
export function dropInheritedHandles(): string | null {
  let ffi: Ffi
  try {
    ffi = loadFfi()
  } catch (e) {
    return `bun:ffi did not load: ${e instanceof Error ? e.message : String(e)}`
  }
  const { dlopen, FFIType: T, ptr } = ffi
  let k: {
    GetCurrentProcess: () => number; GetProcessHandleCount: (p: number, out: number) => number
    GetHandleInformation: (h: number, out: number) => number; SetHandleInformation: (h: number, mask: number, flags: number) => number
    GetStdHandle: (n: number) => number; GetLastError: () => number
  }
  try {
    k = dlopen('kernel32.dll', {
      GetCurrentProcess: { args: [], returns: T.ptr },
      GetProcessHandleCount: { args: [T.ptr, T.ptr], returns: T.i32 },
      GetHandleInformation: { args: [T.ptr, T.ptr], returns: T.i32 },
      SetHandleInformation: { args: [T.ptr, T.u32, T.u32], returns: T.i32 },
      GetStdHandle: { args: [T.u32], returns: T.ptr },
      GetLastError: { args: [], returns: T.u32 },
    }).symbols as typeof k
  } catch (e) {
    return `bun:ffi did not load: ${e instanceof Error ? e.message : String(e)}`
  }
  const count = new Uint32Array(1)
  if (!k.GetProcessHandleCount(k.GetCurrentProcess(), ptr(count))) return `GetProcessHandleCount failed: ${k.GetLastError()}`
  // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE as DWORDs (-10, -11, -12).
  const std = new Set([0xfffffff6, 0xfffffff5, 0xfffffff4].map(n => Number(k.GetStdHandle(n))))
  const flags = new Uint32Array(1)
  let seen = 0
  let failed = 0
  // Handle values are multiples of 4; the walk stops once every handle the count names has been seen.
  for (let h = 4; h < 1 << 24 && seen < count[0]; h += 4) {
    if (!k.GetHandleInformation(h, ptr(flags))) continue
    seen++
    if ((flags[0] & HANDLE_FLAG_INHERIT) === 0 || std.has(h)) continue
    if (!k.SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0)) failed++
  }
  return failed > 0 ? `${failed} inheritable handle(s) could not be made non-inheritable` : null
}

const HANDLE_FLAG_INHERIT = 1

export type LauncherArgs =
  | { mode: 'shell'; runDir: string; cwd: string; env: Record<string, string>; shell: string; command: string; commandFile?: string }
  | { mode: 'exec'; runDir: string; cwd: string; env: Record<string, string>; file: string; args: string[] }
  | { mode: 'probe'; runDir: string; env: Record<string, string>; mustFail: string; mustSucceed: string[] }

/**
 * Parse the launcher's arguments (everything after its script path). Pure. The command of the
 * shell form and the program of the exec form are taken positionally, so they may start with `--`.
 */
export function parseLauncherArgs(argv: readonly string[]): { ok: true; args: LauncherArgs } | { ok: false; reason: string } {
  let runDir: string | null = null
  let cwd: string | null = null
  const env: Record<string, string> = {}
  let i = 0
  const bad = (what: string) => ({ ok: false as const, reason: `unknown launcher mode ${what}` })
  for (; i < argv.length; i += 2) {
    const flag = argv[i]
    if (flag !== '--run-dir' && flag !== '--cwd' && flag !== '--env') break
    const value = argv[i + 1]
    if (value === undefined) return bad(`(${flag} has no value)`)
    if (flag === '--run-dir') runDir = value
    else if (flag === '--cwd') cwd = value
    else {
      const eq = value.indexOf('=')
      if (eq <= 0) return bad(`(--env ${value} is not KEY=VALUE)`)
      env[value.slice(0, eq)] = value.slice(eq + 1)
    }
  }
  if (runDir === null || runDir === '') return bad('(no --run-dir)')
  const mode = argv[i]
  const rest = argv.slice(i + 1)
  if (mode === '--probe') {
    if (rest.length < 2) return bad('(--probe needs a path that must fail and at least one that must succeed)')
    return { ok: true, args: { mode: 'probe', runDir, env, mustFail: rest[0], mustSucceed: rest.slice(1) } }
  }
  if (mode !== '--shell' && mode !== '--exec') return bad(mode === undefined ? '(none given)' : mode)
  if (cwd === null || cwd === '') return bad(`${mode} (no --cwd)`)
  if (mode === '--exec') {
    if (rest.length < 1 || rest[0] === '') return bad('--exec (no program)')
    return { ok: true, args: { mode: 'exec', runDir, cwd, env, file: rest[0], args: rest.slice(1) } }
  }
  if (rest.length < 1) return bad('--shell (no shell slot)')
  const shell = rest[0]
  const after = rest.slice(1)
  if (after.length === 2 && after[0] === '--command-file') {
    return { ok: true, args: { mode: 'shell', runDir, cwd, env, shell, command: '', commandFile: after[1] } }
  }
  if (after.length !== 1) return bad(`--shell (expected one command, got ${after.length} arguments)`)
  return { ok: true, args: { mode: 'shell', runDir, cwd, env, shell, command: after[0] } }
}

/**
 * How the shell form starts its command. Pure. Windows PowerShell and pwsh are started with an
 * explicit argument list, `-NoProfile -NonInteractive -Command <command>` (NOW.md:261): through
 * `shell:` they were given `-c <command>` alone, so a PowerShell profile under the owner's real
 * Documents (which the environment overlay does not move) would have run before every contained
 * command and put its output into the answer, and a prompt would have waited for a person. The
 * command reaches PowerShell as the same one argument either way (`shell:` with a shell that is not
 * cmd hands it on as `-c` and the command, quoted the same way). Every other shell (cmd, the empty
 * slot) is started as before.
 */
export function shellStart(shell: string, command: string): { file: string; args: string[]; shell?: string | true } {
  const file = shell.replace(/^"(.*)"$/, '$1')
  const name = file.split(/[\\/]/).pop() ?? ''
  if (/^(powershell|pwsh)(\.exe)?$/i.test(name)) return { file, args: ['-NoProfile', '-NonInteractive', '-Command', command] }
  return { file: command, args: [], shell: shell || true }
}

/**
 * Wave 19b (from package C): a command handed by `--command-file` is put on the child's command line
 * (PowerShell's `-Command`, cmd's `/c`), and Windows takes at most 32,767 characters there. Measured
 * 2026-11-25 through this launcher: 32,000 characters ran; 32,767 and 40,000 gave this process's own
 * 197 with "the command could not be started (ENAMETOOLONG)" (never a crash), now said in words.
 * (cmd.exe's own limit, 8,191, is cmd's answer: "The command line is too long.", exit 1.)
 */
export const COMMAND_LINE_TOO_LONG = 'the command could not be started (ENAMETOOLONG: its command line would be longer than the 32,767 characters Windows allows; a longer script goes into a file in the working folder, and that file is run)'

/** The launcher's reason when its child could not be started at all. Pure. */
export function childStartRefusal(e: { code?: string; message: string }): string {
  if (e.code === 'ENAMETOOLONG') return COMMAND_LINE_TOO_LONG
  return `the command could not be started (${e.code ?? e.message})`
}

function say(fd: 1 | 2, line: string): void {
  // Written synchronously: the process exits right after, and a pipe must not lose the line.
  writeSync(fd, `${line}\n`)
}

/** The launcher's own 197 or 198, its line, and the seal line that proves the line is its own. */
function exitOwn(status: number, line: string): never {
  say(2, line)
  if (seal !== undefined) say(2, `${LAUNCHER_SEAL_PREFIX}${seal} ${status}`)
  process.exit(status)
}

function refuse(reason: string): never {
  exitOwn(LAUNCHER_REFUSED_EXIT, `[containment] refused: ${reason}`)
}

/** One create in this (already low) process: `created`, or the error code that denied it. */
function tryCreate(path: string): string {
  try {
    writeFileSync(path, 'probe', { flag: 'wx' })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e))
  }
  try {
    unlinkSync(path)
  } catch (e) {
    say(2, `[containment] the probe file ${path} could not be removed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return 'created'
}

function main(argv: readonly string[]): never {
  // 0. The seal leaves the environment before anything can copy it (Windows keys are case-blind).
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase() !== LAUNCHER_SEAL_ENV) continue
    const v = process.env[k]
    if (seal === undefined && typeof v === 'string' && v !== '') seal = v
    delete process.env[k]
  }
  // 1. Where it can run at all, and what it was asked.
  if (process.platform !== 'win32') refuse(LAUNCHER_UNAVAILABLE('not Windows'))
  if (typeof (globalThis as { Bun?: { version?: string } }).Bun?.version !== 'string') refuse(LAUNCHER_UNAVAILABLE('not Bun'))
  const parsed = parseLauncherArgs(argv)
  if (!parsed.ok) refuse(parsed.reason)
  const a = parsed.args
  // 2. The run's record, written by its medium-integrity starter.
  const ctx = containmentFromRecord(a.runDir)
  if (!ctx.ok) refuse(ctx.reason)
  // 3. Lower this process's own token, and read it back.
  const lowered = lowerOwnIntegrity()
  if (lowered !== null) refuse(lowered)

  if (a.mode === 'probe') {
    const outside = tryCreate(a.mustFail)
    const inside = a.mustSucceed.map(tryCreate)
    say(1, JSON.stringify({ low: true, outside, inside }))
    process.exit(0)
  }

  // 3b. Nothing this process inherited from its medium starter reaches the child.
  const dropped = dropInheritedHandles()
  if (dropped !== null) refuse(`the launcher's inherited handles could not be closed to its child (${dropped})`)

  // 4. Only now the child's environment: the pairs are laid over the base before toolEnv runs, so
  //    a pair can neither undo the overlay nor bring back a key toolEnv strips.
  const env = toolEnv({ ...process.env, ...a.env }, ctx.containment, 'win32')

  // 5. The child, with this process's stdio, in its own working folder.
  let r: ReturnType<typeof spawnSync>
  if (a.mode === 'exec') {
    r = spawnSync(a.file, a.args, { cwd: a.cwd, env, stdio: 'inherit', windowsHide: true })
  } else {
    let command = a.command
    if (a.commandFile !== undefined) {
      try {
        command = readFileSync(a.commandFile, 'utf-8')
      } catch (e) {
        refuse(`the command file ${a.commandFile} could not be read (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    const how = shellStart(a.shell, command)
    r = how.shell === undefined
      ? spawnSync(how.file, how.args, { cwd: a.cwd, env, stdio: 'inherit', windowsHide: true })
      : spawnSync(how.file, { shell: how.shell, cwd: a.cwd, env, stdio: 'inherit', windowsHide: true })
  }
  // 6. The child's exit code, or a named reason why there is none.
  if (r.error) refuse(childStartRefusal(r.error as NodeJS.ErrnoException))
  if (r.status === null) {
    exitOwn(LAUNCHER_CHILD_GONE_EXIT, `[containment] child ended: ${r.signal ?? 'no status'}`)
  }
  process.exit(r.status)
}

if ((import.meta as { main?: boolean }).main) main(process.argv.slice(2))
