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

  observeEntropy(h: number): void {
    if (Number.isFinite(h)) this.xs.push(h)
  }

  private floor(): number {
    if (this.xs.length < 3) return ToolDivergenceDetector.ABS_CAP
    const mean = this.xs.reduce((a, b) => a + b, 0) / this.xs.length
    const sd = Math.sqrt(this.xs.reduce((a, x) => a + (x - mean) ** 2, 0) / this.xs.length)
    return Math.min(mean - sd, ToolDivergenceDetector.ABS_CAP)
  }

  check(input: DivergenceInput): DivergenceVerdict {
    this.observeEntropy(input.entropy)
    const floor = this.floor()
    const diverged = input.isDisabled && input.entropy <= floor
    return { diverged, tool: input.tool, entropy: input.entropy, floor }
  }

  reset(): void { this.xs = [] }
}
