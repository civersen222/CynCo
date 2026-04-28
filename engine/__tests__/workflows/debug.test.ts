import { describe, expect, it } from 'bun:test'
import { debugWorkflow } from '../../workflows/definitions/debug.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('Debug workflow', () => {
  it('has correct structure', () => {
    expect(debugWorkflow.name).toBe('debug')
    expect(debugWorkflow.initialPhase).toBe('reproduce')
    expect(Object.keys(debugWorkflow.phases)).toEqual(['reproduce', 'hypothesize', 'isolate', 'fix', 'verify'])
  })

  it('follows the full debug cycle', () => {
    const engine = new WorkflowEngine()
    engine.start(debugWorkflow)
    expect(engine.currentPhase?.name).toBe('reproduce')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('hypothesize')
    expect(engine.currentPhase?.name).toBe('hypothesize')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('isolate')
    expect(engine.currentPhase?.name).toBe('isolate')
    engine.advance('fix')
    expect(engine.currentPhase?.name).toBe('fix')
    engine.advance('verify')
    expect(engine.currentPhase?.name).toBe('verify')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('fix can loop back to isolate', () => {
    const engine = new WorkflowEngine()
    engine.start(debugWorkflow)
    engine.advance('hypothesize')
    engine.advance('isolate')
    engine.advance('fix')
    // fix can go back to isolate for further investigation
    engine.advance('isolate')
    expect(engine.currentPhase?.name).toBe('isolate')
    expect(engine.state?.phaseHistory).toContain('isolate')
  })

  it('verify can loop back to fix', () => {
    const engine = new WorkflowEngine()
    engine.start(debugWorkflow)
    engine.advance('hypothesize')
    engine.advance('isolate')
    engine.advance('fix')
    engine.advance('verify')
    // verify can go back to fix if tests still fail
    engine.advance('fix')
    expect(engine.currentPhase?.name).toBe('fix')
  })

  it('hypothesize phase restricts to read-only tools', () => {
    const engine = new WorkflowEngine()
    engine.start(debugWorkflow)
    engine.advance('hypothesize')
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Glob')
    expect(tools).toContain('Grep')
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('Edit')
  })

  it('reproduce phase has no tool restrictions', () => {
    const engine = new WorkflowEngine()
    engine.start(debugWorkflow)
    expect(engine.getAllowedTools()).toBeNull()
  })

  it('all gates are model_done', () => {
    for (const phase of Object.values(debugWorkflow.phases)) {
      expect(phase.gate.type).toBe('model_done')
    }
  })
})
