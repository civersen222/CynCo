/**
 * Verify-first routing — the gate ladder's second verb (Phase 2b-ii).
 *
 * Until now a mission invariant could do exactly one thing with a call: DENY
 * it. A refusal has the same variety as the command it refuses (Ashby), which
 * is why it works — but it is mute about the state of the tree. C8 wave 1 spent
 * its last tool call on `git checkout --`, and the refusal it got said "you may
 * not revert" without ever telling it the one fact that decides what to do
 * instead: is the suite green right now? If it is, there is nothing to undo and
 * the answer is "commit". If it is red, the answer is "fix forward", and the
 * output of the failing check is the most useful thing the engine can hand over.
 *
 * So the regulator gains a second verb. Two call shapes route through KEEP-GREEN
 * (the mission's always-present sidecar assertion, `ContractState.byRole`):
 *
 *   - `revert`              — refused as before (the identity is not negotiable),
 *                             but refused WITH the tree's verdict attached.
 *   - `low-confidence-edit` — executed, then measured: the model was uncertain
 *                             at the moment it emitted the call (tool-token
 *                             entropy), so the edit it just made is the one most
 *                             worth checking, and the verdict is appended to the
 *                             result it reads next.
 *
 * Routing NEVER grants a call that a denial would have refused, and nothing
 * else in the loop branches on entropy. This object's only power is to spend a
 * bounded number of KEEP-GREEN runs and to write sentences.
 *
 * The budget and the cache exist because KEEP-GREEN is a real test command. Six
 * runs per mission, and a result younger than five tool calls with no source
 * edit since is served from cache — a cached answer costs nothing, so it costs
 * no budget either. Past the budget the router answers `budget-exhausted` and
 * the loop falls back to the plain path; the fact that it wanted to verify and
 * could not is still recorded, because a regulator that quietly stops
 * regulating is exactly the failure the invariants' own relent logging exists
 * to make visible.
 */

export type RouteKind = 'revert' | 'low-confidence-edit'

/**
 * `passed`/`failed`/`timeout`/`unrunnable` are what the command established
 * (`CommandOutcome` in tools/contractVerify.ts, same words on purpose).
 * `cached-*` is the same verdict re-served without paying for it again, and
 * `budget-exhausted` is the router declining to run at all — recorded, never
 * silent.
 */
export type VerifyOutcome =
  | 'passed' | 'failed' | 'timeout' | 'unrunnable'
  | 'cached-passed' | 'cached-failed' | 'budget-exhausted'

/** One routing decision and what came of it. */
export interface RouteEntry {
  /** The loop's tool-call index (`toolCallsTotal`) for the call that routed. */
  callIndex: number
  kind: RouteKind
  /** The call's tool-token entropy in nats, or null when the backend gave none. */
  entropy: number | null
  outcome: VerifyOutcome
  /** Wall-clock ms the command took. 0 when nothing ran; the ORIGINAL run's
   *  duration on a cached entry — a cached entry quotes the measurement that
   *  was made rather than inventing a fresh one. */
  ms: number
  /** Last lines the command printed (bounded by the runner). '' when none. */
  tail: string
  /** What the NEXT observed tool call was, per `classifyCall`. Null until that
   *  call happens — the same outcome record a denial carries, and for the same
   *  reason: "did the intervention change what the model did next" is the only
   *  question the falsification programme can ask of it. */
  nextCallClass: string | null
}

/** What a KEEP-GREEN run reports. Structurally `CommandRunDetail` (Task 5). */
export interface VerifyRun {
  outcome: 'passed' | 'failed' | 'timeout' | 'unrunnable'
  ms: number
  tail: string
}

/**
 * The tool-token entropy digest the low-confidence rule reads.
 *
 * Structurally `EntropyDigest` (memory/uncertaintyTracker.ts). `n` and `sd` are
 * optional here so an aggregated digest — which knows how many samples it
 * covers but cannot recover their σ without the raw series — can be passed in
 * without inventing one.
 */
export interface VerifyDigest {
  mean: number
  max: number
  spikeCount: number
  /** Samples behind `mean`/`max`. Absent means "unknown", which is < the floor. */
  n?: number
  /** Population σ over the same samples, when the digest measured one. */
  sd?: number
}

export interface VerifyFirstOpts {
  /** KEEP-GREEN runs allowed per mission. Default `DEFAULT_VERIFY_BUDGET`. */
  budget?: number
  /** How many tool calls a cached verdict stays usable for. Default `DEFAULT_COOLDOWN_CALLS`. */
  cooldownCalls?: number
  /** Runs KEEP-GREEN in `cwd`. Supplied by the loop as
   *  `runCommandDetailed(cwd, assertion.command, assertion.timeoutMs)`. */
  run: (cwd: string) => Promise<VerifyRun>
}

export interface VerifyFirstSnapshot {
  budget: number
  /** KEEP-GREEN runs actually spent. Cached and refused routes cost nothing. */
  used: number
  /** Last `ENTRY_WINDOW` entries. `count` is how many there have been. */
  entries: RouteEntry[]
  count: number
  /** Over ALL routes, not the window. */
  byKind: Record<RouteKind, number>
  /** Over ALL routes, not the window. Every outcome key is present, so a row
   *  that never timed out says zero rather than saying nothing. */
  byOutcome: Record<string, number>
}

/** Six KEEP-GREEN runs per mission: enough to answer the calls that matter,
 *  few enough that a slow suite cannot eat the mission's wall clock. */
export const DEFAULT_VERIFY_BUDGET = 6
/** A verdict describes a tree. Five tool calls later it is still plausibly the
 *  same tree — unless a source edit landed, which invalidates it outright. */
export const DEFAULT_COOLDOWN_CALLS = 5
/**
 * The ceiling on ONE routed KEEP-GREEN run, whatever the assertion says.
 *
 * A routed run happens in the middle of the model's turn: the model is waiting
 * on a tool result it has already earned, and every second of the check is a
 * second of the mission's wall clock. The assertion's own `timeoutMs` is sized
 * for a different job — the end-of-run contract check, which may legitimately
 * be a thirty-minute mutation sweep (Gilded Wave 9d) and which keeps its own
 * budget untouched. Six routed runs at that cap would be three hours of a
 * mission spent inside a gate nobody asked to run.
 *
 * Five minutes is the engine's own default check timeout
 * (`commandTimeoutMs`), so a KEEP-GREEN command that fits the default fits
 * here unchanged; anything slower is bounded rather than obeyed.
 */
export const ROUTING_TIMEOUT_MS = 300_000

/**
 * The timeout ONE routed run may use, given whatever the assertion asked for.
 *
 * A helper rather than an inline `Math.min` at the construction site so the
 * clamp is testable on its own and cannot drift if a second caller ever routes.
 * An absent, zero, negative or non-finite value falls back to the cap — the
 * same rule `commandTimeoutMs` applies to a bad value: ignored, not obeyed.
 */
export function routingTimeoutMs(assertionTimeoutMs?: number): number {
  const wanted = Number(assertionTimeoutMs)
  return Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, ROUTING_TIMEOUT_MS) : ROUTING_TIMEOUT_MS
}
/** Low-confidence floor (nats) when there is no usable digest to be relative to. */
export const ENTROPY_FLOOR = 1.0
/** Below this many samples a digest's σ is noise, so the flat floor is used. */
export const DIGEST_MIN_SAMPLES = 8
/** Entries carried on the per-turn status frame (the counts carry the rest). */
export const ENTRY_WINDOW = 20

const ALL_OUTCOMES: VerifyOutcome[] = [
  'passed', 'failed', 'timeout', 'unrunnable', 'cached-passed', 'cached-failed', 'budget-exhausted',
]

export class VerifyFirstRouter {
  private readonly budget: number
  private readonly cooldownCalls: number
  private readonly run: (cwd: string) => Promise<VerifyRun>
  private used = 0
  private count = 0
  private readonly byKind: Record<RouteKind, number> = { revert: 0, 'low-confidence-edit': 0 }
  private readonly byOutcome: Record<string, number> = Object.fromEntries(ALL_OUTCOMES.map(o => [o, 0]))
  /** The window, not the history — see `ENTRY_WINDOW`. */
  private readonly recent: RouteEntry[] = []
  /** The last verdict a command actually gave, and the call it was given on. */
  private cache: { outcome: 'passed' | 'failed'; ms: number; tail: string; atCall: number } | null = null

  constructor(opts: VerifyFirstOpts) {
    this.run = opts.run
    this.budget = Number.isFinite(opts.budget) && (opts.budget as number) >= 0
      ? (opts.budget as number)
      : DEFAULT_VERIFY_BUDGET
    this.cooldownCalls = Number.isFinite(opts.cooldownCalls) && (opts.cooldownCalls as number) >= 0
      ? (opts.cooldownCalls as number)
      : DEFAULT_COOLDOWN_CALLS
  }

  /**
   * Was the model uncertain when it emitted this call?
   *
   * The rule, stated once and in one place:
   *
   *   n >= DIGEST_MIN_SAMPLES (8):  entropy > mean + 2σ
   *   otherwise:                    entropy > ENTROPY_FLOOR (1.0 nats)
   *
   * σ comes from the digest when the digest measured one — that is the SAME
   * definition `UncertaintyTracker.digest` uses for `spikeCount`, so "low
   * confidence" here means exactly "this call's tool token was a spike for the
   * model call it came from". When the digest carries no σ (an aggregated
   * digest, which cannot recover one without the raw series) the fallback is
   * `(max - mean) / 2`: a crude stand-in, said out loud rather than presented
   * as a measurement.
   *
   * The two-arm shape is the point. Under eight samples a σ is noise and a
   * relative test fires on nothing; the flat floor is the honest reading then.
   * Over eight, an absolute floor is the wrong instrument — a model that is
   * uniformly uncertain would trip it on every call, and a model that is
   * uniformly certain would never trip it however sharply this one call spiked.
   */
  isLowConfidence(entropy: number | null, digest: VerifyDigest | null): boolean {
    if (entropy === null || !Number.isFinite(entropy)) return false
    const n = digest && Number.isFinite(digest.n as number) ? Number(digest.n) : 0
    if (!digest || n < DIGEST_MIN_SAMPLES) return entropy > ENTROPY_FLOOR
    const sd = Number.isFinite(digest.sd as number) ? Number(digest.sd) : (digest.max - digest.mean) / 2
    return entropy > digest.mean + 2 * sd
  }

  /**
   * Route one call through KEEP-GREEN and record what happened.
   *
   * Order is cache, then budget, then run: a cached verdict is free, so it is
   * served even by a router that has spent everything. The entry is returned
   * AND retained — the caller writes the model's sentence from it, the ledger
   * reads the retained copy.
   */
  async verify(cwd: string, callIndex: number, kind: RouteKind, entropy: number | null): Promise<RouteEntry> {
    const cached = this.cache
    if (cached && callIndex - cached.atCall < this.cooldownCalls) {
      return this.record({
        callIndex, kind, entropy,
        outcome: cached.outcome === 'passed' ? 'cached-passed' : 'cached-failed',
        ms: cached.ms, tail: cached.tail, nextCallClass: null,
      })
    }
    if (this.used >= this.budget) {
      return this.record({ callIndex, kind, entropy, outcome: 'budget-exhausted', ms: 0, tail: '', nextCallClass: null })
    }
    this.used++
    let result: VerifyRun
    try {
      result = await this.run(cwd)
    } catch (err) {
      // The runner is the engine's own `runCommandDetailed`, which resolves
      // rather than rejects — but this object must not be the reason a turn
      // dies, so a throw becomes the outcome that already means "no answer".
      const detail = err instanceof Error ? err.message : String(err)
      console.log(`[verify-first] KEEP-GREEN could not be run: ${detail}`)
      result = { outcome: 'unrunnable', ms: 0, tail: detail }
    }
    // Only an answer is cached. A timeout and an unrunnable command said
    // nothing, and caching "nothing" would suppress the next real attempt.
    if (result.outcome === 'passed' || result.outcome === 'failed') {
      this.cache = { outcome: result.outcome, ms: result.ms, tail: result.tail, atCall: callIndex }
    }
    return this.record({ callIndex, kind, entropy, outcome: result.outcome, ms: result.ms, tail: result.tail, nextCallClass: null })
  }

  /**
   * Account one observed tool call.
   *
   * Two jobs. It fills the oldest still-open entry's `nextCallClass` — but
   * never from the routed call's OWN accounting, which is why `callIndex` is
   * worth passing: the revert branch verifies before the call is accounted and
   * the executed-edit branch verifies after, so "the next call" cannot be
   * derived from ordering alone. And a `sourceEdit` drops the cache: the tree
   * the cached verdict described no longer exists.
   *
   * `callIndex` is optional so the object is usable without the loop's
   * counter; omitted, the oldest open entry is closed by the next call to
   * arrive, whichever call that is.
   */
  observeCall(cls: string, callIndex?: number): void {
    const open = this.recent.find(e => e.nextCallClass === null && e.callIndex !== callIndex)
    if (open) open.nextCallClass = cls
    if (cls === 'sourceEdit') this.cache = null
  }

  snapshot(): VerifyFirstSnapshot {
    return {
      budget: this.budget,
      used: this.used,
      entries: this.recent.map(e => ({ ...e })),
      count: this.count,
      byKind: { ...this.byKind },
      byOutcome: { ...this.byOutcome },
    }
  }

  private record(entry: RouteEntry): RouteEntry {
    this.count++
    this.byKind[entry.kind] = (this.byKind[entry.kind] ?? 0) + 1
    this.byOutcome[entry.outcome] = (this.byOutcome[entry.outcome] ?? 0) + 1
    this.recent.push(entry)
    while (this.recent.length > ENTRY_WINDOW) this.recent.shift()
    return entry
  }
}

/**
 * The sentence a refused revert carries, or null when there is nothing honest
 * to say.
 *
 * `budget-exhausted` returns null on purpose: nothing was measured, and the
 * refusal falls back to the plain identity message rather than telling the
 * model about an internal budget it can neither see nor change. A `timeout` or
 * an `unrunnable` command DID happen to this run and the model is entitled to
 * know the gate could not answer — that is a fact about the workspace, not
 * about the regulator's bookkeeping.
 */
export function verifySentence(v: RouteEntry | null | undefined): string | null {
  if (!v) return null
  switch (v.outcome) {
    case 'passed':
    case 'cached-passed':
      return '[verify-first] KEEP-GREEN is green as the tree stands: there is nothing to undo — commit instead.'
    case 'failed':
    case 'cached-failed':
      return '[verify-first] KEEP-GREEN is red as the tree stands — fix forward, never back. Last lines:\n' + v.tail
    case 'timeout':
    case 'unrunnable':
      return `[verify-first] KEEP-GREEN could not be run (${v.outcome}).`
    case 'budget-exhausted':
      return null
  }
}

/**
 * The note appended to a low-confidence edit's own result, or null when nothing
 * was measured (see `verifySentence` on `budget-exhausted`).
 *
 * Seconds, not milliseconds: the number is there to tell the model whether the
 * suite it just perturbed is cheap or expensive to re-run, and a millisecond
 * count reads as precision nobody needs.
 */
export function verifyEditNote(v: RouteEntry | null | undefined): string | null {
  if (!v) return null
  switch (v.outcome) {
    case 'passed':
    case 'cached-passed':
      return `[verify-first] KEEP-GREEN after this edit: PASS (${(v.ms / 1000).toFixed(0)} s)`
    case 'failed':
    case 'cached-failed':
      return '[verify-first] KEEP-GREEN after this edit: FAIL — last lines:\n' + v.tail
    case 'timeout':
    case 'unrunnable':
      return `[verify-first] KEEP-GREEN could not be run (${v.outcome}).`
    case 'budget-exhausted':
      return null
  }
}
