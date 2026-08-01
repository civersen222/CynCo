/**
 * Training Pipeline Orchestrator — build dataset → gate → train → convert →
 * promote.
 *
 * There is no backfill stage. Rewards are written by the live engine at task
 * end (see conversationLoop.finalizeTrajectory); the offline heuristic that
 * used to manufacture them was deleted on 2026-07-25.
 *
 * Usage:
 *   bun run engine/training/runTraining.ts --stage stats
 *   bun run engine/training/runTraining.ts --stage dataset
 *   bun run engine/training/runTraining.ts --stage sft
 *   bun run engine/training/runTraining.ts --stage full
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  evaluateReadiness,
  exportDatasets,
  loadTrajectories,
  summarizeCorpus,
  type DatasetStats,
} from './datasetBuilder.js'
import { parseTrainingArgs } from './trainingArgs.js'
import { adapterNames } from './adapterNames.js'
import { resolveAdapter } from '../llama/modelResolver.js'
import { cyncoHome } from '../paths.js'

const CYNCO_DIR = cyncoHome()
const TRAJECTORY_DIR = join(CYNCO_DIR, 'trajectories')
const REWARD_DIR = join(CYNCO_DIR, 'rewards')
const DATASET_DIR = join(CYNCO_DIR, 'datasets')
const ADAPTER_DIR = join(CYNCO_DIR, 'adapters')

function log(msg: string) {
  console.log(`[training] ${msg}`)
}

// ─── Stage: Build Dataset ─────────────────────────────────────────

function stageDataset(): DatasetStats {
  log('Stage: Build training datasets')
  const stats = exportDatasets(DATASET_DIR, TRAJECTORY_DIR, REWARD_DIR)

  log(`Total tasks: ${stats.totalTasks}`)
  log(`Tasks with rewards: ${stats.tasksWithRewards}`)
  log(`Usable examples: ${stats.usableExamples}`)
  log(`Negative examples: ${stats.negativeExamples} (${stats.pairableNegatives} pairable)`)
  log(`Legacy excluded (labeler v1): ${stats.legacyExcluded}`)
  log(`SFT examples: ${stats.sftExamples}`)
  log(`DPO pairs: ${stats.dpoPairs}`)
  log(`Average reward: ${stats.usableExamples > 0 ? stats.avgReward.toFixed(3) : 'not measured'}`)
  for (const b of stats.rewardDistribution) {
    log(`  ${b.bucket}: ${b.count}`)
  }

  return stats
}

// ─── Readiness reporting ──────────────────────────────────────────

/** Print each condition and, when it failed, why — in its own numbers. */
function logReadiness(readiness: ReturnType<typeof evaluateReadiness>): void {
  log('Readiness:')
  for (const c of readiness.conditions) {
    log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.display} (need ${c.required})`)
    if (c.reason) log(`         ${c.reason}`)
  }
}

// ─── Stage: Train SFT ─────────────────────────────────────────────

function stageTrain(
  base: string,
  version: string,
  dryRun: boolean,
): void {
  const statsPath = join(DATASET_DIR, 'stats.json')
  const dataPath = join(DATASET_DIR, 'sft.jsonl')
  if (!existsSync(dataPath) || !existsSync(statsPath)) {
    log(`ERROR: No dataset at ${DATASET_DIR}. Run --stage dataset first.`)
    process.exit(1)
  }

  let stats: DatasetStats
  try {
    stats = JSON.parse(readFileSync(statsPath, 'utf-8'))
  } catch (e) {
    log(`ERROR: ${statsPath} is not valid JSON (${e}). Run --stage dataset.`)
    process.exit(1)
  }
  // A stats.json written before the grounded labeler has none of these fields,
  // and the gate would then report a shortfall of "undefined". Refuse to read a
  // corpus shape we cannot actually measure.
  //
  // sftExamples and dpoPairs are required HERE specifically: evaluateReadiness
  // treats them as optional because the dashboard cannot compute them, but this
  // is the gate that actually decides whether to train, and it must check the
  // rows that were built and not only the rows that looked eligible.
  for (const k of ['usableExamples', 'pairableNegatives', 'avgReward', 'sftExamples', 'dpoPairs'] as const) {
    if (typeof stats[k] !== 'number') {
      log(`ERROR: ${statsPath} has no ${k}. It predates the grounded labeler. Run --stage dataset.`)
      process.exit(1)
    }
  }
  const readiness = evaluateReadiness(stats)

  logReadiness(readiness)

  if (!readiness.ready) {
    log('Corpus is not ready. Volume is not readiness — a corpus with no failures')
    log('teaches the model that its failure modes are excellent work.')
    if (!dryRun) {
      // Non-zero, because a refusal to train is not a successful training run.
      // It also stops `--stage full` here, which would otherwise go on to
      // promote whatever adapter a PREVIOUS run left at this version.
      log('Aborting training.')
      process.exit(1)
    }
    log('Continuing anyway because --dry-run was passed (no weights are updated).')
  }

  log(`SFT dataset: ${stats.sftExamples} examples`)

  const outputDir = join(ADAPTER_DIR, adapterNames(version).dir)
  mkdirSync(outputDir, { recursive: true })

  const scriptPath = join(__dirname, 'scripts', 'train_sft.py')
  const cmd = [
    'python3', scriptPath,
    '--data', dataPath,
    '--output', outputDir,
    '--base', base,
    dryRun ? '--dry-run' : '',
  ].filter(Boolean).join(' ')

  log(`Running: ${cmd}`)

  try {
    execSync(cmd, {
      stdio: 'inherit',
      timeout: 3600_000, // 1 hour
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' },
    })
    log(`Training complete → ${outputDir}`)
  } catch (e: any) {
    log(`Training failed: ${e.message ?? e}`)
    process.exit(1)
  }
}

// ─── Stage: Convert & Promote ─────────────────────────────────────

function stagePromote(version: string, basePath: string): void {
  const names = adapterNames(version)
  const adapterDir = join(ADAPTER_DIR, names.dir)
  if (!existsSync(adapterDir)) {
    log(`ERROR: Adapter not found at ${adapterDir}`)
    process.exit(1)
  }

  const scriptPath = join(__dirname, 'scripts', 'convert_and_promote.sh')
  const cmd = `bash "${scriptPath}" --adapter "${adapterDir}" --base "${basePath}"`
    + ` --name "${names.file}" --tag "${names.ollamaTag}"`

  log(`Running: ${cmd}`)

  try {
    execSync(cmd, { stdio: 'inherit', timeout: 600_000 })
  } catch (e: any) {
    // Non-zero. This catch used to log and return, so a promotion that failed
    // and a promotion that worked were the same exit code to every caller.
    log(`Promotion failed: ${e.message ?? e}`)
    process.exit(1)
  }

  // The claim "promoted" is checkable, so check it rather than announce it.
  // The colon defect below produced a file the engine could never resolve
  // while this stage printed success — see adapterNames.ts.
  try {
    const path = resolveAdapter(names.file, ADAPTER_DIR)
    log(`Adapter promoted: ${path}`)
    log(`To use it: set LOCALCODE_ADAPTER=${names.file}`)
  } catch (e: any) {
    log(`Promotion reported success but the engine cannot load the result: ${e.message ?? e}`)
    process.exit(1)
  }
}

// ─── Stage: Stats (read-only) ─────────────────────────────────────

function stageStats(): void {
  const trajectories = loadTrajectories(TRAJECTORY_DIR, REWARD_DIR, { loadSnapshots: false })
  const stats = summarizeCorpus(trajectories)
  const totalTurns = trajectories.reduce((sum, t) => sum + t.turns.length, 0)
  const readiness = evaluateReadiness(stats)

  log('=== Training Data Status ===')
  log(`Trajectory files: ${stats.totalTasks}`)
  log(`Total turns: ${totalTurns}`)
  log(`Tasks with rewards: ${stats.tasksWithRewards}`)
  log(`Usable examples: ${stats.usableExamples}`)
  log(`Negative examples: ${stats.negativeExamples} (${stats.pairableNegatives} pairable)`)
  log(`Legacy excluded (labeler v1): ${stats.legacyExcluded}`)
  log(
    'Average reward (usable only): ' +
    (stats.usableExamples > 0 ? stats.avgReward.toFixed(3) : 'not measured'),
  )

  logReadiness(readiness)
  log(`Ready for SFT: ${readiness.ready ? 'YES' : 'NO'}`)

  const sftPath = join(DATASET_DIR, 'sft.jsonl')
  const dpoPath = join(DATASET_DIR, 'dpo.jsonl')
  if (existsSync(sftPath)) {
    const body = readFileSync(sftPath, 'utf-8').trim()
    log(`SFT dataset on disk: ${body ? body.split('\n').length : 0} examples`)
  }
  if (existsSync(dpoPath)) {
    const body = readFileSync(dpoPath, 'utf-8').trim()
    log(`DPO dataset on disk: ${body ? body.split('\n').length : 0} pairs`)
  }
}

// ─── CLI ──────────────────────────────────────────────────────────

// One parser for all four flags, in a module that can be imported without
// running a training stage. The stage reader here had already been repaired for
// the `indexOf` -1 bug and `--base`/`--version` had not, so `--stage sft`
// trained against a base model literally named `--stage`.
// See engine/__tests__/training/trainingArgs.test.ts.
const { stage, base, version, dryRun } = parseTrainingArgs(process.argv.slice(2))

switch (stage) {
  case 'stats':
    stageStats()
    break
  case 'dataset':
    stageDataset()
    break
  case 'sft':
    stageTrain(base, version, dryRun)
    break
  case 'promote':
    stagePromote(version, base)
    break
  case 'full':
    stageDataset()
    stageTrain(base, version, dryRun)
    stagePromote(version, base)
    break
  default:
    log(`Unknown stage: ${stage}`)
    log('Available stages: stats, dataset, sft, promote, full')
    process.exit(1)
}
