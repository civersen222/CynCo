import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../engine/config.js'
import { bootstrapProvider } from '../../engine/bootstrapProvider.js'
import { loadCivkingsTasks } from './harness/tasks.js'
import { cloneRepo, checkoutRef, applyPatch, removeWorkdir } from './harness/isolate.js'
import { runTask, countTurns } from './harness/driver.js'
import { scorePytest } from './harness/scorer.js'
import { runSuite, type RunOneArgs } from './harness/orchestrate.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

async function main() {
  const civkingsRepo = arg('--civkings', 'C:\\Users\\civer\\civkings')
  const tasksDir = arg('--tasks', join(import.meta.dirname, 'tasks', 'civkings'))
  // Calibration mode: unaided (ungoverned-only) pilot to find which tasks land in
  // the discriminating 0.2-0.8 score band. Default 2 reps unless --reps given.
  const calibrate = flag('--calibrate')
  const reps = parseInt(arg('--reps', calibrate ? '2' : '3'), 10)
  if (!Number.isInteger(reps) || reps < 1) {
    console.error(`[true-bench] invalid --reps (must be a positive integer): ${arg('--reps', '3')}`)
    process.exit(1)
  }

  const config = loadConfig()
  if (!config.model) {
    console.error('[true-bench] no model configured (set LOCALCODE_MODEL) — refusing to write unattributable evidence')
    process.exit(1)
  }

  // Load tasks (cheap) and bail before standing up the provider if there's nothing to run.
  const tasks = loadCivkingsTasks(tasksDir)
  if (tasks.length === 0) { console.error(`[true-bench] no tasks in ${tasksDir}`); process.exit(1) }
  console.log(`[true-bench] ${tasks.length} task(s), reps=${reps}, model=${config.model}`)

  // Use the engine's real provider-selection logic so the benchmark drives the
  // exact backend the user runs in production (llama-cpp/llama-server + MTP for
  // the default profile, Ollama otherwise).
  const { provider } = await bootstrapProvider(config)

  const runOne = async ({ task, condition, rep }: RunOneArgs) => {
    const work = mkdtempSync(join(tmpdir(), `truebench-${task.id}-`))
    try {
      cloneRepo(civkingsRepo, work)
      checkoutRef(work, task.startRef)
      if (task.setupPatch) applyPatch(work, task.setupPatch)
      console.log(`[true-bench] ${task.id} ${condition} rep ${rep}...`)
      const driven = await runTask({
        prompt: task.prompt, cwd: work, governed: condition === 'governed',
        config, provider, timeoutMs: task.timeoutMs,
      })
      const score = scorePytest(work, task.hiddenTestPath, task.hiddenTestName)
      return { passed: score.passed, score: score.score, timedOut: driven.timedOut, turns: countTurns(driven.messages) }
    } finally {
      removeWorkdir(work)
    }
  }

  try {
    const result = await runSuite({
      tasks, reps, model: config.model, runOne,
      conditions: calibrate ? ['ungoverned'] : undefined,
    })

    const outDir = join(import.meta.dirname, 'results')
    mkdirSync(outDir, { recursive: true })
    const pct = (x: number) => (x * 100).toFixed(1)

    if (calibrate) {
      // Unaided pilot: report each task's mean ungoverned score and whether it
      // lands in the discriminating band. Saturators (<=0.2 or >=0.8) carry no
      // governance signal and should be dropped from the headline set.
      const outFile = join(outDir, `calibration-${Date.now()}.json`)
      const rows = result.perTask
        .map((p) => ({ taskId: p.taskId, score: p.ungovernedScore }))
        .sort((a, b) => a.score - b.score)
      const KEEP_LO = 0.2, KEEP_HI = 0.8
      const keep = rows.filter((r) => r.score >= KEEP_LO && r.score <= KEEP_HI).map((r) => r.taskId)
      writeFileSync(outFile, JSON.stringify({ model: result.model, repsPerCondition: reps, band: [KEEP_LO, KEEP_HI], rows, keep, full: result }, null, 2))
      console.log('\n=== CALIBRATION (unaided / ungoverned-only) ===')
      console.log(`model: ${result.model}  reps: ${reps}  band: keep if ${KEEP_LO}-${KEEP_HI}`)
      for (const r of rows) {
        const verdict = r.score < KEEP_LO ? 'DROP (too hard)' : r.score > KEEP_HI ? 'DROP (too easy)' : 'KEEP'
        console.log(`  ${pct(r.score).padStart(5)}%  ${r.taskId.padEnd(26)} ${verdict}`)
      }
      console.log(`keep (${keep.length}): ${keep.join(', ') || '(none)'}`)
      console.log(`results: ${outFile}`)
      return
    }

    const outFile = join(outDir, `true-ablation-${Date.now()}.json`)
    writeFileSync(outFile, JSON.stringify(result, null, 2))

    console.log('\n=== TRUE BENCHMARK (CivKings self-ablation) ===')
    console.log(`model: ${result.model}  reps/condition: ${result.repsPerCondition}`)
    // Headline is the CONTINUOUS per-assertion score (fraction of hidden-test
    // checks passed) — it carries gradient where binary pass/fail saturates.
    console.log(`governed   score: ${pct(result.governedScoreMean.point)}% ` +
      `[${pct(result.governedScoreMean.lower)}, ${pct(result.governedScoreMean.upper)}]`)
    console.log(`ungoverned score: ${pct(result.ungovernedScoreMean.point)}% ` +
      `[${pct(result.ungovernedScoreMean.lower)}, ${pct(result.ungovernedScoreMean.upper)}]`)
    console.log(`score-lift (governed-ungoverned): ${pct(result.liftMean)}% ` +
      `[${pct(result.liftLower)}, ${pct(result.liftUpper)}]  (paired bootstrap)`)
    // Secondary: binary full-pass rate (every assertion green), for comparison
    // with the Layer A binary numbers.
    console.log(`  [secondary] governed full-pass: ${pct(result.governedOverall.point)}%  ` +
      `ungoverned full-pass: ${pct(result.ungovernedOverall.point)}%`)
    const verdict = result.liftLower > 0 ? 'GOVERNANCE HELPS (score-lift CI excludes 0)'
      : result.liftUpper < 0 ? 'GOVERNANCE HURTS (score-lift CI excludes 0)'
      : 'INCONCLUSIVE (score-lift CI includes 0)'
    console.log(`verdict: ${verdict}`)
    console.log(`results: ${outFile}`)
  } finally {
    const pm = (globalThis as any).__llamaProcessManager
    if (pm) { try { await pm.stop() } catch {} }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
