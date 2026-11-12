/**
 * engine/apps/gpu.ts — the one rule, wired for its two callers
 * (docs/decisions/2026-11-11-local-llm-apps.md).
 *
 * When CynCo needs the GPU and an app's model server holds CynCo's port, CynCo
 * takes the port, says which app, and gives it back when it is done. The lazy
 * chat engine asks through `lazyAppDeps` (injected into
 * `ProcessManager.ensureRunningLazy` by `bootstrapProvider.ts`); a daemon
 * one-shot asks through `takeGpuForOneShot` before its busy check
 * (`TaskRunner`). Both give back through `giveGpuBack`.
 */
import { execFile } from 'child_process'
import { connect } from 'net'
import { readGpuBusy } from '../daemon/gpuBusyFile.js'
import type { PortOwner } from '../llama/portOwner.js'
import { displaceApp, restoreDisplacedApps } from './displace.js'
import { identifyPortHolder, type Holder } from './identify.js'
import type { ListedProc } from './portTree.js'

type Say = (message: string) => void

/** What a stop did: the process is gone, or it is not and why (F223). */
export type Stopped = { stopped: true } | { stopped: false; why: string }

/** The reason Windows gives when a process that is not elevated tries to end one that is. */
export const STARTED_AS_ADMINISTRATOR = 'Windows refused (Access is denied): it was started as administrator and CynCo was not'

export type StopDeps = {
  platform?: string
  /** Run `taskkill /F /PID`; what it wrote when it failed, null when it succeeded. */
  taskkill?: (pid: number) => Promise<string | null>
  /** Is there still a process with this pid? */
  exists?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

/** A process the caller may not signal still exists (EPERM); only "no such process" is gone. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

function runTaskkill(pid: number): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, (err, _out, stderr) => resolve(err ? String(stderr || err.message) : null))
  })
}

/**
 * Stop one process, not its tree: an app's launcher script must be left to run its own exit handler.
 * Answers whether the process is gone, because a kill can be refused: a server started from an
 * administrator window cannot be ended by an engine that is not elevated (F223). Never rejects.
 */
export async function stopProcess(pid: number, log: (line: string) => void = console.log, deps: StopDeps = {}): Promise<Stopped> {
  const exists = deps.exists ?? processExists
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let said: string | null = null
  if ((deps.platform ?? process.platform) === 'win32') {
    said = await (deps.taskkill ?? runTaskkill)(pid)
  } else {
    try { process.kill(pid, 'SIGKILL') } catch (e) { said = e instanceof Error ? e.message : String(e) }
  }
  if (said) {
    const line = said.trim().split(/\r?\n/).filter(Boolean).pop() ?? said.trim()
    log(`[apps] stopping pid ${pid}: ${line}`)
    if (/access is denied|EPERM|not permitted/i.test(said)) return { stopped: false, why: STARTED_AS_ADMINISTRATOR }
  }
  // A kill is asynchronous, and one that reported an error may have been beaten by the process ending by itself.
  for (let i = 0; i < 30; i++) {
    if (!exists(pid)) return { stopped: true }
    await sleep(100)
  }
  return { stopped: false, why: 'it was still running 3 s after the kill' }
}

/** Is anything bound to the port on this machine? */
export function portBound(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { s.destroy(); resolve(v) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function waitUntilFree(port: number, bound: (port: number) => Promise<boolean> = portBound): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (!(await bound(port))) return true
  }
  return false
}

export type LazyAppOpts = {
  identify?: (port: number) => Promise<Holder>
  kill?: (pid: number) => Promise<Stopped | void>
  listProcesses?: () => Promise<ListedProc[]>
  file?: string
  by?: string
}

/**
 * What `ensureRunningLazy` is given: `portOwner` that can answer `app`, and
 * `takeFromApp`, which stops the app's server it last identified, says which
 * app through the caller's notice channel, and records what is owed.
 */
export function lazyAppDeps(port: number, opts: LazyAppOpts = {}): { portOwner: () => Promise<PortOwner>; takeFromApp: (say: Say) => Promise<'displaced' | 'leftover' | { refused: string } | void> } {
  let last: Holder | null = null
  return {
    portOwner: async () => {
      last = await (opts.identify ?? identifyPortHolder)(port)
      return { owner: last.owner, detail: last.detail }
    },
    takeFromApp: async (say) => {
      if (!last || last.owner !== 'app') return
      const stop = opts.kill ?? ((pid: number) => stopProcess(pid))
      // The reason goes back with the outcome: the engine names it again when the fallback answers behind this server.
      let why = 'it is still running'
      const outcome = await displaceApp(last, {
        port, by: opts.by ?? `the chat engine (pid ${process.pid})`, say,
        kill: async pid => { const r = await stop(pid); if (r && !r.stopped) why = r.why; return r },
        ...(opts.listProcesses ? { listProcesses: opts.listProcesses } : {}),
        ...(opts.file ? { file: opts.file } : {}),
      })
      return outcome === 'refused' ? { refused: why } : outcome
    },
  }
}

export type OneShotTakeCtx = {
  port: number
  /** `the one-shot digest-espn`. */
  by: string
  say: Say
  portAnswers?: () => Promise<boolean>
  identify?: (port: number) => Promise<Holder>
  kill?: (pid: number) => Promise<Stopped | void>
  listProcesses?: () => Promise<ListedProc[]>
  waitFree?: () => Promise<boolean>
  file?: string
}

/**
 * Before a one-shot asks whether the GPU is busy: if the model port is held by
 * an app's server, or by a server that is nobody's, take it, by the rule the
 * chat engine uses. `free`: nothing was on the port. `taken`: it was stopped and
 * the port is free. `left`: another engine's server, one that could not be
 * read, or one that could not be stopped; the busy check that follows defers
 * the run. "Stopped" is said only once the port is free (F223).
 */
export async function takeGpuForOneShot(ctx: OneShotTakeCtx): Promise<'free' | 'taken' | 'left'> {
  if (!(await (ctx.portAnswers ?? (() => portBound(ctx.port)))())) return 'free'
  const holder = await (ctx.identify ?? identifyPortHolder)(ctx.port)
  const kill = ctx.kill ?? ((pid: number) => stopProcess(pid))
  const waitFree = ctx.waitFree ?? (() => waitUntilFree(ctx.port))
  if (holder.owner === 'app') {
    const outcome = await displaceApp(holder, {
      port: ctx.port, by: ctx.by, say: ctx.say, kill,
      ...(ctx.listProcesses ? { listProcesses: ctx.listProcesses } : {}),
      ...(ctx.file ? { file: ctx.file } : {}),
    })
    // The app module said why; there is no port to wait for.
    if (outcome === 'refused') return 'left'
    return (await waitFree()) ? 'taken' : 'left'
  }
  if (holder.owner !== 'foreign') return 'left'
  const result = await kill(holder.listener.pid)
  const free = !(result && !result.stopped) && await waitFree()
  if (free) {
    ctx.say(`port ${ctx.port} was held by a server that is not CynCo's: ${holder.detail}. Stopped it for ${ctx.by}.`)
    return 'taken'
  }
  const why = result && !result.stopped ? result.why : 'it was still listening after the kill'
  ctx.say(`port ${ctx.port} is held by a server that is not CynCo's: ${holder.detail}. CynCo could not stop it: ${why}. Close the window it was started from; ${ctx.by} waits for the port.`)
  return 'left'
}

/** CynCo is done with the GPU: start again what is owed (`restoreDisplacedApps`), with this machine's own probes. Never throws. */
export async function giveGpuBack(say: Say, opts: { file?: string } = {}): Promise<void> {
  try {
    await restoreDisplacedApps({
      gpuBusy: () => readGpuBusy() !== null,
      isPortOccupied: portBound,
      say,
      ...(opts.file ? { file: opts.file } : {}),
    })
  } catch (e) {
    console.log(`[apps] giving the GPU back failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
