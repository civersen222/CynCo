/**
 * Catches a model repeating a tool call that keeps failing.
 *
 * The hard part is that repetition is also how correct work looks. TDD's inner
 * loop is: run the failing test, edit the code, run THE SAME COMMAND again.
 * The input is identical by design. What separates iteration from thrashing is
 * not the call — it is whether anything changed in between. See finding (t):
 * this detector halted a run at turn 64 for doing exactly what its brief
 * ordered, because it could only be cleared by the failing call succeeding.
 */
export class DoomLoopDetector {
  private failures = new Map<string, number>()
  private threshold: number
  private lastDetected: string | null = null

  constructor(threshold = 3) {
    this.threshold = threshold
  }

  /**
   * Check if a tool call is in a doom loop.
   * Returns true if the same tool+input has failed >= threshold times with no
   * intervening change to the workspace.
   */
  check(toolName: string, inputSummary: string, isError: boolean): boolean {
    // The whole input, not a prefix. A truncated key reports a loop that is not
    // happening, and it does so worst exactly where commands share a mandated
    // preamble — env vars, `cd X &&`, a test runner and its flags. Every gilded
    // command opens with 100 characters of `$env:...; python -m pytest
    // gilded/tests`, so under the old 100-char slice every test invocation in
    // that repository was a single key.
    const key = `${toolName}:${inputSummary}`

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

  /**
   * Something in the workspace changed. Every recorded failure predates it and
   * describes a repository that no longer exists, so none of them are evidence
   * about the next attempt.
   *
   * Clears every key, not only the one that last failed: a single edit can fix
   * any number of commands, and holding a count against a command the change
   * may have repaired is the same mistake in a smaller size.
   *
   * This is `393bde1`'s rule applied to a second counter: stuck evidence is
   * cleared by progress, never by one quiet turn.
   */
  noteWorkspaceChanged(): void {
    this.failures.clear()
  }

  getSuggestion(): string | null {
    if (!this.lastDetected) return null
    return `Doom loop detected: "${this.lastDetected}" has failed ${this.threshold}+ times with the same input and no change to the source in between — a repeated action against an unchanged repository. Consider: changing approach, reading the error more carefully, or trying a different tool.`
  }

  reset(): void {
    this.failures.clear()
    this.lastDetected = null
  }
}
