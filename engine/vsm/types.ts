export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'halted'

export type AxiomHealth = {
  holding: number
  total: number
  violations: string[]
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
}

export type GovernanceAlert = {
  type: 'governance.alert'
  severity: 'low' | 'moderate' | 'high' | 'critical'
  message: string
  source: string
}
