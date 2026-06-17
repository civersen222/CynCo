import type { Condition, RunRecord, PerTaskResult, SuiteResult, TaskDef } from './types.js'
import { wilsonInterval, pairedBootstrapLift, meanBootstrap } from './stats.js'

export interface RunOneArgs {
  task: TaskDef
  condition: Condition
  rep: number
}

export type RunOne = (args: RunOneArgs) => Promise<{ passed: boolean; timedOut: boolean; turns: number; score: number }>

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
  conditions?: Condition[]   // default both; calibration passes ['ungoverned']
}): Promise<SuiteResult> {
  const conditions = opts.conditions ?? CONDITIONS
  const runs: RunRecord[] = []
  for (const task of opts.tasks) {
    for (const condition of conditions) {
      for (let rep = 1; rep <= opts.reps; rep++) {
        const r = await opts.runOne({ task, condition, rep })
        runs.push({ taskId: task.id, condition, rep, passed: r.passed, score: r.score, timedOut: r.timedOut, turns: r.turns })
      }
    }
  }

  const perTask: PerTaskResult[] = opts.tasks.map((task) => {
    const g = runs.filter((x) => x.taskId === task.id && x.condition === 'governed')
    const u = runs.filter((x) => x.taskId === task.id && x.condition === 'ungoverned')
    const governed = wilsonInterval(g.filter((x) => x.passed).length, g.length)
    const ungoverned = wilsonInterval(u.filter((x) => x.passed).length, u.length)
    const governedScore = g.length ? g.reduce((s, x) => s + x.score, 0) / g.length : 0
    const ungovernedScore = u.length ? u.reduce((s, x) => s + x.score, 0) / u.length : 0
    return {
      taskId: task.id,
      governed,
      ungoverned,
      lift: governed.point - ungoverned.point,
      governedScore,
      ungovernedScore,
      scoreLift: governedScore - ungovernedScore,
    }
  })

  const gAll = runs.filter((x) => x.condition === 'governed')
  const uAll = runs.filter((x) => x.condition === 'ungoverned')
  const governedOverall = wilsonInterval(gAll.filter((x) => x.passed).length, gAll.length)
  const ungovernedOverall = wilsonInterval(uAll.filter((x) => x.passed).length, uAll.length)
  const governedScoreMean = meanBootstrap(gAll.map((x) => x.score), 10000, 0.95, opts.bootstrapRng)
  const ungovernedScoreMean = meanBootstrap(uAll.map((x) => x.score), 10000, 0.95, opts.bootstrapRng)

  const boot = pairedBootstrapLift(perTask.map((p) => p.scoreLift), 10000, 0.95, opts.bootstrapRng)

  return {
    model: opts.model,
    timestamp: new Date().toISOString(),
    repsPerCondition: opts.reps,
    runs,
    perTask,
    governedOverall,
    ungovernedOverall,
    governedScoreMean,
    ungovernedScoreMean,
    liftMean: boot.meanLift,
    liftLower: boot.lower,
    liftUpper: boot.upper,
  }
}
