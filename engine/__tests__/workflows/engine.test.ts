import { describe, expect, it } from 'bun:test'
import { WorkflowEngine } from '../../workflows/engine.js'
import type { WorkflowDefinition } from '../../workflows/types.js'

const testWorkflow: WorkflowDefinition = {
  name: 'test-wf', displayName: 'Test', description: 'Test workflow', initialPhase: 'phase_a',
  phases: {
    phase_a: { name: 'phase_a', instruction: 'Do step A', allowedTools: ['Read', 'Grep'], gate: { type: 'model_done' }, transitions: ['phase_b', 'done'] },
    phase_b: { name: 'phase_b', instruction: 'Do step B', gate: { type: 'tool_output', tool: 'Bash', pattern: 'PASS' }, transitions: ['done'] },
  },
}

describe('WorkflowEngine', () => {
  it('starts a workflow and tracks state', () => {
    const engine = new WorkflowEngine()
    expect(engine.isActive).toBe(false)
    engine.start(testWorkflow)
    expect(engine.isActive).toBe(true)
    expect(engine.currentPhase?.name).toBe('phase_a')
    expect(engine.state?.turnCount).toBe(0)
  })

  it('returns system prompt override for current phase', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    const prompt = engine.getSystemPromptOverride()
    expect(prompt).toContain('Do step A')
    expect(prompt).toContain('Test')
  })

  it('returns allowed tools for current phase', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    expect(engine.getAllowedTools()).toEqual(['Read', 'Grep'])
  })

  it('returns null for allowed tools when phase has no restriction', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.advance('phase_b')
    expect(engine.getAllowedTools()).toBeNull()
  })

  it('advances to next phase', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.advance('phase_b')
    expect(engine.currentPhase?.name).toBe('phase_b')
    expect(engine.state?.phaseHistory).toEqual(['phase_a', 'phase_b'])
  })

  it('completes workflow on advance to done', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('rejects invalid transitions', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    expect(() => engine.advance('nonexistent')).toThrow()
  })

  it('checks gate conditions — model_done', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    expect(engine.checkGate('end_turn', null)).toBe(true)
  })

  it('checks gate conditions — tool_output match', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.advance('phase_b')
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: '3 tests PASS' })).toBe(true)
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: 'FAIL' })).toBe(false)
    expect(engine.checkGate('tool_result', { tool: 'Read', output: 'PASS' })).toBe(false)
  })

  it('increments turn count', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.incrementTurn()
    engine.incrementTurn()
    expect(engine.state?.turnCount).toBe(2)
  })

  it('cancels a workflow', () => {
    const engine = new WorkflowEngine()
    engine.start(testWorkflow)
    engine.cancel()
    expect(engine.isActive).toBe(false)
  })
})
