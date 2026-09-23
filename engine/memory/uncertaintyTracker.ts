/**
 * Tier-1 uncertainty trace: per-token Shannon entropy over the renormalized
 * top-k logprobs, digested per turn. Thinking and output streams tracked
 * separately. Null digests when the backend supplies no logprobs (D3).
 */
import type { TokenLogprob } from '../types.js'

/**
 * `n` and `sd` are the digest's own sample count and population σ.
 *
 * They were derived and discarded: `spikeCount` is defined as `H > mean + 2σ`
 * and the σ that produced it lived only inside `digest()`. Any consumer asking
 * the SAME question about one particular token — "was this call's tool token a
 * spike for the turn it came from" (vsm/verifyFirst.ts) — had to re-derive σ
 * from `max` and `mean`, which is a guess where the tracker held a measurement.
 *
 * `sd` is optional because an AGGREGATED digest (ThinkingRecorder.aggregateSession,
 * which folds many turns) genuinely cannot recover one without the raw series,
 * and stating a σ nobody measured is the one thing this pipeline never does.
 * `n` is optional for the same class of reason one level back: turn records
 * written to disk before this field existed carry no count, and absent must
 * stay distinguishable from zero. `digest()` below always sets both.
 */
export type EntropyDigest = { mean: number; max: number; spikeCount: number; n?: number; sd?: number }
export type StreamKind = 'thinking' | 'output' | 'tool'

export class UncertaintyTracker {
  private series: Record<StreamKind, number[]> = { thinking: [], output: [], tool: [] }

  /** Entropy H = -Σ p·ln p over the renormalized top alternatives of one token. */
  static entropy(tl: TokenLogprob): number | null {
    if (!tl.top || tl.top.length === 0) return null
    const ps = tl.top.map(t => Math.exp(t.logprob))
    const z = ps.reduce((a, b) => a + b, 0)
    if (!(z > 0)) return null
    let h = 0
    for (const p of ps) {
      const q = p / z
      if (q > 0) h -= q * Math.log(q)
    }
    return h
  }

  observe(kind: StreamKind, logprobs: TokenLogprob[]): void {
    for (const tl of logprobs) {
      const h = UncertaintyTracker.entropy(tl)
      if (h !== null) this.series[kind].push(h)
    }
  }

  /** Per-turn digest; spike = H > mean + 2σ (σ over this turn's series). */
  digest(kind: StreamKind): EntropyDigest | null {
    const xs = this.series[kind]
    if (xs.length === 0) return null
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const max = Math.max(...xs)
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length)
    const spikeCount = xs.filter(x => x > mean + 2 * sd).length
    return { mean, max, spikeCount, n: xs.length, sd }
  }

  /** Raw series for dashboard sparkline batches. */
  values(kind: StreamKind): readonly number[] {
    return this.series[kind]
  }

  reset(): void {
    this.series = { thinking: [], output: [], tool: [] }
  }
}
