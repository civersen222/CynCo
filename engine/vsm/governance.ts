import type { GovernanceReport, GovernanceAlert } from './types.js'
import { AlgedonicBridge } from './algedonic.js'
import { HomeostasisMonitor } from './homeostasis.js'
import { AuditMonitor } from './audit.js'

type TurnMetrics = {
  toolsCalled: number
  thinkingTokens: number
  totalTokens: number
  latencyMs: number
  response: string
}

export class GovernanceLayer {
  private algedonic: AlgedonicBridge
  private homeostasis: HomeostasisMonitor
  private audit: AuditMonitor
  private onAlert?: (alert: GovernanceAlert) => void

  constructor(onAlert?: (alert: GovernanceAlert) => void) {
    this.onAlert = onAlert
    this.algedonic = new AlgedonicBridge((alert) => {
      this.onAlert?.(alert)
    })
    this.homeostasis = new HomeostasisMonitor()
    this.audit = new AuditMonitor()
  }

  onToolResult(name: string, success: boolean, latencyMs: number, _output?: string): void {
    this.algedonic.reportToolResult(name, success, latencyMs)
  }

  onTurnComplete(metrics: TurnMetrics): void {
    this.homeostasis.recordTurn({
      toolsCalled: metrics.toolsCalled,
      thinkingTokens: metrics.thinkingTokens,
      totalTokens: metrics.totalTokens,
      latencyMs: metrics.latencyMs,
    })
    this.audit.recordTurn(metrics.toolsCalled > 0)
    this.audit.recordResponse(metrics.response)
  }

  onModelError(error: string): void {
    this.algedonic.reportModelError(error)
  }

  onModelTimeout(ms: number): void {
    this.algedonic.reportModelTimeout(ms)
  }

  getReport(): GovernanceReport {
    const balance = this.homeostasis.getBalance()
    const algedonicAlerts = this.algedonic.unacknowledgedCount()
    const successRate = this.algedonic.getSuccessRate()
    const latencyTrend = this.homeostasis.getLatencyTrend()
    const stuckTurns = this.audit.isStuck() ? 3 : 0 // minimum threshold value when stuck

    // Derive variety balance from s3/s4 balance as a proxy
    let varietyBalance: GovernanceReport['varietyBalance']
    if (balance.s3Pressure < 0.1) {
      varietyBalance = 'underload'
    } else if (balance.s3Pressure > 0.9) {
      varietyBalance = 'overload'
    } else {
      varietyBalance = 'balanced'
    }

    // Status derivation
    let status: GovernanceReport['status']
    if (algedonicAlerts > 0 || balance.balance === 'critical') {
      status = 'critical'
    } else if (successRate < 0.5 || this.audit.isStuck()) {
      status = 'warning'
    } else {
      status = 'healthy'
    }

    return {
      status,
      varietyBalance,
      varietyRatio: 1.0,
      s3s4Balance: balance.balance,
      algedonicAlerts,
      stuckTurns,
      consecutiveUnstable: 0,
      modelLatencyTrend: latencyTrend,
      toolSuccessRate: successRate,
    }
  }
}
