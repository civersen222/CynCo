/**
 * engine/providers/streamWatchdog.ts — the stall clock every streamed model
 * request runs under (F235), whichever server answers it.
 *
 * It was built in the llama.cpp provider after 2026-11-14 and lived there. The
 * Ollama provider read its stream with the caller's signal and nothing else, so
 * the default profile's provider and the busy fallback had no limit at all.
 * Both providers now use this one clock with the same limits.
 */

/**
 * How long a streamed request may go without a byte from the model server
 * before it is cut. Two phases, because a server is silent for two different
 * reasons:
 *
 * - Before the first byte it is processing the prompt: a server answers a
 *   streamed request only once its first token exists. A cold 131k-token
 *   prefill on this PC runs about 1,400 tokens/s, under two minutes, so twenty
 *   is far past anything legitimate. The lazy llama.cpp model load is NOT
 *   inside this clock: `ensureReady` runs first and has its own wait
 *   (`maxWaitMs`). Ollama loads a model inside the request, in seconds to a
 *   minute or two, which twenty minutes also covers.
 * - After the first byte it is generating, a chunk every ~12 ms at ~80 tokens/s.
 *   Ten minutes without one is a server that has stopped. On 2026-11-14 the t5
 *   wave's generation finished its thinking, sent one token of its answer and
 *   then nothing for 73 minutes, holding its only slot, and nothing timed out.
 *
 * A cut aborts the request (a server cancels a task whose client has gone,
 * which frees the slot) and throws a non-retryable `StreamStalledError`, so the
 * turn ends through the loop's error path (`session.error`) instead of waiting
 * out a mission's wall clock.
 */
export const STREAM_FIRST_BYTE_MS = 20 * 60_000
export const STREAM_IDLE_MS = 10 * 60_000

/** A streamed request that the model server stopped answering (F235). Deliberately no `code`: never retried. */
export class StreamStalledError extends Error {
  constructor(readonly phase: 'first-byte' | 'mid-stream', readonly silentMs: number, server = 'llama-server') {
    super(phase === 'first-byte'
      ? `${server} sent nothing for ${Math.round(silentMs / 1000)}s after the request (no first token); the request was cancelled (F235)`
      : `${server} stopped sending mid-reply: nothing for ${Math.round(silentMs / 1000)}s; the request was cancelled (F235)`)
    this.name = 'StreamStalledError'
  }
}

/** What `modelSilence` answers: the request in flight, how long its server has sent nothing, and the limit it runs under. */
export type ModelSilence = { phase: 'first-byte' | 'mid-stream'; silentMs: number; limitMs: number; server: string }

/**
 * The requests whose first byte or next chunk is being waited for right now. Module state, and
 * written by the clock alone: a clock joins when it is armed and leaves when its request ends
 * (`dispose`) or when it cuts the request. Read by `modelSilence`.
 */
const waiting = new Set<StreamWatchdog>()

/**
 * How long the model server has been silent on the request in flight, or null when none is.
 * With several in flight (a sub-agent beside a turn) it is the one silent longest. The
 * dashboard carries it on `/api/session`, so a chat that shows nothing for minutes can say
 * that the model is being waited for, for how long, and when the engine will give up.
 */
export function modelSilence(now: number = Date.now()): ModelSilence | null {
  let longest: ModelSilence | null = null
  for (const w of waiting) {
    const s = w.silence(now)
    if (s !== null && (longest === null || s.silentMs > longest.silentMs)) longest = s
  }
  return longest
}

/**
 * The stall clock for one streamed request: its own abort signal (also
 * aborted by the caller's, so a Stop still ends it), armed with the first-byte
 * limit and re-armed with the idle limit on every chunk. `stalled` says which
 * limit fired, so a rejection can be told apart from a Stop. `who` names the
 * server in the error and the engine-log line.
 */
export class StreamWatchdog {
  private readonly ctrl = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly onParentAbort: () => void
  stalled: StreamStalledError | null = null
  /** What is being waited for and since when; null before the request is sent and after it ends. */
  private wait: { phase: 'first-byte' | 'mid-stream'; since: number; limitMs: number } | null = null

  constructor(
    private readonly parent: AbortSignal | undefined,
    private readonly firstByteMs: number,
    private readonly idleMs: number,
    private readonly who: { server: string; logTag: string } = { server: 'llama-server', logTag: 'llama-cpp' },
  ) {
    this.onParentAbort = () => this.ctrl.abort(parent?.reason)
    if (parent?.aborted) this.ctrl.abort(parent.reason)
    else parent?.addEventListener('abort', this.onParentAbort, { once: true })
  }

  get signal(): AbortSignal { return this.ctrl.signal }

  private arm(ms: number, phase: 'first-byte' | 'mid-stream'): void {
    if (this.timer) clearTimeout(this.timer)
    this.wait = { phase, since: Date.now(), limitMs: ms }
    waiting.add(this)
    this.timer = setTimeout(() => {
      // Cut: the request is over, so it is no longer something being waited for.
      this.wait = null
      waiting.delete(this)
      this.stalled = new StreamStalledError(phase, ms, this.who.server)
      console.log(`[${this.who.logTag}] ${this.stalled.message}`)
      this.ctrl.abort(this.stalled)
    }, ms)
  }

  /** Before each request is sent. */
  waitFirstByte(): void { this.arm(this.firstByteMs, 'first-byte') }
  /** On every chunk of the body. */
  sawData(): void { this.arm(this.idleMs, 'mid-stream') }

  /** This request's silence as of `now`, or null when nothing is being waited for. */
  silence(now: number): ModelSilence | null {
    if (this.wait === null) return null
    return { phase: this.wait.phase, silentMs: Math.max(0, now - this.wait.since), limitMs: this.wait.limitMs, server: this.who.server }
  }

  dispose(): void {
    this.wait = null
    waiting.delete(this)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.parent?.removeEventListener('abort', this.onParentAbort)
  }
}
