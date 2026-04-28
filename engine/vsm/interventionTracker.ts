/**
 * Intervention Tracker — within-session PID learning.
 * Tracks which governance interventions preceded success vs failure.
 * Upweights effective interventions, backs off ineffective ones.
 * Cybernetic grounding: closed-loop feedback — S3 issues directive,
 * observes outcome, adjusts intensity. Level 4 ready.
 */

type InterventionRecord = {
  type: string
  success: boolean
  timestamp: number
}

export class InterventionTracker {
  private records: InterventionRecord[] = []
  private successCounts: Map<string, { success: number; total: number }> = new Map()

  recordIntervention(type: string, success: boolean): void {
    this.records.push({ type, success, timestamp: Date.now() })
    const counts = this.successCounts.get(type) ?? { success: 0, total: 0 }
    counts.total++
    if (success) counts.success++
    this.successCounts.set(type, counts)
  }

  getSuccessRate(type: string): number {
    const counts = this.successCounts.get(type)
    if (!counts || counts.total === 0) return 1.0
    return counts.success / counts.total
  }

  shouldIntervene(type: string): boolean {
    return this.getSuccessRate(type) >= 0.4
  }

  getHistory(): InterventionRecord[] {
    return [...this.records]
  }
}
