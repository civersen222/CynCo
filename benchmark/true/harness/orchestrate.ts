import type { Condition, RunRecord, PerTaskResult, SuiteResult, TaskDef } from './types.js'
import { wilsonInterval, pairedBootstrapLift } from './stats.js'

export interface RunOneArgs {
  task: TaskDef
  condition: Condition
  rep: number
}

export type RunOne = (args: RunOneArgs) => Promise<{ passed: boolean; timedOut: boolean; turns: number }>

const CONDITIONS: Condition[] = ['governed', 'ungoverned']

/**
 * Run the full matrix. `runOne` performs one isolated task run (clone -> drive ->
 * score); it is injected so the orchestrator's aggregation is unit-testable
 * without a live model.
 */
export async function runSuite(opts: {
  tasks: TaskDef[]
  reps: number
  model: string
  runOne: RunOne
  bootstrapRng?: () => number
}): Promise<SuiteResult> {
  const runs: RunRecord[] = []
  for (const task of opts.tasks) {
    for (const condition of CONDITIONS) {
      for (let rep = 1; rep <= opts.reps; rep++) {
        const r = await opts.runOne({ task, condition, rep })
        runs.push({ taskId: task.id, condition, rep, passed: r.passed, timedOut: r.timedOut, turns: r.turns })
      }
    }
  }

  const perTask: PerTaskResult[] = opts.tasks.map((task) => {
    const g = runs.filter((x) => x.taskId === task.id && x.condition === 'governed')
    const u = runs.filter((x) => x.taskId === task.id && x.condition === 'ungoverned')
    const governed = wilsonInterval(g.filter((x) => x.passed).length, g.length)
    const ungoverned = wilsonInterval(u.filter((x) => x.passed).length, u.length)
    return { taskId: task.id, governed, ungoverned, lift: governed.point - ungoverned.point }
  })

  const gAll = runs.filter((x) => x.condition === 'governed')
  const uAll = runs.filter((x) => x.condition === 'ungoverned')
  const governedOverall = wilsonInterval(gAll.filter((x) => x.passed).length, gAll.length)
  const ungovernedOverall = wilsonInterval(uAll.filter((x) => x.passed).length, uAll.length)

  const boot = pairedBootstrapLift(perTask.map((p) => p.lift), 10000, 0.95, opts.bootstrapRng)

  return {
    model: opts.model,
    timestamp: new Date().toISOString(),
    repsPerCondition: opts.reps,
    runs,
    perTask,
    governedOverall,
    ungovernedOverall,
    liftMean: boot.meanLift,
    liftLower: boot.lower,
    liftUpper: boot.upper,
  }
}
