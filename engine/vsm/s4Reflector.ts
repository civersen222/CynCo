export interface ReflectionScores {
  progress: number
  confidence: number
  toolQuality: number
  stuckness: number
}

type SignalType = 'pain' | 'pleasure' | 'neutral'

export class S4Reflector {
  private x: number
  private minX: number
  private maxX: number
  private history: number[] = []
  private lastScores: ReflectionScores | null = null
  private lastSignal: SignalType = 'neutral'

  constructor(initialX: number = 8, minX: number = 3, maxX: number = 15) {
    this.x = initialX
    this.minX = minX
    this.maxX = maxX
  }

  getFrequency(): number { return this.x }

  shouldReflect(turnCount: number): boolean {
    return turnCount > 0 && turnCount % this.x === 0
  }

  recordScores(scores: ReflectionScores): number {
    this.lastScores = scores
    const composite = (scores.progress + scores.confidence + scores.toolQuality + (10 - scores.stuckness)) / 4
    this.history.push(composite)
    if (composite < 4.0) this.lastSignal = 'pain'
    else if (composite > 7.0) this.lastSignal = 'pleasure'
    else this.lastSignal = 'neutral'
    if (this.history.length >= 3) {
      const recent = this.history.slice(-3)
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length
      const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length
      if (variance < 1.0) this.x = Math.min(this.maxX, this.x + 1)
      else if (variance > 3.0) this.x = Math.max(this.minX, this.x - 1)
    }
    return composite
  }

  getLastSignal(): SignalType { return this.lastSignal }
  shouldTriggerPerturbation(): boolean { return this.lastScores !== null && this.lastScores.stuckness > 7 }
  shouldSuppressSignals(): boolean { return !!this.lastScores && this.lastScores.progress >= 9 && this.lastScores.confidence >= 8 }

  private sessionContext: string = ''

  setSessionContext(ctx: string): void { this.sessionContext = ctx }

  getReflectionPrompt(): string {
    const parts = [
      'You are evaluating a coding session. Be BRUTALLY HONEST — do not inflate scores.',
      'If you only completed part of the task, Progress should reflect that (e.g., 3/10 for 1 of 3 phases).',
    ]
    if (this.sessionContext) {
      parts.push('', 'Session context:', this.sessionContext)
    }
    parts.push(
      '', 'Rate 0-10:',
      'Progress: (0=nothing done, 5=halfway, 10=fully complete)',
      'Confidence: (0=lost, 10=certain)',
      'Quality: (0=flailing, 10=precise)',
      'Stuckness: (0=flowing, 10=stuck)',
    )
    return parts.join('\n')
  }

  parseResponse(response: string): ReflectionScores {
    const defaults: ReflectionScores = { progress: 5, confidence: 5, toolQuality: 5, stuckness: 5 }
    const result = { ...defaults }

    // Try numbered format: "1. 7" or "1: 7"
    const numbered: number[] = []
    for (const line of response.split('\n')) {
      const match = line.match(/^\s*\d[\.\):]\s*(\d+)/)
      if (match) numbered.push(Math.max(0, Math.min(10, parseInt(match[1], 10))))
    }
    if (numbered.length >= 4) {
      return { progress: numbered[0], confidence: numbered[1], toolQuality: numbered[2], stuckness: numbered[3] }
    }

    // Flexible labeled format: handles "Progress: 7", "Progress = 7", "Progress—7",
    // "Progress 7", "progress: 7/10", "Tool Quality: 8"
    const extractScore = (pattern: RegExp): number | null => {
      const m = response.match(pattern)
      return m ? Math.max(0, Math.min(10, parseInt(m[1], 10))) : null
    }

    const progressVal = extractScore(/progress[\s:=\-\u2014]+(\d+)/i)
    const confVal = extractScore(/confidence[\s:=\-\u2014]+(\d+)/i)
    const qualVal = extractScore(/(?:tool\s*)?quality[\s:=\-\u2014]+(\d+)/i)
    const stuckVal = extractScore(/stuck(?:ness)?[\s:=\-\u2014]+(\d+)/i)

    if (progressVal !== null) result.progress = progressVal
    if (confVal !== null) result.confidence = confVal
    if (qualVal !== null) result.toolQuality = qualVal
    if (stuckVal !== null) result.stuckness = stuckVal

    const parsed = [progressVal, confVal, qualVal, stuckVal].filter(v => v !== null).length
    if (parsed >= 2) return result

    return defaults
  }

  /**
   * Derive reflection scores from governance metrics when LLM parse fails.
   * Better than returning neutral 5s — at least the system gets real signal.
   */
  deriveFromMetrics(metrics: { stuckTurns: number; toolSuccessRate: number; contextUtilization: number }): ReflectionScores {
    const progress = Math.max(1, Math.min(9, 8 - metrics.stuckTurns))
    const confidence = Math.max(1, Math.min(9, Math.round(metrics.toolSuccessRate * 8 + 1)))
    const toolQuality = confidence
    const stuckness = Math.max(1, Math.min(10, metrics.stuckTurns * 2))
    return { progress, confidence, toolQuality, stuckness }
  }

  getHistory(): number[] { return [...this.history] }
  setBounds(min: number, max: number): void {
    this.minX = min
    this.maxX = max
    this.x = Math.max(min, Math.min(max, this.x))
  }
}
