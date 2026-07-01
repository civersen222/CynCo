import type { Message } from '../types.js'

export type AblationTestCase = {
  name: string
  task: string
  expectedFiles: string[]
  maxTurns: number
}

/** Metrics for a single governed-or-ungoverned execution of a test case. */
export type AblationRunMetrics = {
  turns: number
  toolSuccess: number
  filesChanged: number
  outcome: string
}

/** Runs one task under the currently-set governance env and returns its metrics. */
export type AblationExecutor = (task: string, maxTurns: number) => Promise<AblationRunMetrics>

/** Env flag CyberneticsGovernance honors to no-op the VSM layer (ungoverned run). */
const ABLATION_ENV = '_ABLATION_VSM_DISABLED'

/**
 * Derive run metrics purely from a finished conversation's message log.
 * turns = assistant messages; toolSuccess = (calls - errors)/calls;
 * filesChanged = unique file_path touched by Edit/Write tool calls.
 */
export function metricsFromMessages(messages: Message[], outcomeOk: boolean): AblationRunMetrics {
  let turns = 0
  let toolCalls = 0
  let toolErrors = 0
  const changedFiles = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant') turns++
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolCalls++
        const fp = (block.input as Record<string, unknown>)?.file_path
        if ((block.name === 'Edit' || block.name === 'Write') && typeof fp === 'string') {
          changedFiles.add(fp)
        }
      } else if (block.type === 'tool_result' && block.is_error) {
        toolErrors++
      }
    }
  }

  return {
    turns,
    toolSuccess: toolCalls === 0 ? 1 : (toolCalls - toolErrors) / toolCalls,
    filesChanged: changedFiles.size,
    outcome: outcomeOk ? 'success' : 'failure',
  }
}

/**
 * Decide which run won: a successful outcome beats failure, then higher
 * tool-success, then fewer turns; otherwise tied.
 */
export function pickWinner(g: AblationRunMetrics, u: AblationRunMetrics): 'governed' | 'ungoverned' | 'tied' {
  const gSuccess = g.outcome === 'success'
  const uSuccess = u.outcome === 'success'
  if (gSuccess !== uSuccess) return gSuccess ? 'governed' : 'ungoverned'
  if (g.toolSuccess !== u.toolSuccess) return g.toolSuccess > u.toolSuccess ? 'governed' : 'ungoverned'
  if (g.turns !== u.turns) return g.turns < u.turns ? 'governed' : 'ungoverned'
  return 'tied'
}

export type AblationTestResult = {
  name: string
  governed: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  ungoverned: { turns: number; toolSuccess: number; filesChanged: number; outcome: string }
  winner: 'governed' | 'ungoverned' | 'tied'
}

export type AblationSummary = {
  governedWinRate: number
  ungovernedWinRate: number
  tiedRate: number
  governedAvgTurns: number
  ungovernedAvgTurns: number
  governedAvgSuccess: number
  ungovernedAvgSuccess: number
}

export class AblationRunner {
  readonly testCases: AblationTestCase[] = []

  addTestCase(tc: AblationTestCase): void {
    this.testCases.push(tc)
  }

  loadFromJson(json: string): void {
    const cases = JSON.parse(json) as AblationTestCase[]
    for (const c of cases) this.addTestCase(c)
  }

  /**
   * Run every test case twice — once governed (VSM active) and once ungoverned
   * (VSM no-op'd via the ablation env flag) — and pick a winner per case.
   * The env flag is always cleared after each run so it never leaks.
   */
  async run(execute: AblationExecutor): Promise<AblationTestResult[]> {
    const results: AblationTestResult[] = []
    for (const tc of this.testCases) {
      delete process.env[ABLATION_ENV]
      let governed: AblationRunMetrics
      try {
        governed = await execute(tc.task, tc.maxTurns)
      } finally {
        delete process.env[ABLATION_ENV]
      }

      process.env[ABLATION_ENV] = '1'
      let ungoverned: AblationRunMetrics
      try {
        ungoverned = await execute(tc.task, tc.maxTurns)
      } finally {
        delete process.env[ABLATION_ENV]
      }

      results.push({ name: tc.name, governed, ungoverned, winner: pickWinner(governed, ungoverned) })
    }
    return results
  }

  summarize(results: AblationTestResult[]): AblationSummary {
    if (results.length === 0) {
      return { governedWinRate: 0, ungovernedWinRate: 0, tiedRate: 0, governedAvgTurns: 0, ungovernedAvgTurns: 0, governedAvgSuccess: 0, ungovernedAvgSuccess: 0 }
    }
    const n = results.length
    return {
      governedWinRate: results.filter(r => r.winner === 'governed').length / n,
      ungovernedWinRate: results.filter(r => r.winner === 'ungoverned').length / n,
      tiedRate: results.filter(r => r.winner === 'tied').length / n,
      governedAvgTurns: results.reduce((s, r) => s + r.governed.turns, 0) / n,
      ungovernedAvgTurns: results.reduce((s, r) => s + r.ungoverned.turns, 0) / n,
      governedAvgSuccess: results.reduce((s, r) => s + r.governed.toolSuccess, 0) / n,
      ungovernedAvgSuccess: results.reduce((s, r) => s + r.ungoverned.toolSuccess, 0) / n,
    }
  }

  formatReport(results: AblationTestResult[], summary: AblationSummary): string {
    let out = 'Ablation Report\n===============\n\n'
    out += 'Test Case          | Governed    | Ungoverned  | Winner\n'
    out += '-------------------|-------------|-------------|----------\n'
    for (const r of results) {
      const g = `${r.governed.turns}t ${(r.governed.toolSuccess * 100).toFixed(0)}%`
      const u = `${r.ungoverned.turns}t ${(r.ungoverned.toolSuccess * 100).toFixed(0)}%`
      out += `${r.name.padEnd(18)} | ${g.padEnd(11)} | ${u.padEnd(11)} | ${r.winner}\n`
    }
    out += `\nGoverned wins ${(summary.governedWinRate * 100).toFixed(0)}%, Ungoverned ${(summary.ungovernedWinRate * 100).toFixed(0)}%, Tied ${(summary.tiedRate * 100).toFixed(0)}%\n`
    return out
  }
}
