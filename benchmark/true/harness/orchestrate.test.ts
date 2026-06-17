import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      runOne: async ({ condition }) => ({ passed: condition === 'governed', timedOut: false, turns: 2 }),
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
      runOne: async () => ({ passed: true, timedOut: false, turns: 1 }),
      bootstrapRng: () => 0,
    })
    expect(result.liftMean).toBe(0)
    expect(result.governedOverall.point).toBe(1)
    expect(result.ungovernedOverall.point).toBe(1)
  })
})
