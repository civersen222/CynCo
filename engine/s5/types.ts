export type S5Input = {
  userMessage: string
  activeWorkflow: string | null
  currentPhase: string | null
  contextUsagePercent: number
  recentToolResults: { tool: string; success: boolean }[]
  governanceStatus: 'healthy' | 'warning' | 'critical' | 'halted'
  s3s4Balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  modelLatencyTrend: 'stable' | 'rising' | 'falling'
  availableModels: string[]
  turnCount: number
  snapshotAvailable?: boolean
  governance?: {
    status: string
    varietyBalance: string
    s3s4Balance: string
    stuckTurns: number
    toolSuccessRate: number
    algedonicAlerts: number
  }
}

export type S5Decision = {
  workflow: string | null
  advancePhase: string | null
  model: string | null
  tools: string[] | null
  contextAction: 'none' | 'compact' | 'warn'
  spawnAgent: { task: string; tools: string[] } | null
  priority: 's3' | 's4' | 'balanced'
  reasoning: string
  revert?: boolean
}

export interface S5Interface {
  decide(input: S5Input): Promise<S5Decision>
  readonly name: string
}

export type DecisionLogEntry = {
  timestamp: number
  input: S5Input
  decision: S5Decision
}
