export class DoomLoopDetector {
  private failures = new Map<string, number>()
  private threshold: number
  private lastDetected: string | null = null

  constructor(threshold = 3) {
    this.threshold = threshold
  }

  /**
   * Check if a tool call is in a doom loop.
   * Returns true if the same tool+input has failed >= threshold times consecutively.
   */
  check(toolName: string, inputSummary: string, isError: boolean): boolean {
    const key = `${toolName}:${inputSummary.slice(0, 100)}`

    if (!isError) {
      this.failures.delete(key)
      return false
    }

    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)

    if (count >= this.threshold) {
      this.lastDetected = key
      return true
    }
    return false
  }

  getSuggestion(): string | null {
    if (!this.lastDetected) return null
    return `Doom loop detected: "${this.lastDetected}" has failed ${this.threshold}+ times with the same input. The model has repeated a failing action. Consider: changing approach, reading the error more carefully, or trying a different tool.`
  }

  reset(): void {
    this.failures.clear()
    this.lastDetected = null
  }
}
