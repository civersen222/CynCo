type ToolStats = { successes: number; total: number }

export class ToolScorer {
  private scores = new Map<string, ToolStats>()
  private demotionThreshold: number = 0.35

  setDemotionThreshold(threshold: number): void {
    this.demotionThreshold = Math.max(0, Math.min(1, threshold))
  }

  getDemotionThreshold(): number {
    return this.demotionThreshold
  }

  record(toolName: string, success: boolean): void {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    stats.total++
    if (success) stats.successes++
    this.scores.set(toolName, stats)
  }

  getConfidence(toolName: string): number {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    return (stats.successes + 1) / (stats.total + 2)
  }

  shouldDemote(toolName: string): boolean {
    const stats = this.scores.get(toolName)
    if (!stats || stats.total < 3) return false
    return this.getConfidence(toolName) < this.demotionThreshold
  }

  getDemotedTools(): string[] {
    return [...this.scores.keys()].filter(t => this.shouldDemote(t))
  }

  save(path: string): void {
    const data: Record<string, ToolStats> = {}
    for (const [k, v] of this.scores) data[k] = v
    try {
      const fs = require('fs')
      fs.mkdirSync(require('path').dirname(path), { recursive: true })
      fs.writeFileSync(path, JSON.stringify(data, null, 2))
    } catch (e) { console.log(`[toolScorer] save failed: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /**
   * Restore the store, halving every count as it comes in.
   *
   * Without the decay this was a lifetime tally, and demotion made it an
   * absorbing state: a demoted tool is filtered out of the tool list, so it is
   * never called, so `record` never runs again, so the ratio that demoted it
   * can never move. MultiEdit sat at 0/5 in the live store — permanently and
   * silently removed from the agent's capabilities, across every future
   * session, with no path back. An estimate no new evidence can reach is not a
   * measurement; it is a verdict.
   *
   * Halving also makes the estimate recency-weighted, which is the honest shape
   * for this quantity: tool implementations get fixed, and failures recorded
   * against a version that no longer exists should not still be counted.
   *
   * A tool that is genuinely broken re-demotes within a few calls, so the cost
   * of forgiving is bounded. It fails toward "offer the tool", which is the
   * safe direction — a wrong demotion silently costs a capability, while a
   * wrong promotion costs one failed call the model can see and recover from.
   */
  load(path: string): void {
    try {
      const fs = require('fs')
      if (!fs.existsSync(path)) return
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(data)) {
        const { successes, total } = v as ToolStats
        this.scores.set(k, {
          successes: Math.floor(successes / 2),
          total: Math.floor(total / 2),
        })
      }
    } catch (e) { console.log(`[toolScorer] load failed: ${e instanceof Error ? e.message : String(e)}`) }
  }
}
