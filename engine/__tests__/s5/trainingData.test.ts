import { describe, expect, it } from 'bun:test'
import { buildExamples, toJsonl } from '../../s5/trainingData.js'
import type { DecisionRecord } from '../../decisions/logger.js'

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    timestamp: Date.now(),
    userMessageSummary: 'refactor the auth module',
    activeWorkflow: null,
    contextUsagePercent: 0.5,
    toolsCalled: ['Read', 'Edit'],
    toolResults: ['success', 'success'],
    modelUsed: 'qwen3:8b',
    stopReason: 'end_turn',
    tokenCount: 1200,
    latencyMs: 850,
    userSatisfaction: 'positive',
    ...overrides,
  }
}

describe('TrainingDataBuilder', () => {
  it('buildExamples produces TrainingExample array with input and output fields', () => {
    const records = [makeRecord(), makeRecord({ userMessageSummary: 'write unit tests' })]
    const examples = buildExamples(records)

    expect(examples).toHaveLength(2)
    expect(examples[0].input).toContain('refactor the auth module')
    expect(examples[0].output).toBeTruthy()

    // output should be valid JSON
    const parsed = JSON.parse(examples[0].output)
    expect(parsed).toHaveProperty('contextAction')
    expect(parsed).toHaveProperty('reasoning')
    expect(parsed).toHaveProperty('priority')
  })

  it('toJsonl produces one JSON object per line', () => {
    const records = [
      makeRecord({ contextUsagePercent: 0.8 }),
      makeRecord({ contextUsagePercent: 0.95, userSatisfaction: 'negative' }),
      makeRecord({ toolsCalled: ['Bash', 'Bash', 'Bash'], toolResults: ['failure', 'failure', 'failure'] }),
    ]

    const jsonl = toJsonl(records)
    const lines = jsonl.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)

    // Each line must be parseable JSON with input/output
    for (const line of lines) {
      const ex = JSON.parse(line)
      expect(ex).toHaveProperty('input')
      expect(ex).toHaveProperty('output')
      expect(typeof ex.input).toBe('string')
      expect(typeof ex.output).toBe('string')
    }

    // 80% context → compact in derived decision
    const first = JSON.parse(JSON.parse(lines[0]).output)
    expect(first.contextAction).toBe('compact')

    // 95% context → warn
    const second = JSON.parse(JSON.parse(lines[1]).output)
    expect(second.contextAction).toBe('warn')
  })
})
