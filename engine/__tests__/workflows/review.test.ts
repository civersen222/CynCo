import { describe, expect, it } from 'bun:test'
import { reviewWorkflow } from '../../workflows/definitions/review.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('Review workflow', () => {
  it('has correct structure', () => {
    expect(reviewWorkflow.name).toBe('review')
    expect(reviewWorkflow.initialPhase).toBe('gather')
    expect(Object.keys(reviewWorkflow.phases)).toEqual(['gather', 'analyze', 'report'])
  })

  it('follows gather → analyze → report → done cycle', () => {
    const engine = new WorkflowEngine()
    engine.start(reviewWorkflow)
    expect(engine.currentPhase?.name).toBe('gather')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('analyze')
    expect(engine.currentPhase?.name).toBe('analyze')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('report')
    expect(engine.currentPhase?.name).toBe('report')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('gather phase allows Bash for git operations', () => {
    const engine = new WorkflowEngine()
    engine.start(reviewWorkflow)
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Glob')
    expect(tools).toContain('Grep')
    expect(tools).toContain('Bash')
  })

  it('analyze phase is read-only (no Bash)', () => {
    const engine = new WorkflowEngine()
    engine.start(reviewWorkflow)
    engine.advance('analyze')
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Glob')
    expect(tools).toContain('Grep')
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('Edit')
    expect(tools).not.toContain('Write')
  })

  it('report phase is Read-only', () => {
    const engine = new WorkflowEngine()
    engine.start(reviewWorkflow)
    engine.advance('analyze')
    engine.advance('report')
    const tools = engine.getAllowedTools()
    expect(tools).toEqual(['Read', 'SubAgent', 'CollectAgent'])
  })

  it('all phases use model_done gate', () => {
    for (const phase of Object.values(reviewWorkflow.phases)) {
      expect(phase.gate.type).toBe('model_done')
    }
  })

  it('report can only transition to done', () => {
    const phase = reviewWorkflow.phases['report']
    expect(phase?.transitions).toEqual(['done'])
  })
})
