import { describe, expect, it } from 'bun:test'
import { tddWorkflow } from '../../workflows/definitions/tdd.js'
import { WorkflowEngine } from '../../workflows/engine.js'

describe('TDD workflow', () => {
  it('has correct structure', () => {
    expect(tddWorkflow.name).toBe('tdd')
    expect(tddWorkflow.initialPhase).toBe('write_test')
    expect(Object.keys(tddWorkflow.phases)).toEqual(['write_test', 'run_test_fail', 'implement', 'run_test_pass', 'refactor'])
  })

  it('follows red-green-refactor cycle', () => {
    const engine = new WorkflowEngine()
    engine.start(tddWorkflow)
    expect(engine.currentPhase?.name).toBe('write_test')
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('run_test_fail')
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: '1 test FAIL' })).toBe(true)
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: '1 test PASS' })).toBe(false)
    engine.advance('implement')
    engine.advance('run_test_pass')
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: '3 tests PASS' })).toBe(true)
    engine.advance('refactor')
    engine.advance('done')
    expect(engine.isActive).toBe(false)
  })

  it('write_test phase restricts to read-only + write tools', () => {
    const engine = new WorkflowEngine()
    engine.start(tddWorkflow)
    const tools = engine.getAllowedTools()
    expect(tools).toContain('Read')
    expect(tools).toContain('Write')
    expect(tools).toContain('Edit')
    expect(tools).not.toContain('Bash')
  })

  it('run_test phases allow Bash', () => {
    const engine = new WorkflowEngine()
    engine.start(tddWorkflow)
    engine.advance('run_test_fail')
    expect(engine.getAllowedTools()).toContain('Bash')
    expect(engine.getAllowedTools()).toContain('Read')
  })
})
