import { describe, expect, it } from 'bun:test'
import { planningWorkflow } from '../../workflows/definitions/planning.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('Planning workflow', () => {
  it('has correct structure', () => {
    expect(planningWorkflow.name).toBe('planning')
    expect(planningWorkflow.initialPhase).toBe('create_plan')
    expect(Object.keys(planningWorkflow.phases)).toEqual(['create_plan', 'execute_step', 'verify_step'])
  })

  it('follows create_plan → execute_step → verify_step cycle', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    expect(engine.currentPhase?.name).toBe('create_plan')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('execute_step')
    expect(engine.currentPhase?.name).toBe('execute_step')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('verify_step')
    expect(engine.currentPhase?.name).toBe('verify_step')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('verify_step can loop back to execute_step for next step', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    engine.advance('execute_step')
    engine.advance('verify_step')
    engine.advance('execute_step')
    expect(engine.currentPhase?.name).toBe('execute_step')
    engine.advance('verify_step')
    engine.advance('execute_step')
    engine.advance('verify_step')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('create_plan phase is read-only', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Glob')
    expect(tools).toContain('Grep')
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('Edit')
    expect(tools).not.toContain('Write')
  })

  it('execute_step has no tool restrictions', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    engine.advance('execute_step')
    expect(engine.getAllowedTools()).toBeNull()
  })

  it('verify_step has no tool restrictions', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    engine.advance('execute_step')
    engine.advance('verify_step')
    expect(engine.getAllowedTools()).toBeNull()
  })

  it('all phases use model_done gate', () => {
    for (const phase of Object.values(planningWorkflow.phases)) {
      expect(phase.gate.type).toBe('model_done')
    }
  })

  it('create_plan cannot skip to verify_step', () => {
    const engine = new WorkflowEngine()
    engine.start(planningWorkflow)
    expect(() => engine.advance('verify_step')).toThrow()
  })
})
