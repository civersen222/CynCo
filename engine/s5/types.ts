export type S5Input = {
  userMessage: string
  activeWorkflow: string | null
  currentPhase: string | null
  contextUsagePercent: number
  governanceStatus: 'healthy' | 'warning' | 'critical' | 'halted'
  s3s4Balance: 'balanced' | 's3_dominant' | 's4_dominant' | 'critical'
  modelLatencyTrend: 'stable' | 'rising' | 'falling'
  availableModels: string[]
  turnCount: number
  recentToolResults: { tool: string; success: boolean }[]
  snapshotAvailable?: boolean
  governance?: Record<string, unknown>
  // Governance signals for S5 enforcement
  varietyBalance: 'balanced' | 'underload' | 'overload' | 'critical'
  varietyRatio: number
  homeostatStable: boolean
  homeostatConsecutiveUnstable: number
  driftDetected: boolean
  driftDirection: 'improving' | 'degrading' | null
  performanceHealth: 'healthy' | 'warning' | 'critical'
  productivityRatio: number
  recommendedToolMode: string | null
  heterarchyAuthority: 's3' | 's4' | 's5' | null
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
  decisionId?: string
  ruleIds?: string[]
}

export type RuleTier = 'critical' | 'warning' | 'info'

export type S5Rule = {
  id: string
  tier: RuleTier
  name: string
  evaluate: (input: S5Input) => Partial<S5Decision> | null
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
