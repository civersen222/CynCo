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

/** Per-turn snapshot of the S4 reflector + task classifier (P1.3). scores
 *  mirrors ReflectionScores in s4Reflector.ts structurally — types.ts stays
 *  import-free by convention; keep the shapes in sync. */
export type S4Snapshot = {
  scores: { progress: number; confidence: number; toolQuality: number; stuckness: number } | null
  composite: number | null
  reflectionCount: number
  taskType: 'simple_query' | 'file_operation' | 'code_generation' | 'debugging' | 'multi_step' | 'architectural'
  taskComplexity: number
}

/** P1.6: per-turn heterarchy state (McCulloch redundancy of potential
 *  command). Classification pre-existed; this persists it. */
export type HeterarchySnapshot = {
  context: 'normal' | 'crisis' | 'exploration' | 'routine' | 'stuck'
  commander: string
  /** Did command shift on the last completed turn? */
  shifted: boolean
}

export type GovernanceReport = {
  status: HealthStatus
  varietyBalance: 'balanced' | 'underload' | 'overload'
  varietyRatio: number
  /** P1.5: distinct (tool, args) states in the rolling 10-turn window —
   *  the windowed counterpart to the monotone varietyRatio. Both are
   *  logged so Phase 3 can compare discrimination power. */
  varietyWindowed: number
  /** P4.1: fraction of unmet (pending|failed) contract assertions at turn
   *  seal, over countable (non-skipped) assertions; null when no active
   *  contract. Computed by the governor, never by the model (VI.3). */
  taskError: number | null
  /** P4.1: CUSUM alarm state over the taskError series; null with taskError. */
  errorTrend: 'rising' | 'falling' | 'flat' | null
  /** P4.3 (VI.3 signal 2): action-fingerprint repetition alarm —
   *  'identical' = 3 consecutive identical (tool, args) fingerprints,
   *  'alternating' = last 6 calls A-B-A-B-A-B; polling tools whitelisted. */
  fingerprintAlarm: 'identical' | 'alternating' | null
  /** P4.3 (VI.3 signal 4): fraction of this turn's touched file paths never
   *  seen before this session; null when the turn touched no paths. */
  infoGain: number | null
  /** P4.3 (VI.3 signal 5): newly-passed contract assertions per 1k
   *  totalTokens; null when no active contract or a zero-token turn. */
  progressRate: number | null
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
  s4: S4Snapshot
  heterarchy: HeterarchySnapshot
}

export type GovernanceAlert = {
  /** Which organ raised it. */
  source: 'algedonic' | 'variety'
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
}
