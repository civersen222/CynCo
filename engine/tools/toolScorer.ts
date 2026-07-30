type ToolStats = { successes: number; total: number }

/**
 * Iterations a demoted tool sits out before it is offered once more.
 *
 * Small on purpose. The quantity being estimated is "does this tool work right
 * now", and the only way to learn it is to let the model call the tool, so a
 * long exclusion is a long stretch of not measuring the thing.
 */
const PROBATION_INTERVAL = 4

export class ToolScorer {
  private scores = new Map<string, ToolStats>()
  private demotionThreshold: number = 0.35
  /** Iterations served, per tool, since it was last offered. */
  private served = new Map<string, number>()
  private probation: string[] = []

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

  /**
   * The tools to withhold from THIS iteration, advancing each one's probation.
   *
   * `load` already forgives a demoted tool across a process restart, and the
   * reasoning there — an estimate no new evidence can reach is a verdict, not a
   * measurement — applies just as much inside one session, because a session is
   * a whole mission. Nothing re-offered a tool within a session, so once the
   * ratio crossed the threshold it stayed crossed for the rest of the run.
   *
   * Measured on Gilded UI Wave 1: Bash reached 2 successes of 8 — confidence
   * 0.30, under the 0.35 threshold — and `[trust] Demoted tools excluded: Bash`
   * printed on 31 consecutive iterations. The task's own contract assertion was
   * "the verification command exits 0", which needs a shell.
   *
   * The same run also measured why that was survivable, and it is not a
   * reassuring reason: Bash executed five times *during* the exclusion window.
   * Withholding only removes a tool from the advertised list — the model can
   * still name it and the executor still runs it. So the exclusion's real effect
   * was to describe the toolset inaccurately to the model while restricting
   * nothing, and the estimate kept moving only through that gap. Enforcing the
   * exclusion without a way back would turn this into the absorbing state the
   * `load` comment already argues against.
   *
   * So a demoted tool serves PROBATION_INTERVAL iterations and is then offered
   * once. If the model calls it and succeeds, the estimate moves and the
   * exclusion is over; if it fails, the tool is withheld again and forgiving it
   * cost exactly one call. That asymmetry is deliberate and matches `load`: a
   * wrong exclusion silently costs a capability for a whole mission, while a
   * wrong offer costs one failed call the model can see and recover from.
   *
   * Advances state, so it is called once per iteration. `getDemotedTools` stays
   * a pure query for readers that only want to report the set.
   */
  excludeForIteration(): string[] {
    const excluded: string[] = []
    const offered: string[] = []
    for (const tool of this.getDemotedTools()) {
      const served = (this.served.get(tool) ?? 0) + 1
      if (served >= PROBATION_INTERVAL) {
        this.served.set(tool, 0)
        offered.push(tool)
      } else {
        this.served.set(tool, served)
        excluded.push(tool)
      }
    }
    // A tool that climbed back over the threshold starts its next probation from
    // zero rather than inheriting credit for iterations it sat out while broken.
    for (const tool of [...this.served.keys()]) {
      if (!this.shouldDemote(tool)) this.served.delete(tool)
    }
    this.probation = offered
    return excluded
  }

  /** Demoted tools offered on probation by the last `excludeForIteration`. */
  probationTools(): string[] {
    return [...this.probation]
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
