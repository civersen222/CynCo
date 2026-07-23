/**
 * Reasoning/action divergence sensor: the model confidently emits a tool the
 * read-loop gate has disabled. "Confident" = a low-entropy outlier vs the tool
 * stream's own running distribution (not a magic constant), capped below ln(2)
 * so a genuinely flat distribution never counts as a collapse.
 */
export type DivergenceInput = { tool: string; entropy: number; isDisabled: boolean }
export type DivergenceVerdict = { diverged: boolean; tool: string; entropy: number; floor: number }

export class ToolDivergenceDetector {
  private xs: number[] = []
  private static readonly ABS_CAP = Math.log(2)
  // Absolute confidence floor (~0.05 nats ≈ top-token prob ≥ 0.99). A real model
  // (qwen3.6) picks tools with near-zero entropy across the board, so the σ-floor
  // collapses to ~0 and nothing reads as an "outlier". Clamping the floor to never
  // drop below this ensures a genuinely-certain emission of a *disabled* tool still
  // alarms — the reasoning/action divergence we care about — while the ln(2) cap
  // keeps a flat *high*-entropy stream from ever counting as a collapse.
  private static readonly ABS_FLOOR = 0.05

  observeEntropy(h: number): void {
    if (Number.isFinite(h)) this.xs.push(h)
  }

  private floor(): number {
    if (this.xs.length < 3) return ToolDivergenceDetector.ABS_CAP
    const mean = this.xs.reduce((a, b) => a + b, 0) / this.xs.length
    const sd = Math.sqrt(this.xs.reduce((a, x) => a + (x - mean) ** 2, 0) / this.xs.length)
    const sigmaFloor = mean - sd
    return Math.min(
      Math.max(sigmaFloor, ToolDivergenceDetector.ABS_FLOOR),
      ToolDivergenceDetector.ABS_CAP,
    )
  }

  check(input: DivergenceInput): DivergenceVerdict {
    this.observeEntropy(input.entropy)
    const floor = this.floor()
    const diverged = input.isDisabled && input.entropy <= floor
    return { diverged, tool: input.tool, entropy: input.entropy, floor }
  }

  reset(): void { this.xs = [] }
}
