/**
 * Deterministic Tool Gating — remove overused tools instead of suggesting variety.
 * Same state = same behavior every run. Reduces 53% run-to-run variance.
 * Cybernetic grounding: Ashby attenuator — reducing regulatory variety to force exploration.
 */

const NEVER_RESTRICT = new Set(['Bash', 'Glob', 'Grep', 'Ls'])
const CONSECUTIVE_THRESHOLD = 4

export class ToolGating {
  private recentTools: string[] = []
  private stuckTool: string | null = null
  private stuckCount = 0

  recordTool(toolName: string): void {
    this.recentTools.push(toolName)
    if (this.recentTools.length > 10) this.recentTools = this.recentTools.slice(-10)
    if (toolName !== this.stuckTool) {
      this.stuckTool = null
      this.stuckCount = 0
    }
  }

  recordStuckTurn(lastTool: string): void {
    if (lastTool === this.stuckTool) {
      this.stuckCount++
    } else {
      this.stuckTool = lastTool
      this.stuckCount = 1
    }
  }

  getRestrictedTools(): string[] {
    const restricted: string[] = []
    if (this.recentTools.length >= CONSECUTIVE_THRESHOLD) {
      const last = this.recentTools.slice(-CONSECUTIVE_THRESHOLD)
      if (last.every(t => t === last[0]) && !NEVER_RESTRICT.has(last[0])) {
        restricted.push(last[0])
      }
    }
    if (this.stuckCount >= 2 && this.stuckTool && !NEVER_RESTRICT.has(this.stuckTool)) {
      if (!restricted.includes(this.stuckTool)) restricted.push(this.stuckTool)
    }
    return restricted
  }
}
