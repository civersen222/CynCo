import { describe, expect, it } from 'bun:test'
import type { WorkflowDefinition, WorkflowState, Phase, GateType } from '../../workflows/types.js'

describe('workflow types', () => {
  it('WorkflowDefinition shape is correct', () => {
    const wf: WorkflowDefinition = {
      name: 'test-wf', displayName: 'Test Workflow', description: 'A test workflow',
      initialPhase: 'start',
      phases: {
        start: { name: 'start', instruction: 'Begin', gate: { type: 'model_done' }, transitions: ['done'] },
      },
    }
    expect(wf.name).toBe('test-wf')
    expect(wf.phases.start.gate.type).toBe('model_done')
  })

  it('WorkflowState tracks phase history', () => {
    const state: WorkflowState = {
      workflow: {
        name: 'test', displayName: 'Test', description: '', initialPhase: 'a',
        phases: {
          a: { name: 'a', instruction: '', gate: { type: 'auto' }, transitions: ['b'] },
          b: { name: 'b', instruction: '', gate: { type: 'auto' }, transitions: ['done'] },
        },
      },
      currentPhase: 'b', phaseHistory: ['a', 'b'], startedAt: Date.now(), turnCount: 2, metadata: {},
    }
    expect(state.phaseHistory).toEqual(['a', 'b'])
  })

  it('GateType variants are distinct', () => {
    const gates: GateType[] = [
      { type: 'tool_output', tool: 'Bash', pattern: 'PASS' },
      { type: 'user_confirm' }, { type: 'model_done' }, { type: 'auto' },
    ]
    expect(gates).toHaveLength(4)
  })
})
