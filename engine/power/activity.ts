/**
 * engine/power/activity.ts — one "busy" signal per process.
 *
 * Turns (ConversationLoop), one-shot children (daemon TaskRunner) and
 * in-flight model requests (LlamaCppProvider) register here. Two consumers
 * read the count: the idle-unload timer (engine/llama/lazyLoad.ts) runs
 * only while nothing is open, and hold-awake (engine/power/awake.ts) keeps
 * the PC from sleeping while anything is. Edges only: `onBusy` fires on
 * 0→1, `onIdle` on 1→0. Design: docs/decisions/2026-11-08-wakefulness-design.md.
 */

export type ActivityKind = 'turn' | 'request' | 'oneshot' | 'picture'

export type ActivitySnapshot = { kind: ActivityKind; label?: string; since: number }

export class ActivityRegistry {
  private open = new Map<number, ActivitySnapshot>()
  private nextId = 1
  private busyListeners = new Set<() => void>()
  private idleListeners = new Set<() => void>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Register an open activity; the returned `end` is idempotent. */
  begin(kind: ActivityKind, label?: string): () => void {
    const id = this.nextId++
    this.open.set(id, { kind, ...(label !== undefined ? { label } : {}), since: this.now() })
    if (this.open.size === 1) for (const cb of this.busyListeners) cb()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.open.delete(id)
      if (this.open.size === 0) for (const cb of this.idleListeners) cb()
    }
  }

  count(): number {
    return this.open.size
  }

  snapshot(): ActivitySnapshot[] {
    return [...this.open.values()]
  }

  onBusy(cb: () => void): () => void {
    this.busyListeners.add(cb)
    return () => { this.busyListeners.delete(cb) }
  }

  onIdle(cb: () => void): () => void {
    this.idleListeners.add(cb)
    return () => { this.idleListeners.delete(cb) }
  }
}

/** The process-wide registry every consumer and producer shares. */
export const activity = new ActivityRegistry()
