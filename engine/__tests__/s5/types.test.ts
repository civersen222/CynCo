import { describe, expect, it } from 'bun:test'
import type { S5Input, S5Decision, S5Interface, DecisionLogEntry } from '../../s5/types.js'

describe('S5 types', () => {
  it('S5Input has correct shape', () => {
    const input: S5Input = {
      userMessage: 'hello',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.5,
      recentToolResults: [{ tool: 'Read', success: true }],
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:8b'],
      turnCount: 1,
    }
    expect(input.userMessage).toBe('hello')
    expect(input.contextUsagePercent).toBe(0.5)
    expect(input.recentToolResults).toHaveLength(1)
  })

  it('S5Decision has correct shape', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'all nominal',
    }
    expect(decision.contextAction).toBe('none')
    expect(decision.priority).toBe('balanced')
    expect(decision.reasoning).toBeTruthy()
  })

  it('DecisionLogEntry has correct shape', () => {
    const entry: DecisionLogEntry = {
      timestamp: Date.now(),
      input: {
        userMessage: 'test',
        activeWorkflow: null,
        currentPhase: null,
        contextUsagePercent: 0.3,
        recentToolResults: [],
        governanceStatus: 'healthy',
        s3s4Balance: 'balanced',
        modelLatencyTrend: 'stable',
        availableModels: [],
        turnCount: 0,
      },
      decision: {
        workflow: null,
        advancePhase: null,
        model: null,
        tools: null,
        contextAction: 'none',
        spawnAgent: null,
        priority: 'balanced',
        reasoning: 'test',
      },
    }
    expect(entry.timestamp).toBeGreaterThan(0)
    expect(entry.decision.contextAction).toBe('none')
  })
})
