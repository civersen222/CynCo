/**
 * engine/loopWatch.ts — the engine says when its event loop was blocked (F225).
 *
 * Everything the engine answers, it answers from one loop: the dashboard, the
 * phone, a Stop, the model's stream. Synchronous work holds all of it. F144 was
 * a synchronous `git` on every dashboard poll; on 2026-11-12 the dashboard did
 * not answer for 20 s after the first turn on a freshly loaded model, and that
 * one could not be placed afterwards, because the log carries no times and
 * nothing in it says the loop stopped. Measured candidates on a quiet machine
 * blocked for 0.07 to 0.25 s each; none came near it.
 *
 * So the loop is watched: a timer that should fire every `tickMs` and arrives
 * later than `thresholdMs` was kept waiting by synchronous work. One log line
 * says how long and when it ended; what ran is the lines the engine printed
 * just above it. A timer that is seconds late costs nothing while the loop is
 * healthy, and there is no switch: it is one unref'd timer and one line.
 */

export type LoopWatchOpts = {
  /** How often the loop is looked at. */
  tickMs?: number
  /** A tick later than this is reported. */
  thresholdMs?: number
  /** A monotonic clock in ms. */
  now?: () => number
  wallClock?: () => Date
  log?: (line: string) => void
}

const DEFAULT_TICK_MS = 100
const DEFAULT_THRESHOLD_MS = 1000
/** Longer than any synchronous work the engine does: the PC was more likely suspended. */
const ASLEEP_MS = 5 * 60_000

/** The measurement, with the timer left to the caller: `tick()` is called every `tickMs` by `startLoopWatch`. */
export function createLoopWatch(opts: LoopWatchOpts = {}): { tick: () => void } {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS
  const now = opts.now ?? (() => performance.now())
  const wallClock = opts.wallClock ?? (() => new Date())
  const log = opts.log ?? console.log
  let last = now()
  return {
    tick: () => {
      const at = now()
      const late = at - last - tickMs
      last = at
      if (late < thresholdMs) return
      const until = wallClock().toISOString().slice(11, 19)
      const asleep = late >= ASLEEP_MS ? ' (or the PC was asleep)' : ''
      log(`[engine] the event loop was blocked for ${(late / 1000).toFixed(1)} s${asleep}, until ${until}Z: nothing was answered meanwhile (the dashboard, the phone, a Stop). What ran is in the lines just above.`)
    },
  }
}

/** Watch this process's event loop until `stop()`. The timer does not keep the process alive. */
export function startLoopWatch(opts: LoopWatchOpts = {}): { stop: () => void } {
  const watch = createLoopWatch(opts)
  const timer = setInterval(watch.tick, opts.tickMs ?? DEFAULT_TICK_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer) }
}
