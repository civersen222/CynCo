/**
 * Layer convergence: how early in depth the model's answer was settled.
 *
 * The tap reports token IDS; the J-lens readout reports token STRINGS, so the
 * emitted token cannot be compared to a readout without a tokenizer the engine
 * does not hold. The deepest probed layer (56 of 63) stands in for the output:
 * per position, `agree` is the fraction of shallower probed layers whose top-1
 * equals layer 56's, and `depth` the shallowest layer that already agrees.
 * Data only (Phase 2 ruling 1): validated on the ledger before anything reads it.
 */
export type LayerTop = { token: string; p: number }[]

export function convergenceOf(readouts: Map<number, LayerTop>, deepest: number): { agree: number; depth: number } | null {
  const target = readouts.get(deepest)?.[0]?.token
  if (target === undefined) return null
  const shallower = [...readouts.keys()].filter(l => l < deepest).sort((a, b) => a - b)
  if (shallower.length === 0) return null
  let agreeing = 0, depth = deepest
  for (const l of shallower) {
    if (readouts.get(l)?.[0]?.token === target) { agreeing++; if (l < depth) depth = l }
  }
  return { agree: agreeing / shallower.length, depth }
}

export class ConvergenceAccumulator {
  private readonly deepest: number
  private readonly shallower: number[]
  private n = 0
  private agreeSum = 0
  private depthSum = 0
  private byLayerHits: Record<string, number> = {}

  constructor(layers: number[]) {
    const sorted = [...new Set(layers)].sort((a, b) => a - b)
    this.deepest = sorted[sorted.length - 1]
    this.shallower = sorted.slice(0, -1)
    this.reset()
  }

  add(_pos: number, readouts: Map<number, LayerTop>): void {
    const c = convergenceOf(readouts, this.deepest)
    if (!c) return
    this.n++; this.agreeSum += c.agree; this.depthSum += c.depth
    const target = readouts.get(this.deepest)![0].token
    for (const l of this.shallower) if (readouts.get(l)?.[0]?.token === target) this.byLayerHits[String(l)]++
  }

  snapshot(): { n: number; meanAgree: number | null; meanDepth: number | null; byLayer: Record<string, number | null> } {
    const byLayer: Record<string, number | null> = {}
    for (const l of this.shallower) byLayer[String(l)] = this.n ? this.byLayerHits[String(l)] / this.n : null
    return { n: this.n, meanAgree: this.n ? this.agreeSum / this.n : null, meanDepth: this.n ? this.depthSum / this.n : null, byLayer }
  }

  reset(): void {
    this.n = 0; this.agreeSum = 0; this.depthSum = 0
    this.byLayerHits = Object.fromEntries(this.shallower.map(l => [String(l), 0]))
  }
}
