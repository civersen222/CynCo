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

  load(path: string): void {
    try {
      const fs = require('fs')
      if (!fs.existsSync(path)) return
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(data)) this.scores.set(k, v as ToolStats)
    } catch (e) { console.log(`[toolScorer] load failed: ${e instanceof Error ? e.message : String(e)}`) }
  }
}
