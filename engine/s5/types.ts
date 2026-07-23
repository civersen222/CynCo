import type { DifficultyLevel } from '../vsm/difficultyClassifier.js'

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
  agreementRatio: number
  observerDivergence: number | null
  demotedTools: string[]
  // Observed task difficulty from turn telemetry (vsm DifficultyClassifier)
  promptDifficulty: DifficultyLevel
  // P4.1: task homeostat — external DoD error + CUSUM trend (VI.3)
  taskError: number | null
  errorTrend: 'rising' | 'falling' | 'flat' | null
  // P4.3: remaining VI.3 signals — measurement only; no rule consumes these
  // until they pass the Phase 3 gauntlet
  fingerprintAlarm: 'identical' | 'alternating' | null
  infoGain: number | null
  progressRate: number | null
  explorationState: 'healthy_exploration' | 'thrashing' | 'floundering' | null
  // P4.5 Phase 3: proactive tool surfacing (opt-in via LOCALCODE_S5_PROACTIVE_TOOLS).
  // taskClass = keyword-classified request type; loadedTools = the currently-loaded
  // tool names. Both are the STATE half of the (state, surfaced-tools, outcome) triple.
  // Optional so pre-existing S5Input constructions (and the flag-off path) are unaffected.
  taskClass?: TaskClass | null
  loadedTools?: string[]
}

/** Keyword-classified request type used only for proactive tool surfacing.
 *  Deliberately distinct from vsm/cyberneticsGovernance's complexity-oriented
 *  TaskType (simple_query/…/architectural) — that taxonomy lacks test/research
 *  classes and is tuned for variety estimation, not tool hints. */
export type TaskClass = 'debug' | 'test' | 'research' | 'refactor' | 'general'

export type S5Decision = {
  workflow: string | null
  advancePhase: string | null
  model: string | null
  tools: string[] | null
  // P4.5 Phase 3: tool names to PRE-LOAD (append-only surface), never a restriction.
  // The ACTION half of the (state, surfaced-tools, outcome) triple. null when the
  // proactive flag is off or no tools are missing → byte-identical to prior behavior.
  surfaceTools: string[] | null
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
