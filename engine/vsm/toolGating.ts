/**
 * Deterministic Tool Gating — remove overused tools instead of suggesting variety.
 * Same state = same behavior every run. Reduces 53% run-to-run variance.
 * Cybernetic grounding: Ashby attenuator — reducing regulatory variety to force exploration.
 */

const NEVER_RESTRICT = new Set(['Bash', 'Glob', 'Grep', 'Ls'])
/**
 * Never attenuated in a project chat, beside NEVER_RESTRICT (F178). A project
 * chat reads files to answer, and `ReadLoopGate` already governs a redundant
 * re-read; withholding Read while Bash stays offered only moves the reads to
 * the shell. A coding session or a mission attenuates Read as before.
 */
const PROJECT_CHAT_NEVER_RESTRICT = new Set(['Read'])
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
  /** Tools already counted in this model call; null until a caller marks a call. */
  private countedThisCall: Set<string> | null = null

  /**
   * Mark the start of a model call's tool batches. From then on a tool counts
   * at most once per call: the calls the model fired together are one decision,
   * so four Reads in one parallel batch (reading four files) are one use, not
   * four in a row (F178). A caller that never marks a call counts every use.
   */
  beginCall(): void {
    this.countedThisCall = new Set()
  }

  recordTool(toolName: string): void {
    if (this.countedThisCall) {
      if (this.countedThisCall.has(toolName)) return
      this.countedThisCall.add(toolName)
    }
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

  /** `projectChat`: the session is a project chat, where Read is never attenuated (PROJECT_CHAT_NEVER_RESTRICT). */
  getRestrictedTools(opts?: { projectChat?: boolean }): string[] {
    const exempt = (tool: string) => NEVER_RESTRICT.has(tool) || (opts?.projectChat === true && PROJECT_CHAT_NEVER_RESTRICT.has(tool))
    const restricted: string[] = []
    if (this.recentTools.length >= CONSECUTIVE_THRESHOLD) {
      const last = this.recentTools.slice(-CONSECUTIVE_THRESHOLD)
      if (last.every(t => t === last[0]) && !exempt(last[0])) {
        restricted.push(last[0])
      }
    }
    if (this.stuckCount >= 2 && this.stuckTool && !exempt(this.stuckTool)) {
      if (!restricted.includes(this.stuckTool)) restricted.push(this.stuckTool)
    }
    return restricted
  }
}
