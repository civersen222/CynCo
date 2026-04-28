const STUCK_THRESHOLD = 3
const REPEAT_WINDOW = 4
const SIMILARITY_THRESHOLD = 0.8

export class AuditMonitor {
  private turnsWithoutTools = 0
  private recentResponses: string[] = []

  recordTurn(usedTools: boolean): void {
    if (usedTools) {
      this.turnsWithoutTools = 0
    } else {
      this.turnsWithoutTools++
    }
  }

  recordResponse(text: string): void {
    this.recentResponses.push(text)
    if (this.recentResponses.length > REPEAT_WINDOW) {
      this.recentResponses.shift()
    }
  }

  isStuck(): boolean {
    return this.turnsWithoutTools >= STUCK_THRESHOLD
  }

  isRepeating(): boolean {
    if (this.recentResponses.length < REPEAT_WINDOW) return false

    // Compare each pair of responses in the window
    for (let i = 0; i < this.recentResponses.length - 1; i++) {
      for (let j = i + 1; j < this.recentResponses.length; j++) {
        if (this.wordOverlap(this.recentResponses[i], this.recentResponses[j]) < SIMILARITY_THRESHOLD) {
          return false
        }
      }
    }
    return true
  }

  getSuggestion(): string {
    if (this.isStuck() && this.isRepeating()) {
      return 'Agent is stuck and repeating: try a different approach or use available tools to make progress.'
    }
    if (this.isStuck()) {
      return 'Agent has not used any tools recently: consider using tools to gather more information or take action.'
    }
    if (this.isRepeating()) {
      return 'Agent is producing repetitive responses: vary the approach or gather new context.'
    }
    return 'No issues detected.'
  }

  private wordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
    if (wordsA.size === 0 && wordsB.size === 0) return 1.0
    if (wordsA.size === 0 || wordsB.size === 0) return 0.0

    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++
    }

    // Jaccard similarity
    const union = wordsA.size + wordsB.size - intersection
    return intersection / union
  }
}
