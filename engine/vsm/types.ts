export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'halted'

export type AxiomHealth = {
  holding: number
  total: number
  violations: string[]
}

/** Per-turn snapshot of the H1-H8 prediction tracker (P1.2). Shape mirrors
 *  predictionTracker's PredictionStats structurally — do not import it here
 *  (predictionTracker imports this file; avoid the cycle). */
export type PredictionSnapshot = {
  open: number
  completed: number
  stats: {
    hypothesis: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8'
    total: number
    correct: number
    hitRate: number
    confidenceInterval: [number, number]
    nullBaselineRate: number
    significantlyBetter: boolean
  }[]
}

export type GovernanceReport = {
  status: HealthStatus
  varietyBalance: 'balanced' | 'underload' | 'overload'
  varietyRatio: number
  s3s4Balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  algedonicAlerts: number
  stuckTurns: number
  consecutiveUnstable: number
  modelLatencyTrend: 'stable' | 'rising' | 'falling'
  toolSuccessRate: number
  agreementRatio: number
  observerDivergence: number | null
  axiomHealth: AxiomHealth
  recentToolNames: string[]
  predictions: PredictionSnapshot
}

export type GovernanceAlert = {
  /** Which organ raised it. */
  source: 'algedonic' | 'variety'
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
}
