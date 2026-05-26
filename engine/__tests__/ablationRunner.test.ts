import { describe, it, expect } from 'vitest'
import { AblationRunner, type AblationTestCase, type AblationTestResult } from '../vsm/ablationRunner.js'

describe('AblationRunner', () => {
  it('loads test cases', () => {
    const runner = new AblationRunner()
    runner.addTestCase({
      name: 'Fix import error',
      task: 'Fix the import error in src/main.ts',
      expectedFiles: ['src/main.ts'],
      maxTurns: 15,
    })
    expect(runner.testCases.length).toBe(1)
  })

  it('loads from JSON', () => {
    const runner = new AblationRunner()
    runner.loadFromJson(JSON.stringify([
      { name: 'Test 1', task: 'Do something', expectedFiles: ['a.ts'], maxTurns: 10 },
      { name: 'Test 2', task: 'Do other', expectedFiles: ['b.ts'], maxTurns: 20 },
    ]))
    expect(runner.testCases.length).toBe(2)
  })

  it('summarizes results correctly', () => {
    const runner = new AblationRunner()
    const results: AblationTestResult[] = [
      {
        name: 'Test 1',
        governed: { turns: 8, toolSuccess: 0.9, filesChanged: 3, outcome: 'viable' },
        ungoverned: { turns: 12, toolSuccess: 0.6, filesChanged: 2, outcome: 'marginal' },
        winner: 'governed',
      },
      {
        name: 'Test 2',
        governed: { turns: 10, toolSuccess: 0.7, filesChanged: 2, outcome: 'viable' },
        ungoverned: { turns: 10, toolSuccess: 0.7, filesChanged: 2, outcome: 'viable' },
        winner: 'tied',
      },
    ]
    const summary = runner.summarize(results)
    expect(summary.governedWinRate).toBe(0.5)
    expect(summary.tiedRate).toBe(0.5)
    expect(summary.ungovernedWinRate).toBe(0)
    expect(summary.governedAvgTurns).toBe(9)
    expect(summary.ungovernedAvgTurns).toBe(11)
  })

  it('formats report as readable text', () => {
    const runner = new AblationRunner()
    const results: AblationTestResult[] = [{
      name: 'Test 1',
      governed: { turns: 8, toolSuccess: 0.9, filesChanged: 3, outcome: 'viable' },
      ungoverned: { turns: 12, toolSuccess: 0.6, filesChanged: 2, outcome: 'marginal' },
      winner: 'governed',
    }]
    const summary = runner.summarize(results)
    const report = runner.formatReport(results, summary)
    expect(report).toContain('Ablation Report')
    expect(report).toContain('Test 1')
    expect(report).toContain('governed')
  })
})
