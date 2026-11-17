/**
 * engine/llama/lazyLoad.ts — the model loads on the first request and leaves
 * the GPU when nothing has been open for a while.
 *
 * Three switches, each read once in `lazySettings` and nowhere else:
 *   LOCALCODE_LLAMA_LAZY=true          skip ensureRunning() at boot; the provider
 *                                      calls `ensureReady` before every request
 *   LOCALCODE_LLAMA_IDLE_UNLOAD_MS=N   unload after N ms with no activity (0 = never)
 *   LOCALCODE_LLAMA_LAZY_WAIT_MS=N     how long a lazy load waits on a busy GPU
 * Defaults keep today's behaviour byte for byte (missions, the TUI). The
 * widget's headless phone engine sets the first two.
 *
 * `createLazyEnsureReady` serialises concurrent first calls into one
 * `ProcessManager.ensureRunningLazy` (processManager.ts), whose deps come
 * from `gpu-busy.json` (engine/daemon/gpuBusyFile.ts): the lazy path waits
 * on a running one-shot instead of killing its server.
 *
 * `IdleUnloader` keys on the activity registry (engine/power/activity.ts),
 * not on provider requests alone: a tool call running inside a turn keeps
 * the turn open, so the model stays. Unload = saveSlot() then the deliberate
 * stop(), which the restart budget does not count.
 * Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 2).
 */
import type { ActivityRegistry } from '../power/activity.js'
import type { GpuBusy } from '../daemon/gpuBusyFile.js'
import { abortError, type LazyWaitDeps, type ProcessManager } from './processManager.js'

export type LazySettings = { lazy: boolean; idleUnloadMs: number; lazyWaitMs: number }

const DEFAULT_LAZY_WAIT_MS = 30 * 60 * 1000

export function lazySettings(env: NodeJS.ProcessEnv = process.env): LazySettings {
  const nonNeg = (v: string | undefined, dflt: number): number => {
    if (v === undefined || v.trim() === '') return dflt
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : dflt
  }
  return {
    lazy: env.LOCALCODE_LLAMA_LAZY === 'true',
    idleUnloadMs: nonNeg(env.LOCALCODE_LLAMA_IDLE_UNLOAD_MS, 0),
    lazyWaitMs: nonNeg(env.LOCALCODE_LLAMA_LAZY_WAIT_MS, DEFAULT_LAZY_WAIT_MS) || DEFAULT_LAZY_WAIT_MS,
  }
}

export type LazyEnsureReadyOpts = {
  readBusy: () => GpuBusy | null
  maxWaitMs: number
  onWaiting?: LazyWaitDeps['onWaiting']
  pollMs?: number
  /** Whose server holds the port, when the default reader is not enough (engine/apps/gpu.ts names the owner's apps). */
  portOwner?: LazyWaitDeps['portOwner']
  takeFromApp?: LazyWaitDeps['takeFromApp']
}

/**
 * One in-flight load at a time; callers that arrive during it share it. A caller that passes its
 * request's signal leaves the moment that signal aborts (Stop), rejecting as an aborted fetch would.
 * When the last caller has left, the wait itself is cancelled, so a port that frees later loads no
 * model nobody asked for; a load that has already started runs to its end (F204). A caller with no
 * signal never leaves, and so keeps the wait alive.
 */
export function createLazyEnsureReady(
  pm: Pick<ProcessManager, 'ensureRunningLazy' | 'isPortOccupied'>,
  opts: LazyEnsureReadyOpts,
): (signal?: AbortSignal) => Promise<void> {
  type Load = { done: Promise<void>; cancel: AbortController; callers: number }
  let inflight: Load | null = null
  const ready = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    // A load that was cancelled is on its way out (or, already spawning, on its way to done): a new
    // request waits for it to settle and then asks afresh, never inheriting somebody else's Stop.
    if (inflight?.cancel.signal.aborted) {
      return untilAborted(inflight.done.then(() => {}, () => {}), signal).then(() => ready(signal))
    }
    if (!inflight) {
      const cancel = new AbortController()
      const mine: Load = { cancel, callers: 0, done: Promise.resolve() }
      mine.done = pm.ensureRunningLazy({
        readBusy: opts.readBusy,
        isPortOccupied: () => pm.isPortOccupied(),
        maxWaitMs: opts.maxWaitMs,
        signal: cancel.signal,
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
        ...(opts.onWaiting ? { onWaiting: opts.onWaiting } : {}),
        ...(opts.portOwner ? { portOwner: opts.portOwner } : {}),
        ...(opts.takeFromApp ? { takeFromApp: opts.takeFromApp } : {}),
      }).finally(() => { if (inflight === mine) inflight = null })
      // Every caller may have left by the time it settles; each caller's own promise carries the failure.
      mine.done.catch(() => {})
      inflight = mine
    }
    const load = inflight
    load.callers++
    return untilAborted(load.done, signal, stopped => {
      load.callers--
      if (stopped && load.callers === 0) load.cancel.abort()
    })
  }
  return ready
}

/**
 * `p`, or the caller's abort error the moment its signal aborts. `onLeave` runs once, when the caller
 * stops waiting: `stopped` says it left on its signal, before `p` settled.
 */
function untilAborted(p: Promise<void>, signal: AbortSignal | undefined, onLeave: (stopped: boolean) => void = () => {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let left = false
    const leave = (stopped: boolean): boolean => {
      if (left) return false
      left = true
      signal?.removeEventListener('abort', onAbort)
      onLeave(stopped)
      return true
    }
    const onAbort = () => { if (leave(true)) reject(abortError(signal!)) }
    signal?.addEventListener('abort', onAbort, { once: true })
    p.then(() => { if (leave(false)) resolve() }, e => { if (leave(false)) reject(e) })
  })
}

/**
 * What the model server has been doing, as it says itself: whether a slot is generating now,
 * and a token that changes whenever a slot runs a new task (`ProcessManager.slotUse`).
 */
export type ServerUse = { processing: boolean; tasks: string }

export type IdleUnloaderDeps = {
  registry: ActivityRegistry
  isRunning: () => boolean
  unload: () => Promise<void>
  idleMs: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  log?: (line: string) => void
  /**
   * Asks the model server what it has been doing; null when it cannot be read.
   *
   * The registry counts CynCo's own work. An app CynCo took the GPU from is answered by CynCo's
   * server meanwhile (local-LLM apps record, decision 3), and its requests never pass through
   * the engine: with only the registry to go by, the model was unloaded under a game in play.
   * Given this, the unloader asks the server when the timer is armed and again when it fires,
   * and keeps the model when a task ran in between or one is running now. A server that cannot
   * be read is unloaded as before, so that an unreadable server never holds the card. Absent,
   * the registry alone decides, at once.
   */
  serverUse?: () => Promise<ServerUse | null>
}

export class IdleUnloader {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Counts the waits begun or ended, so a decision still asking the server knows its wait is over. */
  private waits = 0
  private unsubscribe: (() => void)[] = []
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly deps: IdleUnloaderDeps) {
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
  }

  start(): void {
    if (this.deps.idleMs <= 0) return
    this.unsubscribe.push(this.deps.registry.onBusy(() => this.cancel()))
    this.unsubscribe.push(this.deps.registry.onIdle(() => this.arm()))
    if (this.deps.registry.count() === 0) this.arm()
  }

  stop(): void {
    this.cancel()
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
  }

  private arm(): void {
    this.cancel()
    const wait = this.waits
    // What the server had done when CynCo's own work ended: the last task then is CynCo's own.
    const before = this.askServer()
    this.timer = this.setTimer(() => {
      this.timer = null
      if (this.deps.registry.count() !== 0 || !this.deps.isRunning()) return
      if (before === null) { this.unload(); return }
      void this.decide(wait, before)
    }, this.deps.idleMs)
  }

  /** The timer fired with the registry idle: unload, unless the server answered someone else meanwhile. */
  private async decide(wait: number, before: Promise<ServerUse | null>): Promise<void> {
    const [was, now] = await Promise.all([before, this.askServer()])
    // CynCo's own work began, or began and ended, while the server was being asked: that wait is over.
    if (wait !== this.waits || this.deps.registry.count() !== 0 || !this.deps.isRunning()) return
    if (now === null) this.deps.log?.("[llama-cpp] the model server did not say what it has been doing (/slots) — going by CynCo's own idleness alone")
    if (now !== null && (now.processing || (was !== null && now.tasks !== was.tasks))) {
      this.deps.log?.(`[llama-cpp] CynCo has been idle for ${Math.round(this.deps.idleMs / 60000)} min, but its model server answered a request that was not CynCo's in that time (an app on its port) — keeping the model loaded`)
      this.arm()
      return
    }
    this.unload()
  }

  private unload(): void {
    this.deps.log?.(`[llama-cpp] idle for ${Math.round(this.deps.idleMs / 60000)} min — unloading the model (lazy load brings it back on the next message)`)
    this.deps.unload().catch(e => this.deps.log?.(`[llama-cpp] idle unload failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** The server's own account, or null when there is no way to ask or the asking failed. */
  private askServer(): Promise<ServerUse | null> | null {
    if (!this.deps.serverUse) return null
    return this.deps.serverUse().catch(() => null)
  }

  private cancel(): void {
    this.waits++
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }
}
