export type AblationTestCase = {
  name: string
  task: string
  expectedFiles: string[]
  maxTurns: number
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
