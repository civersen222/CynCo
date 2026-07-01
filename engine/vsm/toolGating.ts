/**
 * Deterministic Tool Gating — remove overused tools instead of suggesting variety.
 * Same state = same behavior every run. Reduces 53% run-to-run variance.
 * Cybernetic grounding: Ashby attenuator — reducing regulatory variety to force exploration.
 */

const NEVER_RESTRICT = new Set(['Bash', 'Glob', 'Grep', 'Ls'])
const CONSECUTIVE_THRESHOLD = 4

/**
 * Pure narrowing gate: drop restricted tools from an offered tool set.
 * Never returns an empty set — if narrowing would remove every tool, the
 * original set is returned unchanged (a starved model is worse than a
 * repetitive one). Only ever removes, never adds (Ashby attenuator).
 */
export function applyToolGate<T extends { name: string }>(tools: T[], restricted: string[]): T[] {
  if (restricted.length === 0) return tools
  const block = new Set(restricted)
  const filtered = tools.filter(t => !block.has(t.name))
  return filtered.length > 0 ? filtered : tools
}

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
