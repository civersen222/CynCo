import { describe, expect, it } from 'bun:test'
import { WorkflowEngine } from '../../workflows/engine.js'
import type { WorkflowDefinition } from '../../workflows/types.js'

const twoPhaseWorkflow: WorkflowDefinition = {
  name: 'turn-count-wf',
  displayName: 'Turn Count Test',
  description: 'Tests that turnCount resets on phase advance',
  initialPhase: 'phase1',
  phases: {
    phase1: {
      name: 'phase1',
      instruction: 'Do phase 1 work',
      gate: { type: 'model_done' },
      transitions: ['phase2'],
      maxTurns: 5,
    },
    phase2: {
      name: 'phase2',
      instruction: 'Do phase 2 work',
      gate: { type: 'user_confirm' },
      transitions: ['done'],
      maxTurns: 5,
    },
  },
}

describe('WorkflowEngine — turnCount reset on phase advance', () => {
  it('turnCount resets to 0 on phase advance', () => {
    const engine = new WorkflowEngine()
    engine.start(twoPhaseWorkflow)

    // Accumulate turns in phase1
    for (let i = 0; i < 5; i++) engine.incrementTurn()
    expect(engine.state?.turnCount).toBe(5)
    expect(engine.state?.currentPhase).toBe('phase1')

    // Advance to phase2 — turnCount must reset
    engine.advance('phase2')
    expect(engine.state?.turnCount).toBe(0)
    expect(engine.state?.currentPhase).toBe('phase2')
  })

  it('maxTurns enforcement in phase2 uses its own per-phase count after reset', () => {
    const engine = new WorkflowEngine()
    engine.start(twoPhaseWorkflow)

    // Accumulate maxTurns (5) turns in phase1, then advance to phase2
    for (let i = 0; i < 5; i++) engine.incrementTurn()
    engine.advance('phase2')
    // turnCount must be 0 after advance; phase2 gate is user_confirm (normally false)
    // Pre-fix: stale turnCount 5 >= maxTurns 5 would force-advance → true
    // Post-fix: turnCount 0 < maxTurns 5 → gate fires normally → false
    expect(engine.checkGate('end_turn', null)).toBe(false)

    // Exhaust phase2's own maxTurns — force-advance must now fire
    for (let i = 0; i < 5; i++) engine.incrementTurn()
    expect(engine.state?.turnCount).toBe(5)
    expect(engine.checkGate('end_turn', null)).toBe(true)
  })
})
