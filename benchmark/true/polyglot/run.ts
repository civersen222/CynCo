// benchmark/true/polyglot/run.ts
// CLI: bun benchmark/true/polyglot/run.ts [--lang go] [--exercise bowling]
//        [--smoke] [--resume] [--budget 60] [--out path.jsonl]
// Chunked execution: runs until the time budget can't fit another exercise
// (conservative worst case), then reports and exits. Re-run with --resume
// to continue. All state lives in the JSONL. Thin wiring only — the pass@2
// protocol lives in orchestrate.ts (tested), everything else in the modules.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../engine/config.js'
import { bootstrapProvider } from '../../../engine/bootstrapProvider.js'
import { type Language } from './types.js'
import { assertPristine, discoverExercises } from './exercise.js'
import { appendRecord, completedKeys, fitsInBudget, loadRecords, WORST_CASE_MS } from './records.js'
import { ensureImage, execInContainer, startContainer, stopContainer } from './container.js'
import { ExerciseSession } from './runLoop.js'
import { runExercise } from './orchestrate.js'
import { formatReport, summarize } from './report.js'

const TRY_TIMEOUT_MS = 8 * 60_000
const TEST_TIMEOUT_MS = 5 * 60_000
const SCRATCH_ROOT = join(tmpdir(), 'cynco-polyglot')

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(name)

async function main() {
  const exercisesRoot = join(import.meta.dirname, '..', '..', 'polyglot-exercises')
  const resultsDir = join(import.meta.dirname, '..', 'results')
  const smoke = flag('--smoke')
  const budgetMs = parseInt(arg('--budget', '60'), 10) * 60_000
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    console.error('[polyglot] invalid --budget'); process.exit(1)
  }
  if (budgetMs < WORST_CASE_MS) {
    console.error(
      `[polyglot] --budget ${budgetMs / 60_000}min is below the per-exercise worst case ` +
        `(${WORST_CASE_MS / 60_000}min) — nothing would run. Use --budget ${WORST_CASE_MS / 60_000} or more.`,
    )
    process.exit(1)
  }

  const config = loadConfig()
  if (!config.model) {
    console.error('[polyglot] no model configured (set LOCALCODE_MODEL) — refusing to write unattributable evidence')
    process.exit(1)
  }
  const modelSlug = config.model.replace(/[^a-zA-Z0-9._-]/g, '-')
  const outPath = arg('--out', join(resultsDir, `polyglot${smoke ? '-smoke' : ''}-${modelSlug}.jsonl`))
  const resume = flag('--resume')
  if (existsSync(outPath) && !resume) {
    console.error(
      `[polyglot] ${outPath} already exists — pass --resume to continue it, ` +
        `or move it aside for a fresh run (records for already-recorded exercises would be silently ignored otherwise)`,
    )
    process.exit(1)
  }
  const logPath = join(resultsDir, `polyglot-${Date.now()}.log`)
  mkdirSync(resultsDir, { recursive: true })
  const log = (msg: string) => { console.log(msg); appendFileSync(logPath, msg + '\n') }

  // Validity gate: mutated stubs/tests would invalidate every result.
  assertPristine(exercisesRoot)

  let exercises = discoverExercises(exercisesRoot, {
    lang: arg('--lang', '') || undefined,
    exercise: arg('--exercise', '') || undefined,
  })
  if (smoke) {
    // 1 exercise per language (alphabetically first) — the pre-flight gate.
    const seen = new Set<Language>()
    exercises = exercises.filter((e) => (seen.has(e.language) ? false : (seen.add(e.language), true)))
  }
  const prior = resume ? loadRecords(outPath) : []
  const done = completedKeys(prior)
  const todo = exercises.filter((e) => !done.has(`${e.language}/${e.name}`))
  if (todo.length === 0) { log('[polyglot] nothing to do — all selected exercises recorded'); return }
  log(`[polyglot] ${todo.length} exercise(s) queued (${done.size} already recorded), model=${config.model}, budget=${budgetMs / 60_000}min`)

  const { provider } = await bootstrapProvider(config)

  mkdirSync(SCRATCH_ROOT, { recursive: true })
  ensureImage(import.meta.dirname)
  startContainer(SCRATCH_ROOT)

  const chunkStart = Date.now()
  let ranThisChunk = 0
  try {
    for (const ex of todo) {
      if (!fitsInBudget(Date.now() - chunkStart, budgetMs)) {
        log(`[polyglot] budget reached — stopping chunk cleanly (${ranThisChunk} exercise(s) this chunk)`)
        break
      }
      const rec = await runExercise(ex, {
        makeSession: (workdir) => new ExerciseSession({ config, provider, cwd: workdir }),
        exec: execInContainer,
        assertSourcePristine: () => assertPristine(exercisesRoot),
        scratchRoot: SCRATCH_ROOT,
        log,
        tryTimeoutMs: TRY_TIMEOUT_MS,
        testTimeoutMs: TEST_TIMEOUT_MS,
      })
      appendRecord(outPath, rec)
      ranThisChunk++
      log(`[polyglot] ${rec.passed ? 'PASS' : 'FAIL'}${rec.envFailure ? ' (env)' : ''} ${ex.language}/${ex.name} try=${rec.passedTry ?? '-'} ${(rec.durationMs / 1000).toFixed(0)}s`)
    }
  } finally {
    stopContainer()
  }

  const all = loadRecords(outPath)
  log('')
  log(formatReport(summarize(all), config.model))
  const doneAfter = completedKeys(all)
  const remaining = exercises.filter((e) => !doneAfter.has(`${e.language}/${e.name}`)).length
  if (remaining > 0) {
    log(`\n[polyglot] ${remaining} exercise(s) remaining — continue with:`)
    log(`  bun benchmark/true/polyglot/run.ts --resume --budget ${budgetMs / 60_000}${smoke ? ' --smoke' : ''}`)
  }
  log(`[polyglot] results: ${outPath}`)
  log(`[polyglot] log: ${logPath}`)
}

main().catch((err) => {
  console.error('[polyglot] fatal:', err)
  stopContainer()
  process.exit(1)
})
