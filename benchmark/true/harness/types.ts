export type Condition = 'governed' | 'ungoverned'

export interface TaskDef {
  id: string
  prompt: string
  startRef: string          // git ref to check out in the isolated clone
  setupPatch?: string       // absolute path to a patch applied after checkout (optional)
  hiddenTestPath: string    // absolute path to the scoring pytest file (never shown to the agent)
  hiddenTestName: string    // filename to copy the hidden test to inside the clone, e.g. "hidden_test.py"
  timeoutMs: number
  source: 'mined' | 'authored'
}

export interface RunRecord {
  taskId: string
  condition: Condition
  rep: number               // 1-based repeat index
  passed: boolean           // strict full-pass flag (score === 1)
  score: number             // fraction of hidden-test assertions that passed, [0,1]
  timedOut: boolean
  turns: number             // count of assistant messages
}

export interface Interval {
  point: number
  lower: number
  upper: number
}

export interface PerTaskResult {
  taskId: string
  governed: Interval        // full-pass rate over reps, Wilson CI (binary)
  ungoverned: Interval
  lift: number              // binary: governed.point - ungoverned.point
  governedScore: number     // mean continuous score over governed reps
  ungovernedScore: number   // mean continuous score over ungoverned reps
  scoreLift: number         // governedScore - ungovernedScore
}

export interface SuiteResult {
  model: string
  timestamp: string         // ISO
  repsPerCondition: number
  runs: RunRecord[]
  perTask: PerTaskResult[]
  governedOverall: Interval        // binary full-pass rate, Wilson CI
  ungovernedOverall: Interval
  governedScoreMean: Interval       // continuous mean score, bootstrap CI
  ungovernedScoreMean: Interval
  liftMean: number          // headline: bootstrap over per-task continuous scoreLift
  liftLower: number         // paired-bootstrap CI on mean continuous scoreLift
  liftUpper: number
}
