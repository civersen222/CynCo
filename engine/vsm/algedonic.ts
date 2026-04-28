import type { GovernanceAlert } from './types.js'

const WINDOW_SIZE = 20
const CONSECUTIVE_FAIL_THRESHOLD = 3
const SUCCESS_RATE_THRESHOLD = 0.5

export class AlgedonicBridge {
  private onAlert: (alert: GovernanceAlert) => void
  private recentResults: boolean[] = []
  private consecutiveFails = 0
  private unacknowledged = 0

  constructor(onAlert: (alert: GovernanceAlert) => void) {
    this.onAlert = onAlert
  }

  reportToolResult(name: string, success: boolean, _latencyMs: number): void {
    // Rolling window
    this.recentResults.push(success)
    if (this.recentResults.length > WINDOW_SIZE) {
      this.recentResults.shift()
    }

    if (success) {
      this.consecutiveFails = 0
    } else {
      this.consecutiveFails++
      if (this.consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
        this.emit({
          type: 'governance.alert',
          severity: 'high',
          message: `Tool '${name}' has failed ${this.consecutiveFails} consecutive times`,
          source: 'algedonic',
        })
      }
    }

    // Check rolling success rate
    const rate = this.getSuccessRate()
    if (this.recentResults.length >= WINDOW_SIZE && rate < SUCCESS_RATE_THRESHOLD) {
      this.emit({
        type: 'governance.alert',
        severity: 'moderate',
        message: `Tool success rate dropped to ${(rate * 100).toFixed(0)}% over last ${WINDOW_SIZE} calls`,
        source: 'algedonic',
      })
    }
  }

  reportModelTimeout(ms: number): void {
    this.emit({
      type: 'governance.alert',
      severity: 'critical',
      message: `Model timed out after ${ms}ms`,
      source: 'algedonic',
    })
  }

  reportModelError(error: string): void {
    this.emit({
      type: 'governance.alert',
      severity: 'high',
      message: `Model error: ${error}`,
      source: 'algedonic',
    })
  }

  unacknowledgedCount(): number {
    return this.unacknowledged
  }

  acknowledgeAll(): void {
    this.unacknowledged = 0
  }

  getSuccessRate(): number {
    if (this.recentResults.length === 0) return 1.0
    const successes = this.recentResults.filter(Boolean).length
    return successes / this.recentResults.length
  }

  private emit(alert: GovernanceAlert): void {
    this.unacknowledged++
    this.onAlert(alert)
  }
}
