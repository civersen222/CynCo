import { describe, expect, it } from 'bun:test'
import { brainstormWorkflow } from '../../workflows/definitions/brainstorm.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('Brainstorm workflow', () => {
  it('has correct structure', () => {
    expect(brainstormWorkflow.name).toBe('brainstorm')
    expect(brainstormWorkflow.initialPhase).toBe('understand')
    expect(Object.keys(brainstormWorkflow.phases)).toEqual(['understand', 'explore', 'propose', 'refine', 'spec'])
  })

  it('follows ideation cycle', () => {
    const engine = new WorkflowEngine()
    engine.start(brainstormWorkflow)
    engine.advance('explore')
    engine.advance('propose')
    engine.advance('refine')
    engine.advance('spec')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('can loop back from refine to propose', () => {
    const engine = new WorkflowEngine()
    engine.start(brainstormWorkflow)
    engine.advance('explore')
    engine.advance('propose')
    engine.advance('refine')
    engine.advance('propose')
    expect(engine.currentPhase?.name).toBe('propose')
  })

  it('understand phase uses only read tools', () => {
    const engine = new WorkflowEngine()
    engine.start(brainstormWorkflow)
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('Bash')
  })
})
