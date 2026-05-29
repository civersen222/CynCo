/**
 * Training Pipeline Orchestrator — end-to-end: backfill rewards → build
 * dataset → train → convert → promote.
 *
 * Usage:
 *   bun run engine/training/runTraining.ts --stage sft
 *   bun run engine/training/runTraining.ts --stage backfill
 *   bun run engine/training/runTraining.ts --stage dataset
 *   bun run engine/training/runTraining.ts --stage full
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { backfillRewards, exportDatasets, loadTrajectories, type DatasetStats } from './datasetBuilder.js'

const CYNCO_DIR = join(homedir(), '.cynco')
const TRAJECTORY_DIR = join(CYNCO_DIR, 'trajectories')
const REWARD_DIR = join(CYNCO_DIR, 'rewards')
const DATASET_DIR = join(CYNCO_DIR, 'datasets')
const ADAPTER_DIR = join(CYNCO_DIR, 'adapters')

function log(msg: string) {
  console.log(`[training] ${msg}`)
}

// ─── Stage: Backfill Rewards ──────────────────────────────────────

function stageBackfill(): number {
  log('Stage: Backfill rewards for unlabeled trajectories')
  const count = backfillRewards(TRAJECTORY_DIR, REWARD_DIR)
  log(`Backfilled ${count} task rewards`)
  return count
}

// ─── Stage: Build Dataset ─────────────────────────────────────────

function stageDataset(): DatasetStats {
  log('Stage: Build training datasets')
  const stats = exportDatasets(DATASET_DIR, TRAJECTORY_DIR, REWARD_DIR)

  log(`Total tasks: ${stats.totalTasks}`)
  log(`Tasks with rewards: ${stats.tasksWithRewards}`)
  log(`SFT examples: ${stats.sftExamples}`)
  log(`DPO pairs: ${stats.dpoPairs}`)
  log(`Average reward: ${stats.avgReward.toFixed(3)}`)
  for (const b of stats.rewardDistribution) {
    log(`  ${b.bucket}: ${b.count}`)
  }

  return stats
}

// ─── Stage: Train SFT ─────────────────────────────────────────────

function stageTrain(
  base: string,
  version: string,
  dryRun: boolean,
): void {
  const dataPath = join(DATASET_DIR, 'sft.jsonl')
  if (!existsSync(dataPath)) {
    log(`ERROR: No SFT dataset at ${dataPath}. Run --stage dataset first.`)
    process.exit(1)
  }

  // Count examples
  const lines = readFileSync(dataPath, 'utf-8').trim().split('\n').length
  log(`SFT dataset: ${lines} examples`)

  if (lines < 10) {
    log(`WARNING: Only ${lines} examples. Recommend 300+ for meaningful SFT.`)
    log('Continue collecting trajectory data from CynCo sessions before training.')
    if (!dryRun) {
      log('Aborting training — insufficient data.')
      return
    }
  }

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
  const trajectories = loadTrajectories(TRAJECTORY_DIR, REWARD_DIR)
  const withRewards = trajectories.filter(t => t.reward !== null)
  const totalTurns = trajectories.reduce((sum, t) => sum + t.turns.length, 0)

  log('=== Training Data Status ===')
  log(`Trajectory files: ${trajectories.length}`)
  log(`Total turns: ${totalTurns}`)
  log(`Tasks with rewards: ${withRewards.length}`)

  if (withRewards.length > 0) {
    const rewards = withRewards.map(t => t.reward!.reward)
    const avg = rewards.reduce((a, b) => a + b, 0) / rewards.length
    const good = rewards.filter(r => r >= 0.7).length
    log(`Average reward: ${avg.toFixed(3)}`)
    log(`High-reward tasks (>= 0.7): ${good}`)
    log(`Ready for SFT: ${good >= 10 ? 'YES' : 'NO'} (need 10+ high-reward, have ${good})`)
  } else {
    log('No rewards yet — run: bun run engine/training/runTraining.ts --stage backfill')
  }

  // Check for existing datasets
  const sftPath = join(DATASET_DIR, 'sft.jsonl')
  const dpoPath = join(DATASET_DIR, 'dpo.jsonl')
  if (existsSync(sftPath)) {
    const lines = readFileSync(sftPath, 'utf-8').trim().split('\n').length
    log(`SFT dataset: ${lines} examples`)
  }
  if (existsSync(dpoPath)) {
    const lines = readFileSync(dpoPath, 'utf-8').trim().split('\n').length
    log(`DPO dataset: ${lines} pairs`)
  }
}

// ─── CLI ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const stage = args.find(a => !a.startsWith('-'))
  ?? args[args.indexOf('--stage') + 1]
  ?? 'stats'
const base = args[args.indexOf('--base') + 1] ?? 'unsloth/Qwen2.5-Coder-14B-Instruct'
const version = args[args.indexOf('--version') + 1] ?? 'v1'
const dryRun = args.includes('--dry-run')

switch (stage) {
  case 'stats':
    stageStats()
    break
  case 'backfill':
    stageBackfill()
    stageStats()
    break
  case 'dataset':
    stageBackfill()
    stageDataset()
    break
  case 'sft':
    stageTrain(base, version, dryRun)
    break
  case 'promote':
    stagePromote(version, base)
    break
  case 'full':
    stageBackfill()
    stageDataset()
    stageTrain(base, version, dryRun)
    stagePromote(version, base)
    break
  default:
    log(`Unknown stage: ${stage}`)
    log('Available stages: stats, backfill, dataset, sft, promote, full')
    process.exit(1)
}
