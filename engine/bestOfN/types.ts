export type TestInfo = {
  available: boolean
  command: string
  framework: string
}

export type CandidateResult = {
  index: number
  worktreePath: string
  patch: string
  testsPassed: number
  testsTotal: number
  passRate: number
  stuckTurns: number
  totalTurns: number
}

export type SamplerConfig = {
  n: number
  temperature: number
  turnCap: number
  cwd: string
  testInfo: TestInfo
}

export type SamplerResult = {
  winner: CandidateResult | null
  candidates: CandidateResult[]
  skipped: boolean
  skipReason?: string
}
