/**
 * Tier-1 uncertainty trace: per-token Shannon entropy over the renormalized
 * top-k logprobs, digested per turn. Thinking and output streams tracked
 * separately. Null digests when the backend supplies no logprobs (D3).
 */
import type { TokenLogprob } from '../types.js'

export type EntropyDigest = { mean: number; max: number; spikeCount: number }
export type StreamKind = 'thinking' | 'output'

export class UncertaintyTracker {
  private series: Record<StreamKind, number[]> = { thinking: [], output: [] }

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
    return { mean, max, spikeCount }
  }

  /** Raw series for dashboard sparkline batches. */
  values(kind: StreamKind): readonly number[] {
    return this.series[kind]
  }

  reset(): void {
    this.series = { thinking: [], output: [] }
  }
}
