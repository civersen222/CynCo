import { describe, it, expect } from 'vitest'
import {
  AblationRunner,
  metricsFromMessages,
  pickWinner,
  type AblationTestCase,
  type AblationTestResult,
  type AblationRunMetrics,
} from '../vsm/ablationRunner.js'
import type { Message } from '../types.js'

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

describe('metricsFromMessages', () => {
  it('counts assistant turns', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    expect(metricsFromMessages(messages, true).turns).toBe(2)
  })

  it('derives toolSuccess from tool_use / tool_result errors', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'a.ts' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
      ] },
    ]
    // 2 calls, 1 error → success = 1/2
    expect(metricsFromMessages(messages, true).toolSuccess).toBe(0.5)
  })

  it('reports toolSuccess 1 when there were no tool calls', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'just talking' }] },
    ]
    expect(metricsFromMessages(messages, true).toolSuccess).toBe(1)
  })

  it('counts unique files changed via Edit/Write only', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'b.ts' } },
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: 'c.ts' } },
      ] },
    ]
    expect(metricsFromMessages(messages, true).filesChanged).toBe(2)
  })

  it('maps outcomeOk to success / failure', () => {
    expect(metricsFromMessages([], true).outcome).toBe('success')
    expect(metricsFromMessages([], false).outcome).toBe('failure')
  })
})

describe('pickWinner', () => {
  const base: AblationRunMetrics = { turns: 5, toolSuccess: 0.8, filesChanged: 1, outcome: 'success' }

  it('prefers the successful outcome', () => {
    expect(pickWinner({ ...base, outcome: 'success' }, { ...base, outcome: 'failure' })).toBe('governed')
    expect(pickWinner({ ...base, outcome: 'failure' }, { ...base, outcome: 'success' })).toBe('ungoverned')
  })

  it('breaks outcome ties on higher toolSuccess', () => {
    expect(pickWinner({ ...base, toolSuccess: 0.9 }, { ...base, toolSuccess: 0.5 })).toBe('governed')
  })

  it('breaks success ties on fewer turns', () => {
    expect(pickWinner({ ...base, turns: 4 }, { ...base, turns: 9 })).toBe('governed')
  })

  it('returns tied when all metrics match', () => {
    expect(pickWinner({ ...base }, { ...base })).toBe('tied')
  })
})

describe('AblationRunner.run', () => {
  it('runs each case twice, flipping the VSM ablation env flag', async () => {
    const runner = new AblationRunner()
    runner.addTestCase({ name: 'Case A', task: 'fix it', expectedFiles: [], maxTurns: 5 })

    const seenEnv: (string | undefined)[] = []
    const execute = async (): Promise<AblationRunMetrics> => {
      seenEnv.push(process.env._ABLATION_VSM_DISABLED)
      return { turns: 3, toolSuccess: 1, filesChanged: 1, outcome: 'success' }
    }

    const results = await runner.run(execute)

    // Governed run sees the flag unset, ungoverned sees it set to '1'
    expect(seenEnv).toEqual([undefined, '1'])
    // Env restored (cleared) after the run
    expect(process.env._ABLATION_VSM_DISABLED).toBeUndefined()
    expect(results.length).toBe(1)
    expect(results[0].name).toBe('Case A')
    expect(results[0].winner).toBe('tied')
  })

  it('clears the env flag even if the executor throws', async () => {
    const runner = new AblationRunner()
    runner.addTestCase({ name: 'Boom', task: 'x', expectedFiles: [], maxTurns: 1 })
    const execute = async (): Promise<AblationRunMetrics> => { throw new Error('exec failed') }

    await expect(runner.run(execute)).rejects.toThrow('exec failed')
    expect(process.env._ABLATION_VSM_DISABLED).toBeUndefined()
  })
})
