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
 *   --shell <shell-or-empty> <command>                  the command through a shell (`exec`'s shape)
 *   --shell <shell-or-empty> --command-file <path>      the same, the command read from a UTF-8 file
 *   --exec <file> [args...]                             a program and its arguments, no shell
 *   --probe <mustFail> <mustSucceed>...                 in THIS process: one create that must be
 *                                                       denied, one per folder that must succeed
 *
 * Exit codes: the child's own; 197 with one stderr line `[containment] refused: <reason>` when it
 * could not lower itself or could not start the child (nothing was run); 198 with
 * `[containment] child ended: <signal or no status>` when the child ended with no status. The
 * launcher holds no handle to its child beyond the spawn and asks for no breakaway from a job, so
 * the Job Object the caller takes on this process's pid holds the child and everything it starts
 * (F201, F210).
 *
 * Imports node built-ins and ./containment.js only; bun:ffi is loaded when the token is lowered.
 */
import { readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  containmentFromRecord, LAUNCHER_CHILD_GONE_EXIT, LAUNCHER_REFUSED_EXIT, LAUNCHER_UNAVAILABLE, toolEnv,
} from './containment.js'

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

function say(fd: 1 | 2, line: string): void {
  // Written synchronously: the process exits right after, and a pipe must not lose the line.
  writeSync(fd, `${line}\n`)
}

function refuse(reason: string): never {
  say(2, `[containment] refused: ${reason}`)
  process.exit(LAUNCHER_REFUSED_EXIT)
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
    r = spawnSync(command, { shell: a.shell || true, cwd: a.cwd, env, stdio: 'inherit', windowsHide: true })
  }
  // 6. The child's exit code, or a named reason why there is none.
  if (r.error) refuse(`the command could not be started (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`)
  if (r.status === null) {
    say(2, `[containment] child ended: ${r.signal ?? 'no status'}`)
    process.exit(LAUNCHER_CHILD_GONE_EXIT)
  }
  process.exit(r.status)
}

if ((import.meta as { main?: boolean }).main) main(process.argv.slice(2))
