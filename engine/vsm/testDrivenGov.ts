const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const TEST_TOOLS = new Set(['Bash'])
const EDIT_THRESHOLD = 3

export class TestDrivenGovernor {
  private consecutiveEdits = 0
  private _forcing = false
  private history: { tool: string; wasForced: boolean; timestamp: number }[] = []

  recordToolCall(toolName: string): void {
    if (EDIT_TOOLS.has(toolName)) {
      this.consecutiveEdits++
    } else if (TEST_TOOLS.has(toolName)) {
      this.consecutiveEdits = 0
      this._forcing = false
    }
    this.history.push({ tool: toolName, wasForced: this._forcing, timestamp: Date.now() })
  }

  shouldForceTests(): boolean {
    return this.consecutiveEdits >= EDIT_THRESHOLD
  }

  getBlockedTools(): string[] {
    if (!this.shouldForceTests()) return []
    this._forcing = true
    return ['Edit', 'Write', 'MultiEdit']
  }

  getTestDirective(): string {
    return `You have made ${this.consecutiveEdits} edits without running tests. Run the test suite now to verify your changes before making more edits.`
  }

  getHistory() { return this.history }
}
