import { describe, expect, it } from 'bun:test'
import { critiqueWorkflow } from '../../workflows/definitions/critique.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('Critique (ICR) workflow', () => {
  it('has correct structure', () => {
    expect(critiqueWorkflow.name).toBe('critique')
    expect(critiqueWorkflow.initialPhase).toBe('generate')
    expect(Object.keys(critiqueWorkflow.phases)).toEqual(['generate', 'critique', 'refine'])
  })

  it('follows generate → critique → refine loop', () => {
    const engine = new WorkflowEngine()
    engine.start(critiqueWorkflow)
    expect(engine.currentPhase?.name).toBe('generate')
    engine.advance('critique')
    expect(engine.currentPhase?.name).toBe('critique')
    engine.advance('refine')
    expect(engine.currentPhase?.name).toBe('refine')
  })

  it('can complete from refine', () => {
    const engine = new WorkflowEngine()
    engine.start(critiqueWorkflow)
    engine.advance('critique')
    engine.advance('refine')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })
})
