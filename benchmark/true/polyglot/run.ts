// benchmark/true/polyglot/run.ts
// CLI: bun benchmark/true/polyglot/run.ts [--lang go] [--exercise bowling]
//        [--smoke] [--resume] [--budget 60] [--out path.jsonl]
// Chunked execution: runs until the time budget can't fit another exercise
// (conservative worst case), then reports and exits. Re-run with --resume
// to continue. All state lives in the JSONL.
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../engine/config.js'
import { bootstrapProvider } from '../../../engine/bootstrapProvider.js'
import { LANGUAGES, type Exercise, type ExerciseRecord, type Language } from './types.js'
import {
  assertPristine, buildPrompt, buildRetryPrompt, discoverExercises,
  injectTests, removeTests, stageWorkdir,
} from './exercise.js'
import { appendRecord, completedKeys, fitsInBudget, loadRecords } from './records.js'
import { ensureImage, execInContainer, isEnvFailure, startContainer, stopContainer } from './container.js'
import { ExerciseSession } from './runLoop.js'
import { formatReport, summarize } from './report.js'

const TRY_TIMEOUT_MS = 8 * 60_000
const TEST_TIMEOUT_MS = 5 * 60_000

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

  const config = loadConfig()
  if (!config.model) {
    console.error('[polyglot] no model configured (set LOCALCODE_MODEL) — refusing to write unattributable evidence')
    process.exit(1)
  }
  const modelSlug = config.model.replace(/[^a-zA-Z0-9._-]/g, '-')
  const outPath = arg('--out', join(resultsDir, `polyglot${smoke ? '-smoke' : ''}-${modelSlug}.jsonl`))
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
  const prior = flag('--resume') ? loadRecords(outPath) : []
  const done = completedKeys(prior)
  const todo = exercises.filter((e) => !done.has(`${e.language}/${e.name}`))
  if (todo.length === 0) { log('[polyglot] nothing to do — all selected exercises recorded'); return }
  log(`[polyglot] ${todo.length} exercise(s) queued (${done.size} already recorded), model=${config.model}, budget=${budgetMs / 60_000}min`)

  const { provider } = await bootstrapProvider(config)

  const scratchRoot = join(tmpdir(), 'cynco-polyglot')
  mkdirSync(scratchRoot, { recursive: true })
  ensureImage(import.meta.dirname)
  startContainer(scratchRoot)

  const chunkStart = Date.now()
  let ranThisChunk = 0
  try {
    for (const ex of todo) {
      if (!fitsInBudget(Date.now() - chunkStart, budgetMs)) {
        log(`[polyglot] budget reached — stopping chunk cleanly (${ranThisChunk} exercise(s) this chunk)`)
        break
      }
      const rec = await runExercise(ex, config, provider, log)
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
  const remaining = exercises.length - all.length
  if (remaining > 0) {
    log(`\n[polyglot] ${remaining} exercise(s) remaining — continue with:`)
    log(`  bun benchmark/true/polyglot/run.ts --resume --budget ${budgetMs / 60_000}${smoke ? ' --smoke' : ''}`)
  }
  log(`[polyglot] results: ${outPath}`)
  log(`[polyglot] log: ${logPath}`)
}

async function runExercise(
  ex: Exercise,
  config: any,
  provider: any,
  log: (m: string) => void,
): Promise<ExerciseRecord> {
  const start = Date.now()
  const scratchRoot = join(tmpdir(), 'cynco-polyglot')
  const workdirName = `${ex.language}-${ex.name}`
  const workdir = stageWorkdir(ex, scratchRoot)
  const session = new ExerciseSession({ config, provider, cwd: workdir })
  const testCommand = LANGUAGES[ex.language].testCommand

  const tryDurationsMs: number[] = []
  let testDurationMs = 0
  let error: string | undefined
  let envFailure = false

  const runTests = () => {
    injectTests(ex, workdir)
    const res = execInContainer(workdirName, testCommand, TEST_TIMEOUT_MS)
    removeTests(ex, workdir)
    testDurationMs += res.durationMs
    // Spec: container death is fatal (fail fast, --resume continues after restart).
    if (/No such container/i.test(res.output)) {
      throw new Error('polyglot-bench container died mid-run — restart and re-run with --resume')
    }
    if (isEnvFailure(res)) envFailure = true
    return res
  }

  const finish = (passed: boolean, passedTry: 1 | 2 | null): ExerciseRecord => {
    rmSync(workdir, { recursive: true, force: true })
    return {
      language: ex.language, exercise: ex.name, passed, passedTry,
      durationMs: Date.now() - start, tryDurationsMs, testDurationMs,
      ...(error ? { error } : {}), ...(envFailure ? { envFailure: true } : {}),
    }
  }

  // Try 1: aider's exercise prompt.
  log(`[polyglot] ${ex.language}/${ex.name} try 1...`)
  const t1 = Date.now()
  const try1 = await session.sendTry(buildPrompt(ex), TRY_TIMEOUT_MS)
  tryDurationsMs.push(Date.now() - t1)
  if (try1.error) error = try1.error
  const test1 = runTests()
  if (test1.code === 0) return finish(true, 1)

  // Try 2: test output into the SAME loop (aider pass@2).
  log(`[polyglot] ${ex.language}/${ex.name} try 2 (tests failed)...`)
  const t2 = Date.now()
  const try2 = await session.sendTry(buildRetryPrompt(ex.solutionFiles, test1.output), TRY_TIMEOUT_MS)
  tryDurationsMs.push(Date.now() - t2)
  if (try2.error) error = [error, try2.error].filter(Boolean).join(' | ')
  const test2 = runTests()
  if (test2.code === 0) return finish(true, 2)
  return finish(false, null)
}

main().catch((err) => {
  console.error('[polyglot] fatal:', err)
  stopContainer()
  process.exit(1)
})
