const WINDOW_SIZE = 20

type TurnRecord = {
  toolsCalled: number
  thinkingTokens: number
  totalTokens: number
  latencyMs: number
}

export type BalanceResult = {
  balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  s3Pressure: number
  s4Pressure: number
  ratio: number
}

export class HomeostasisMonitor {
  private turns: TurnRecord[] = []

  recordTurn(turn: TurnRecord): void {
    this.turns.push(turn)
    if (this.turns.length > WINDOW_SIZE) {
      this.turns.shift()
    }
  }

  getBalance(): BalanceResult {
    if (this.turns.length === 0) {
      return { balance: 'balanced', s3Pressure: 0, s4Pressure: 0, ratio: 1 }
    }

    const avgTools = this.turns.reduce((s, t) => s + t.toolsCalled, 0) / this.turns.length
    const avgThinkingRatio = this.turns.reduce((s, t) => {
      const ratio = t.totalTokens > 0 ? t.thinkingTokens / t.totalTokens : 0
      return s + ratio
    }, 0) / this.turns.length

    // S3 pressure = avg tools per turn / 5, capped at 1.0
    const s3Pressure = Math.min(avgTools / 5, 1.0)
    // S4 pressure = avg thinking ratio * 2, capped at 1.0
    const s4Pressure = Math.min(avgThinkingRatio * 2, 1.0)

    // Avoid division by zero
    const denominator = s3Pressure === 0 ? 0.001 : s3Pressure
    const ratio = s4Pressure / denominator

    let balance: BalanceResult['balance']
    if (ratio > 3.0 && s4Pressure > 0.8) {
      balance = 'critical'
    } else if (ratio > 3.0) {
      balance = 's4_dominant'
    } else if (ratio < 0.33 && s3Pressure > 0.8) {
      balance = 'critical'
    } else if (ratio < 0.33) {
      balance = 's3_dominant'
    } else {
      balance = 'balanced'
    }

    return { balance, s3Pressure, s4Pressure, ratio }
  }

  getLatencyTrend(): 'stable' | 'rising' | 'falling' {
    if (this.turns.length < 3) return 'stable'

    // Linear regression slope
    const n = this.turns.length
    const latencies = this.turns.map(t => t.latencyMs)
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0

    for (let i = 0; i < n; i++) {
      sumX += i
      sumY += latencies[i]
      sumXY += i * latencies[i]
      sumX2 += i * i
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
    const avgLatency = sumY / n

    // Slope threshold: >5% of avg per step = trending
    const threshold = avgLatency * 0.05
    if (slope > threshold) return 'rising'
    if (slope < -threshold) return 'falling'
    return 'stable'
  }
}
