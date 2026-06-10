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
      maxTurns: 3,
    },
    phase2: {
      name: 'phase2',
      instruction: 'Do phase 2 work',
      gate: { type: 'model_done' },
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

    // Accumulate 5 turns in phase1, then advance
    for (let i = 0; i < 5; i++) engine.incrementTurn()
    engine.advance('phase2')
    expect(engine.state?.turnCount).toBe(0)

    // Now in phase2 (maxTurns: 5) — gate should NOT force-advance at turn 0
    expect(engine.checkGate('end_turn', null)).toBe(true) // gate=model_done passes on end_turn
    // But the maxTurns force-advance logic checks turnCount >= maxTurns — turn 0 is not >= 5
    engine.incrementTurn()
    expect(engine.state?.turnCount).toBe(1)
  })

  it('turnCount starts at 0 on initial start()', () => {
    const engine = new WorkflowEngine()
    engine.start(twoPhaseWorkflow)
    expect(engine.state?.turnCount).toBe(0)
  })
})
