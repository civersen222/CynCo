import { describe, it, expect } from 'vitest'
import { runSuite } from './orchestrate.js'
import type { TaskDef } from './types.js'

function fakeTask(id: string): TaskDef {
  return {
    id, prompt: 'p', startRef: 'HEAD', hiddenTestPath: '/x/hidden_test.py',
    hiddenTestName: 'hidden_test.py', timeoutMs: 1000, source: 'authored',
  }
}

describe('runSuite', () => {
  it('runs N reps per condition per task and aggregates a deterministic lift', async () => {
    const tasks = [fakeTask('alpha'), fakeTask('beta')]
    // Injected runner: governed always passes, ungoverned always fails. lift = 1.0.
    const result = await runSuite({
      tasks,
      reps: 3,
      model: 'fake-model',
      runOne: async ({ condition }) => ({ passed: condition === 'governed', timedOut: false, turns: 2, score: condition === 'governed' ? 1 : 0 }),
      bootstrapRng: () => 0,
    })

    expect(result.runs).toHaveLength(2 * 2 * 3) // tasks * conditions * reps
    expect(result.repsPerCondition).toBe(3)
    expect(result.governedOverall.point).toBe(1)
    expect(result.ungovernedOverall.point).toBe(0)
    expect(result.liftMean).toBeCloseTo(1, 5)
    for (const pt of result.perTask) {
      expect(pt.governed.point).toBe(1)
      expect(pt.ungoverned.point).toBe(0)
      expect(pt.lift).toBe(1)
    }
  })

  it('reports zero lift when both arms behave identically', async () => {
    const result = await runSuite({
      tasks: [fakeTask('alpha')],
      reps: 2,
      model: 'fake-model',
      runOne: async () => ({ passed: true, timedOut: false, turns: 1, score: 1 }),
      bootstrapRng: () => 0,
    })
    expect(result.liftMean).toBe(0)
    expect(result.governedOverall.point).toBe(1)
    expect(result.ungovernedOverall.point).toBe(1)
  })

  it('surfaces continuous partial lift even when binary pass-rate is flat', async () => {
    // Neither arm ever fully passes (passed:false), so binary Wilson points are 0,
    // but governed makes more partial progress (0.75) than ungoverned (0.5).
    const tasks = [fakeTask('alpha'), fakeTask('beta')]
    const result = await runSuite({
      tasks,
      reps: 4,
      model: 'fake-model',
      runOne: async ({ condition }) => ({
        passed: false,
        timedOut: false,
        turns: 2,
        score: condition === 'governed' ? 0.75 : 0.5,
      }),
      bootstrapRng: () => 0,
    })

    // Binary pass-rate is flat at zero for both arms.
    expect(result.governedOverall.point).toBe(0)
    expect(result.ungovernedOverall.point).toBe(0)

    // But the continuous score-lift captures the partial-progress difference.
    for (const pt of result.perTask) {
      expect(pt.governedScore).toBeCloseTo(0.75, 5)
      expect(pt.ungovernedScore).toBeCloseTo(0.5, 5)
      expect(pt.scoreLift).toBeCloseTo(0.25, 5)
    }
    expect(result.governedScoreMean.point).toBeCloseTo(0.75, 5)
    expect(result.ungovernedScoreMean.point).toBeCloseTo(0.5, 5)
    expect(result.liftMean).toBeCloseTo(0.25, 5)
  })
})
