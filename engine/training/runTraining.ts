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
import { homedir } from 'os'
import {
  evaluateReadiness,
  exportDatasets,
  loadTrajectories,
  summarizeCorpus,
  type DatasetStats,
} from './datasetBuilder.js'

const CYNCO_DIR = join(homedir(), '.cynco')
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
  for (const k of ['usableExamples', 'pairableNegatives', 'avgReward'] as const) {
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
      log('Aborting training.')
      return
    }
    log('Continuing anyway because --dry-run was passed (no weights are updated).')
  }

  log(`SFT dataset: ${stats.sftExamples} examples`)

  const outputDir = join(ADAPTER_DIR, `sft-${version}`)
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
  const adapterDir = join(ADAPTER_DIR, `sft-${version}`)
  if (!existsSync(adapterDir)) {
    log(`ERROR: Adapter not found at ${adapterDir}`)
    process.exit(1)
  }

  const scriptPath = join(__dirname, 'scripts', 'convert_and_promote.sh')
  const tag = `cynco-personalized:${version}`
  const cmd = `bash "${scriptPath}" --adapter "${adapterDir}" --base "${basePath}" --tag "${tag}"`

  log(`Running: ${cmd}`)

  try {
    execSync(cmd, { stdio: 'inherit', timeout: 600_000 })
    log(`Adapter promoted as: ${tag}`)
  } catch (e: any) {
    log(`Promotion failed: ${e.message ?? e}`)
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

const args = process.argv.slice(2)

/**
 * The first bare token that is not some flag's value.
 *
 * `args.find(a => !a.startsWith('-'))` read the VALUE of a preceding flag, so
 * `--base ./model --stage stats` resolved the stage to `./model`.
 */
const VALUE_FLAGS = new Set(['--stage', '--base', '--version'])
function positionalStage(a: string[]): string | undefined {
  for (let i = 0; i < a.length; i++) {
    if (VALUE_FLAGS.has(a[i])) { i++; continue }
    if (!a[i].startsWith('-')) return a[i]
  }
  return undefined
}

// An explicit --stage always wins over a positional.
const stage =
  (args.includes('--stage') ? args[args.indexOf('--stage') + 1] : undefined)
  ?? positionalStage(args)
  ?? 'stats'
const base = args[args.indexOf('--base') + 1] ?? 'unsloth/Qwen2.5-Coder-14B-Instruct'
const version = args[args.indexOf('--version') + 1] ?? 'v1'
const dryRun = args.includes('--dry-run')

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
