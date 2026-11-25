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
 * kill is under way. Measured 2026-11-11 (F210): a shell starting children as
 * fast as it can, killed mid-burst, left 32 and 34 of about 180 started
 * children running. A Stop that lands as the shell starts its command (the
 * first few hundred ms of every Bash call) is that case.
 *
 * `ownProcessTree(child)` is taken when the process is started. On Windows
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
 *
 * The walk is given the started process, not its number (F255). A pid is a
 * number, not a process: while the runtime has not handled a child's exit it
 * holds the child's handle and the number is nobody else's (measured
 * 2026-11-25: 300 starts, none got it), but once Node or Bun has handled the
 * exit (`exitCode` or `signalCode` set) the number is free and Windows gives it
 * to a new process after some seconds of churn. A walked tree cannot be found
 * from a root that has ended anyway, so its kill then starts nothing and says
 * why. While the root has not ended the walk runs `taskkill` synchronously, in
 * the same turn of the event loop as that look, so the runtime cannot handle the
 * exit in between; an asynchronous one is started at once but opens the pid
 * only after it has loaded (100 to 300 ms), and meanwhile the event loop can
 * handle the exit.
 * The cost: on the fallback path only (no Job Object: vitest's Node, or a job
 * that could not be taken), a kill blocks the event loop for one `taskkill`
 * (about 0.1 to 0.3 s measured, `WALK_KILL_CAP_MS` at most). A Job Object kill
 * is unchanged: it ends the job through its handle whatever the root did.
 * Off Windows the walk stays asynchronous and refuses the same way once the
 * root has ended. A bare number is still taken: the caller then says it knows
 * the process is alive (the jlens sidecar's stale sweep, by-hand fixtures).
 */
import { execFile, execFileSync } from 'child_process'

type Log = (msg: string) => void

/** The started process a walked tree is found from, as Node's ChildProcess and Bun's Subprocess both show it. */
export interface TreeRoot {
  readonly pid?: number
  /** null until the runtime has handled the process's exit; after that the pid number may be another process's. */
  readonly exitCode?: number | null
  readonly signalCode?: string | number | null
}

/** Has the runtime handled this root's exit? Then its pid number is free and may be another process's. */
function rootEnded(root: TreeRoot): boolean {
  return (root.exitCode !== null && root.exitCode !== undefined) || (root.signalCode !== null && root.signalCode !== undefined)
}

/** The longest a walk's synchronous `taskkill` may hold the event loop (measured at 0.1 to 0.3 s). */
const WALK_KILL_CAP_MS = 5000

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
 * The same kill, finished before it returns: for the caller that starts a
 * replacement on the same port in its next line (the jlens sidecar's stale
 * sweep), and for a walked tree whose root is still held (`ownProcessTree`).
 * Windows only: elsewhere the sweep uses `pkill`.
 */
export function killProcessTreeSync(pid: number, log: Log = console.log, capMs = 10000): void {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: capMs, windowsHide: true })
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
 * The walk of a tree whose root the caller handed over: it kills only while the runtime has not handled the root's
 * exit, and on Windows in the same turn as that look (the module's header says why).
 */
function walkFrom(root: TreeRoot, pid: number, log: Log): OwnedTree {
  let said = false
  return {
    kind: 'walk',
    kill: () => {
      if (rootEnded(root)) {
        if (!said) {
          said = true
          log(`[process-tree] pid ${pid} was not killed: its process has ended and its exit was handled, so the number may be another process's now, and without a Job Object what it started cannot be found from it`)
        }
        return Promise.resolve()
      }
      if (process.platform === 'win32') {
        killProcessTreeSync(pid, log, WALK_KILL_CAP_MS)
        return Promise.resolve()
      }
      return killProcessTree(pid, log)
    },
    release: () => {},
  }
}

/**
 * Take ownership of a process tree at the moment its root was started. Callers hand the started process (a
 * `TreeRoot`); a bare number is taken as a process the caller knows to be alive. No pid (the spawn failed) gives a
 * handle whose kill does nothing.
 */
export function ownProcessTree(root: number | undefined | TreeRoot, log: Log = console.log): OwnedTree {
  const held = typeof root === 'object' && root !== null ? root : null
  const pid = held ? held.pid : (root as number | undefined)
  if (pid === undefined) return { kind: 'walk', kill: async () => {}, release: () => {} }
  // A root whose exit was already handled is not opened by its number, for a job or a walk: the number may be
  // another process's (F255). Every caller owns the tree in the turn it started it, so this is a guard, not a path.
  if (held && rootEnded(held)) return walkFrom(held, pid, log)
  const taken = takeJob(pid)
  if ('why' in taken) {
    if (taken.why && !fallbackSaid) {
      fallbackSaid = true
      log(`[process-tree] no Job Object for child processes: ${taken.why}. A kill finds the tree when it happens and can miss a child started mid-kill.`)
    }
    if (held) return walkFrom(held, pid, log)
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

/**
 * Did exec end the child itself, because its output overran `maxBuffer`? Node and Bun give that
 * error the code `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and leave `killed` unset (measured under both,
 * 2026-11-24, check C4-5 of wave 15b); `killed` is kept for a runtime that sets it.
 */
export function overranBuffer(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown } | null
  return e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e?.killed === true
}

/** After a kill on the cap (or a Stop), how long an owned exec waits for exec's answer before it answers without it. */
export const OWNED_EXEC_GRACE_MS = 2000

/** How an owned exec ended. `err`, `stdout` and `stderr` are exec's, or null and '' when the grace ran out first. */
export interface OwnedExecEnd {
  err: Error | null
  stdout: string
  stderr: string
  /** Ended on its own cap: the tree was killed on the timer. */
  timedOut: boolean
  /** Ended because `signal` fired: the tree was killed. */
  stopped: boolean
  /** exec ended the root because its output overran its buffer; a tree a Job Object holds was killed with it, a walked tree was released (its root had ended, F255). */
  overran: boolean
}

/**
 * One child the harness starts for workspace code (a contract check, a best-of-N test run, LSP
 * diagnostics, the daemon precheck), with its process tree owned from the moment the root exists
 * (F201, F210, NOW.md 2026-11-24). `start` starts it with exec's callback and returns the child;
 * exec is given no `timeout`, because exec's kill ends the root alone and left what it had started
 * running. The tree is ended on the cap (`capMs`), on `signal`, and, when a Job Object holds it,
 * when exec ended the root for an output overrun (a walked tree is released there: exec answers after
 * the root's exit was handled, so it cannot be found from the root any more, F255); a child that ends
 * on its own gives the handle back and kills nothing, so a background process it left on purpose
 * lives on. A process the kill could not reach that still holds the pipes would hold the callback for
 * ever: after `graceMs` the answer comes anyway, with nothing printed. `own` is `ownProcessTree`,
 * passed by each caller so that a test's module mock of it reaches every site, and it is handed the
 * child `start` returned, never its pid alone. Rejects only when `start` throws (nothing was started).
 */
export function ownedExec(
  start: (callback: (err: Error | null, stdout: string, stderr: string) => void) => TreeRoot,
  opts: {
    capMs: number
    own: (root: TreeRoot) => OwnedTree
    graceMs?: number
    signal?: AbortSignal
    /** Called once when the cap ends the tree, before the kill (a site's log line). */
    onCut?: () => void
  },
): Promise<OwnedExecEnd> {
  return new Promise<OwnedExecEnd>((resolve, reject) => {
    let tree: OwnedTree | null = null
    let timedOut = false
    let stopped = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    const graceMs = opts.graceMs ?? OWNED_EXEC_GRACE_MS
    const onAbort = () => end('stopped')
    const settle = (r: OwnedExecEnd) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const end = (why: 'cap' | 'stopped') => {
      if (settled || timedOut || stopped) return
      if (why === 'cap') { timedOut = true; opts.onCut?.() } else stopped = true
      if (timer) clearTimeout(timer)
      void tree?.kill()
      grace = setTimeout(() => settle({ err: null, stdout: '', stderr: '', timedOut, stopped, overran: false }), graceMs)
    }
    let child: TreeRoot
    try {
      child = start((err, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        if (grace) clearTimeout(grace)
        const overran = !timedOut && !stopped && overranBuffer(err)
        // On an overrun only a Job Object can still end what the root started (as the Bash tool does).
        if (overran && tree?.kind === 'job') void tree.kill()
        else if (!timedOut && !stopped) tree?.release()
        settle({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, stopped, overran })
      })
    } catch (e) {
      reject(e)
      return
    }
    // exec's callback never runs before `start` returns, so the tree is taken before any answer.
    tree = opts.own(child)
    timer = setTimeout(() => end('cap'), opts.capMs)
    if (opts.signal?.aborted) end('stopped')
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
