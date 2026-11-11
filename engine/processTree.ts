/**
 * Killing a process together with everything it started: the one place the
 * engine does it (the Bash tool's Stop and timeout, the daemon's one-shot
 * engines, the jlens sidecar).
 *
 * Two ways, because one of them is not enough on Windows.
 *
 * `killProcessTree(pid)` finds the tree at the moment of the kill: `taskkill
 * /F /T` on Windows, a `pgrep -P` walk then SIGKILL elsewhere. It has to run
 * while the root is alive, and it misses a child that is started while the
 * kill is under way. Measured 2026-11-11 (F209): a shell starting children as
 * fast as it can, killed mid-burst, left 32 and 34 of about 180 started
 * children running. A Stop that lands as the shell starts its command (the
 * first few hundred ms of every Bash call) is that case.
 *
 * `ownProcessTree(pid)` is taken when the process is started. On Windows
 * under Bun it puts the process in a Job Object of its own: every process the
 * root starts from then on is in the job the instant it exists, and
 * `TerminateJobObject` ends them all at once, with no list to go stale. The
 * engine itself sits in a job (F131, `security/jobObject.ts`); this one nests
 * inside it. Where there is no Job Object (not Windows, or not Bun: vitest
 * runs on Node and has no `bun:ffi`), or when taking one fails, the handle
 * falls back to `killProcessTree` and says why once.
 *
 * A handle that is not killed must be released when its process ends, or the
 * job handle leaks until the engine exits. Releasing kills nothing: a
 * background process the command left running on purpose lives on, as before.
 */
import { execFile, execFileSync } from 'child_process'

type Log = (msg: string) => void

/** Kill a process and everything it started, as found at the moment of the call. Never rejects. */
export function killProcessTree(pid: number, log: Log = console.log): Promise<void> {
  return new Promise<void>(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, err => {
        if (err) log(`[process-tree] taskkill /T ${pid}: ${String(err.message).trim().split('\n').pop()}`)
        resolve()
      })
      return
    }
    // The descendants are collected before anything is killed: a dead parent's
    // children are re-parented and can no longer be found from it.
    const found: number[] = []
    const finish = () => {
      for (const p of [...found.reverse(), pid]) {
        try { process.kill(p, 'SIGKILL') } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log(`[process-tree] kill ${p}: ${err instanceof Error ? err.message : err}`)
        }
      }
      resolve()
    }
    const walk = (parents: number[]) => {
      if (parents.length === 0) { finish(); return }
      let pending = parents.length
      const next: number[] = []
      for (const parent of parents) {
        // pgrep exits 1 with no output when a process has no children.
        execFile('pgrep', ['-P', String(parent)], (_err, out) => {
          for (const line of String(out ?? '').split('\n')) {
            const n = Number(line.trim())
            if (Number.isInteger(n) && n > 0) next.push(n)
          }
          if (--pending === 0) { found.push(...next); walk(next) }
        })
      }
    }
    walk([pid])
  })
}

/**
 * The same kill, finished before it returns, for the one caller that starts a
 * replacement on the same port in its next line (the jlens sidecar's stale
 * sweep). Windows only: elsewhere that caller uses `pkill`.
 */
export function killProcessTreeSync(pid: number, log: Log = console.log): void {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000, windowsHide: true })
  } catch (e) {
    log(`[process-tree] pid ${pid} already gone: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
  }
}

export interface OwnedTree {
  /** 'job': a Job Object holds the tree. 'walk': the tree is found when it is killed. */
  readonly kind: 'job' | 'walk'
  /** Kill the root and everything it started. Safe to call twice, and after the root has exited. Never rejects. */
  kill(): Promise<void>
  /** The process ended on its own: give the handle back without killing anything. */
  release(): void
}

/** PROCESS_TERMINATE | PROCESS_SET_QUOTA: what AssignProcessToJobObject needs. */
const PROCESS_ACCESS = 0x0001 | 0x0100

type Kernel32 = {
  CreateJobObjectW(attrs: null, name: null): unknown
  OpenProcess(access: number, inherit: number, pid: number): unknown
  AssignProcessToJobObject(job: unknown, process: unknown): number
  TerminateJobObject(job: unknown, exitCode: number): number
  CloseHandle(handle: unknown): number
  GetLastError(): number
}

let kernel32: Kernel32 | null | undefined
let fallbackSaid = false

function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32
  kernel32 = null
  if (process.platform !== 'win32' || typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return kernel32
  // A computed specifier keeps vitest's Node-side module graph from trying to
  // resolve bun:ffi; under Bun the require resolves normally.
  const ffiModule = 'bun:ffi'
  const { dlopen, FFIType } = require(ffiModule)
  kernel32 = dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols as Kernel32
  return kernel32
}

/** Put `pid` in a Job Object of its own. The job handle, or the reason there is none. */
function takeJob(pid: number): { k: Kernel32; job: unknown } | { why: string } {
  try {
    const k = loadKernel32()
    if (!k) return { why: process.platform !== 'win32' ? '' : 'bun:ffi is not available outside the Bun runtime' }
    const job = k.CreateJobObjectW(null, null)
    if (!job) return { why: `CreateJobObjectW failed (${k.GetLastError()})` }
    const proc = k.OpenProcess(PROCESS_ACCESS, 0, pid)
    if (!proc) {
      const why = `OpenProcess(${pid}) failed (${k.GetLastError()})`
      k.CloseHandle(job)
      return { why }
    }
    const assigned = k.AssignProcessToJobObject(job, proc)
    const why = assigned ? '' : `AssignProcessToJobObject(${pid}) failed (${k.GetLastError()})`
    k.CloseHandle(proc)
    if (!assigned) { k.CloseHandle(job); return { why } }
    return { k, job }
  } catch (e) {
    return { why: `ffi error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Take ownership of a process tree at the moment its root was started.
 * `pid` undefined (the spawn failed) gives a handle whose kill does nothing.
 */
export function ownProcessTree(pid: number | undefined, log: Log = console.log): OwnedTree {
  if (pid === undefined) return { kind: 'walk', kill: async () => {}, release: () => {} }
  const taken = takeJob(pid)
  if ('why' in taken) {
    if (taken.why && !fallbackSaid) {
      fallbackSaid = true
      log(`[process-tree] no Job Object for child processes: ${taken.why}. A kill finds the tree when it happens and can miss a child started mid-kill.`)
    }
    return { kind: 'walk', kill: () => killProcessTree(pid, log), release: () => {} }
  }
  const { k, job } = taken
  let open = true
  const close = () => {
    if (!open) return
    open = false
    k.CloseHandle(job)
  }
  return {
    kind: 'job',
    kill: async () => {
      if (!open) return
      if (!k.TerminateJobObject(job, 1)) log(`[process-tree] TerminateJobObject for pid ${pid} failed (${k.GetLastError()})`)
      close()
    },
    release: close,
  }
}
