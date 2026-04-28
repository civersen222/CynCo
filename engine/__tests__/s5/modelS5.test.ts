import { describe, expect, it } from 'bun:test'
import { ModelS5 } from '../../s5/modelS5.js'
import type { S5Input } from '../../s5/types.js'

// ─── Shared test input ────────────────────────────────────────────

const baseInput: S5Input = {
  userMessage: 'fix the bug in auth.ts',
  activeWorkflow: null,
  currentPhase: null,
  contextUsagePercent: 0.4,
  recentToolResults: [{ tool: 'Read', success: true }],
  governanceStatus: 'healthy',
  s3s4Balance: 'balanced',
  modelLatencyTrend: 'stable',
  availableModels: ['qwen3:8b'],
  turnCount: 2,
}

// ─── Tests ────────────────────────────────────────────────────────

describe('ModelS5', () => {
  it('has name "ModelS5"', () => {
    const s5 = new ModelS5({ model: 's5:latest', baseUrl: 'http://localhost:11434' })
    expect(s5.name).toBe('ModelS5')
  })

  it('falls back to RuleBasedS5 on unreachable URL', async () => {
    const s5 = new ModelS5({
      model: 's5:latest',
      baseUrl: 'http://127.0.0.1:19999', // nothing listening here
      timeout: 500,
    })
    const decision = await s5.decide(baseInput)
    // Fallback must return a valid S5Decision
    expect(decision).toBeDefined()
    expect(typeof decision.reasoning).toBe('string')
    expect(['none', 'compact', 'warn']).toContain(decision.contextAction)
    expect(['s3', 's4', 'balanced']).toContain(decision.priority)
  })

  it('formatPrompt contains user message', () => {
    const s5 = new ModelS5({ model: 's5:latest', baseUrl: 'http://localhost:11434' })
    const prompt = s5.formatPrompt(baseInput)
    expect(prompt).toContain('fix the bug in auth.ts')
  })

  it('parseResponse with valid JSON returns S5Decision', () => {
    const s5 = new ModelS5({ model: 's5:latest', baseUrl: 'http://localhost:11434' })
    const json = JSON.stringify({
      workflow: 'debug',
      advancePhase: null,
      model: 'qwen3:8b',
      tools: ['Read', 'Bash'],
      contextAction: 'none',
      spawnAgent: null,
      priority: 's3',
      reasoning: 'debugging workflow selected',
    })
    const decision = s5.parseResponse(json)
    expect(decision.workflow).toBe('debug')
    expect(decision.model).toBe('qwen3:8b')
    expect(decision.tools).toEqual(['Read', 'Bash'])
    expect(decision.priority).toBe('s3')
    expect(decision.reasoning).toBe('debugging workflow selected')
  })

  it('parseResponse with invalid JSON returns default decision', () => {
    const s5 = new ModelS5({ model: 's5:latest', baseUrl: 'http://localhost:11434' })
    const decision = s5.parseResponse('not valid json at all ~~~')
    expect(decision).toBeDefined()
    expect(decision.contextAction).toBe('none')
    expect(decision.priority).toBe('balanced')
    expect(typeof decision.reasoning).toBe('string')
  })
})
