/**
 * Grounding-gate A/B benchmark.
 *
 * Question: does the grounding gate (fire on concept-collision edits) actually
 * improve task outcomes, or is it — like the rest of VSM — outcome-neutral?
 *
 * Design: hold EVERYTHING constant except the grounding gate. Both arms run with
 * the rest of the VSM layer ablated (`_ABLATION_VSM_DISABLED=1`, established as
 * outcome-neutral in the Layer B deepdive), so the only variable is the gate:
 *
 *   ground-ON  (labelled 'governed')   : VSM off, grounding gate ACTIVE
 *   ground-OFF (labelled 'ungoverned') : VSM off, grounding gate DISABLED
 *                                        (`_ABLATION_GROUNDING_DISABLED=1`)
 *
 * The orchestrator's `liftMean = governedScore - ungovernedScore` therefore reads
 * as (grounding-on - grounding-off). We reuse the exact isolation, scoring and
 * paired-bootstrap machinery from the Layer B harness so the statistics are
 * identical and comparable.
 *
 * Backend: the production provider via bootstrapProvider (llama-cpp default,
 * Ollama fallback) — same as run.ts, so this drives the real backend.
 *
 * Run:
 *   bun benchmark/true/grounding/abRun.ts --reps 4
 *   bun benchmark/true/grounding/abRun.ts --task city-yield-consumers --reps 1   # smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../engine/config.js'
import { bootstrapProvider } from '../../../engine/bootstrapProvider.js'
import { loadCivkingsTasks } from '../harness/tasks.js'
import { cloneRepo, checkoutRef, applyPatch, removeWorkdir } from '../harness/isolate.js'
import { runTask, countTurns } from '../harness/driver.js'
import { scorePytest } from '../harness/scorer.js'
import { runSuite, type RunOneArgs } from '../harness/orchestrate.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const civkingsRepo = arg('--civkings', 'C:\\Users\\civer\\civkings')
  const tasksDir = arg('--tasks', join(import.meta.dirname, '..', 'tasks', 'civkings-b'))
  const onlyTask = arg('--task', 'city-yield-consumers') // grounding fires on the happiness collision here
  const reps = parseInt(arg('--reps', '3'), 10)
  if (!Number.isInteger(reps) || reps < 1) { console.error(`[grounding-ab] invalid --reps: ${arg('--reps', '3')}`); process.exit(1) }

  const config = loadConfig()
  if (!config.model) { console.error('[grounding-ab] no model configured'); process.exit(1) }

  // Start from a clean grounding rates file so the gate fail-opens (fires) at the
  // start of the ON arm rather than inheriting a stale, possibly-suppressed rate.
  const ratesFile = join(homedir(), '.cynco', 'training', 'intervention-rates.json')
  if (existsSync(ratesFile)) {
    const bak = ratesFile + `.bak-${Date.now()}`
    rmSync(ratesFile, { force: true })
    console.log(`[grounding-ab] cleared pre-existing rates file (was backed up conceptually as ${bak})`)
  }

  const all = loadCivkingsTasks(tasksDir)
  const tasks = onlyTask === 'ALL' ? all : all.filter((t) => t.id === onlyTask)
  if (tasks.length === 0) { console.error(`[grounding-ab] no task '${onlyTask}' in ${tasksDir} (have: ${all.map((t) => t.id).join(', ')})`); process.exit(1) }
  console.log(`[grounding-ab] PINNED MODE: ON arm fires on every collision (tracker back-off bypassed)`)
  console.log(`[grounding-ab] ${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ')}  reps=${reps}  model=${config.model}`)

  const { provider } = await bootstrapProvider(config)

  const runOne = async ({ task, condition, rep }: RunOneArgs) => {
    const groundingOn = condition === 'governed'
    // Both arms: VSM held off (governed:false below). Toggle ONLY the grounding gate.
    // PINNED MODE: in the ON arm we pin the firing side armed (_PIN_GROUNDING=1) so the
    // gate fires on EVERY collision edit, bypassing the InterventionTracker back-off that
    // silenced the gate after one unresolved fire in the unpinned reps=8 run. This isolates
    // the gate's true effect from its self-disabling behaviour.
    if (groundingOn) {
      delete process.env._ABLATION_GROUNDING_DISABLED
      process.env._PIN_GROUNDING = '1'
    } else {
      process.env._ABLATION_GROUNDING_DISABLED = '1'
      delete process.env._PIN_GROUNDING
    }

    const work = mkdtempSync(join(tmpdir(), `groundab-${task.id}-`))
    try {
      cloneRepo(civkingsRepo, work)
      checkoutRef(work, task.startRef)
      if (task.setupPatch) applyPatch(work, task.setupPatch)
      console.log(`[grounding-ab] ${task.id} grounding=${groundingOn ? 'ON ' : 'OFF'} rep ${rep}...`)
      const driven = await runTask({
        prompt: task.prompt, cwd: work,
        governed: false, // VSM ablated in BOTH arms — isolate the gate
        config, provider, timeoutMs: task.timeoutMs,
      })
      const score = scorePytest(work, task.hiddenTestPath, task.hiddenTestName)
      console.log(`[grounding-ab]   -> grounding=${groundingOn ? 'ON ' : 'OFF'} score=${(score.score * 100).toFixed(1)}% pass=${score.passed} turns=${countTurns(driven.messages)}${driven.timedOut ? ' TIMEOUT' : ''}`)
      return { passed: score.passed, score: score.score, timedOut: driven.timedOut, turns: countTurns(driven.messages) }
    } finally {
      removeWorkdir(work)
      delete process.env._ABLATION_GROUNDING_DISABLED
      delete process.env._PIN_GROUNDING
    }
  }

  try {
    const result = await runSuite({ tasks, reps, model: config.model, runOne })

    const outDir = join(import.meta.dirname, '..', 'results')
    mkdirSync(outDir, { recursive: true })
    const outFile = join(outDir, `grounding-ab-pinned-${Date.now()}.json`)
    // Persist with grounding-explicit labels alongside the raw suite result.
    writeFileSync(outFile, JSON.stringify({
      experiment: 'grounding-gate-isolation-PINNED',
      arms: { governed: 'grounding-ON pinned (VSM off)', ungoverned: 'grounding-OFF (VSM off)' },
      groundingOnScore: result.governedScoreMean,
      groundingOffScore: result.ungovernedScoreMean,
      groundingLift: { mean: result.liftMean, lower: result.liftLower, upper: result.liftUpper },
      full: result,
    }, null, 2))

    const pct = (x: number) => (x * 100).toFixed(1)
    console.log('\n=== GROUNDING-GATE A/B (CivKings, VSM held off in both arms) ===')
    console.log(`model: ${result.model}  reps/arm: ${result.repsPerCondition}  tasks: ${tasks.map((t) => t.id).join(', ')}`)
    console.log(`grounding ON  score: ${pct(result.governedScoreMean.point)}% [${pct(result.governedScoreMean.lower)}, ${pct(result.governedScoreMean.upper)}]`)
    console.log(`grounding OFF score: ${pct(result.ungovernedScoreMean.point)}% [${pct(result.ungovernedScoreMean.lower)}, ${pct(result.ungovernedScoreMean.upper)}]`)
    console.log(`score-lift (ON - OFF): ${pct(result.liftMean)}% [${pct(result.liftLower)}, ${pct(result.liftUpper)}]  (paired bootstrap)`)
    for (const p of result.perTask) {
      console.log(`  ${p.taskId.padEnd(26)} ON ${pct(p.governedScore).padStart(6)}%  OFF ${pct(p.ungovernedScore).padStart(6)}%  lift ${pct(p.scoreLift).padStart(6)}%`)
    }
    const verdict = result.liftLower > 0 ? 'GROUNDING HELPS (score-lift CI excludes 0)'
      : result.liftUpper < 0 ? 'GROUNDING HURTS (score-lift CI excludes 0)'
      : 'INCONCLUSIVE (score-lift CI includes 0)'
    console.log(`verdict: ${verdict}`)
    console.log(`results: ${outFile}`)
  } finally {
    const pm = (globalThis as any).__llamaProcessManager
    if (pm) { try { await pm.stop() } catch {} }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
