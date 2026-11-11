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

/** Stop one process, not its tree: an app's launcher script must be left to run its own exit handler. */
export function stopProcess(pid: number, log: (line: string) => void = console.log): Promise<void> {
  return new Promise<void>(resolve => {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL') } catch (e) { log(`[apps] kill ${pid}: ${e instanceof Error ? e.message : String(e)}`) }
      resolve()
      return
    }
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, err => {
      if (err) log(`[apps] taskkill ${pid}: ${String(err.message).trim().split('\n').pop()}`)
      resolve()
    })
  })
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
  kill?: (pid: number) => Promise<void>
  listProcesses?: () => Promise<ListedProc[]>
  file?: string
  by?: string
}

/**
 * What `ensureRunningLazy` is given: `portOwner` that can answer `app`, and
 * `takeFromApp`, which stops the app's server it last identified, says which
 * app through the caller's notice channel, and records what is owed.
 */
export function lazyAppDeps(port: number, opts: LazyAppOpts = {}): { portOwner: () => Promise<PortOwner>; takeFromApp: (say: Say) => Promise<void> } {
  let last: Holder | null = null
  return {
    portOwner: async () => {
      last = await (opts.identify ?? identifyPortHolder)(port)
      return { owner: last.owner, detail: last.detail }
    },
    takeFromApp: async (say) => {
      if (!last || last.owner !== 'app') return
      await displaceApp(last, {
        port, by: opts.by ?? `the chat engine (pid ${process.pid})`, say,
        kill: opts.kill ?? (pid => stopProcess(pid)),
        ...(opts.listProcesses ? { listProcesses: opts.listProcesses } : {}),
        ...(opts.file ? { file: opts.file } : {}),
      })
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
  kill?: (pid: number) => Promise<void>
  listProcesses?: () => Promise<ListedProc[]>
  waitFree?: () => Promise<boolean>
  file?: string
}

/**
 * Before a one-shot asks whether the GPU is busy: if the model port is held by
 * an app's server, or by a server that is nobody's, take it, by the rule the
 * chat engine uses. `free`: nothing was on the port. `taken`: it was stopped and
 * the port is free. `left`: another engine's server, one that could not be
 * read, or one that would not die; the busy check that follows defers the run.
 */
export async function takeGpuForOneShot(ctx: OneShotTakeCtx): Promise<'free' | 'taken' | 'left'> {
  if (!(await (ctx.portAnswers ?? (() => portBound(ctx.port)))())) return 'free'
  const holder = await (ctx.identify ?? identifyPortHolder)(ctx.port)
  const kill = ctx.kill ?? ((pid: number) => stopProcess(pid))
  if (holder.owner === 'app') {
    await displaceApp(holder, {
      port: ctx.port, by: ctx.by, say: ctx.say, kill,
      ...(ctx.listProcesses ? { listProcesses: ctx.listProcesses } : {}),
      ...(ctx.file ? { file: ctx.file } : {}),
    })
  } else if (holder.owner === 'foreign') {
    ctx.say(`port ${ctx.port} was held by a server that is not CynCo's: ${holder.detail}. Stopped it for ${ctx.by}.`)
    await kill(holder.listener.pid)
  } else {
    return 'left'
  }
  return (await (ctx.waitFree ?? (() => waitUntilFree(ctx.port)))()) ? 'taken' : 'left'
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
