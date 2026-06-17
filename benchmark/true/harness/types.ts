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
  passed: boolean
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
  governed: Interval        // pass rate over reps, Wilson CI
  ungoverned: Interval
  lift: number              // governed.point - ungoverned.point
}

export interface SuiteResult {
  model: string
  timestamp: string         // ISO
  repsPerCondition: number
  runs: RunRecord[]
  perTask: PerTaskResult[]
  governedOverall: Interval
  ungovernedOverall: Interval
  liftMean: number
  liftLower: number         // paired-bootstrap CI on mean lift
  liftUpper: number
}
