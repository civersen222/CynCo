/**
 * DatasetBuilder — converts trajectory + reward data into training datasets.
 *
 * Reads trajectory JSONL files and their associated reward files, filters
 * by reward threshold, and outputs ChatML-format records for Unsloth SFT
 * and (chosen, rejected) pairs for DPO.
 *
 * Output formats:
 *   SFT:  { messages: [{ role, content }] }  — one per trajectory
 *   DPO:  { chosen: [{ role, content }], rejected: [{ role, content }] }
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { computeReward, finalizeTask, type RewardComponents, type TaskReward } from './rewardLabeler.js'

// ─── Types ────────────────────────────────────────────────────────

type TurnRecord = {
  task_id: string
  turn_idx: number
  ts: string
  model: string
  adapter_id?: string
  tool_calls: { name: string; inputHash: string; success: boolean; latencyMs: number }[]
  state_features: {
    filesTouched: number; diffSize: number; testsTotal: number
    testsFailing: number; toolsUsed: string[]; contextPct: number
  }
  reward_components: {
    toolSuccessRate: number; stuckTurns: number; varietyEntropy: number
  }
}

type TrajectoryWithReward = {
  taskId: string
  turns: TurnRecord[]
  reward: TaskReward | null
}

export type DatasetStats = {
  totalTasks: number
  tasksWithRewards: number
  sftExamples: number
  dpoPairs: number
  avgReward: number
  rewardDistribution: { bucket: string; count: number }[]
}

// ─── Core Functions ───────────────────────────────────────────────

/**
 * Load all trajectories with their rewards from disk.
 */
export function loadTrajectories(
  trajectoryDir?: string,
  rewardDir?: string,
): TrajectoryWithReward[] {
  const trajDir = trajectoryDir ?? join(homedir(), '.cynco', 'trajectories')
  const rewDir = rewardDir ?? join(homedir(), '.cynco', 'rewards')

  if (!existsSync(trajDir)) return []

  const files = readdirSync(trajDir).filter(f => f.endsWith('.jsonl'))
  const results: TrajectoryWithReward[] = []

  for (const file of files) {
    const taskId = file.replace('.jsonl', '')
    const lines = readFileSync(join(trajDir, file), 'utf-8')
      .trim()
      .split('\n')
      .filter(l => l.trim())

    const turns: TurnRecord[] = []
    for (const line of lines) {
      try {
        turns.push(JSON.parse(line))
      } catch {}
    }

    if (turns.length === 0) continue

    // Load reward if it exists
    let reward: TaskReward | null = null
    const rewardPath = join(rewDir, `${taskId}.reward.json`)
    if (existsSync(rewardPath)) {
      try {
        reward = JSON.parse(readFileSync(rewardPath, 'utf-8'))
      } catch {}
    }

    results.push({ taskId, turns, reward })
  }

  return results
}

/**
 * Build SFT dataset: filter trajectories by reward threshold,
 * convert to ChatML format for Unsloth training.
 *
 * Each trajectory becomes one training example with the full
 * tool-call conversation as the assistant's output.
 */
export function buildSFTDataset(
  trajectories: TrajectoryWithReward[],
  rewardThreshold = 0.7,
): string[] {
  const examples: string[] = []

  for (const traj of trajectories) {
    if (!traj.reward || traj.reward.reward < rewardThreshold) continue

    // Build ChatML conversation from trajectory turns
    const messages: { role: string; content: string }[] = []

    // System message
    messages.push({
      role: 'system',
      content: 'You are CynCo, a local AI coding assistant. Use tools to complete tasks.',
    })

    // User task (reconstructed from first turn context)
    messages.push({
      role: 'user',
      content: `Task ${traj.taskId} (${traj.turns.length} turns, reward ${traj.reward.reward.toFixed(2)})`,
    })

    // Assistant turns: tool calls as structured content
    const toolSequence = traj.turns
      .flatMap(t => t.tool_calls)
      .map(tc => `${tc.name}(${tc.success ? 'ok' : 'FAIL'}, ${tc.latencyMs}ms)`)
      .join(' → ')

    messages.push({
      role: 'assistant',
      content: `Tool sequence: ${toolSequence}`,
    })

    examples.push(JSON.stringify({ messages }))
  }

  return examples
}

/**
 * Build DPO dataset: pair high-reward and low-reward trajectories
 * for the same task type (or similar tasks).
 */
export function buildDPODataset(
  trajectories: TrajectoryWithReward[],
  chosenMinReward = 0.7,
  rejectedMaxReward = 0.3,
): string[] {
  const pairs: string[] = []

  // Group by model for fair comparison
  const byModel = new Map<string, TrajectoryWithReward[]>()
  for (const t of trajectories) {
    if (!t.reward) continue
    const model = t.turns[0]?.model ?? 'unknown'
    if (!byModel.has(model)) byModel.set(model, [])
    byModel.get(model)!.push(t)
  }

  for (const [, group] of byModel) {
    const chosen = group.filter(t => t.reward!.reward >= chosenMinReward)
    const rejected = group.filter(t => t.reward!.reward <= rejectedMaxReward)

    // Create pairs: each chosen paired with each rejected
    for (const c of chosen) {
      for (const r of rejected) {
        const chosenTools = c.turns.flatMap(t => t.tool_calls).map(tc => `${tc.name}(${tc.success ? 'ok' : 'FAIL'})`).join(' → ')
        const rejectedTools = r.turns.flatMap(t => t.tool_calls).map(tc => `${tc.name}(${tc.success ? 'ok' : 'FAIL'})`).join(' → ')

        pairs.push(JSON.stringify({
          chosen: [
            { role: 'system', content: 'You are CynCo, a local AI coding assistant.' },
            { role: 'user', content: 'Complete the coding task.' },
            { role: 'assistant', content: chosenTools },
          ],
          rejected: [
            { role: 'system', content: 'You are CynCo, a local AI coding assistant.' },
            { role: 'user', content: 'Complete the coding task.' },
            { role: 'assistant', content: rejectedTools },
          ],
        }))
      }
    }
  }

  return pairs
}

/**
 * Export datasets to disk for Unsloth consumption.
 */
export function exportDatasets(
  outputDir?: string,
  trajectoryDir?: string,
  rewardDir?: string,
): DatasetStats {
  const outDir = outputDir ?? join(homedir(), '.cynco', 'datasets')
  mkdirSync(outDir, { recursive: true })

  const trajectories = loadTrajectories(trajectoryDir, rewardDir)
  const withRewards = trajectories.filter(t => t.reward !== null)

  // SFT dataset
  const sftExamples = buildSFTDataset(trajectories)
  if (sftExamples.length > 0) {
    writeFileSync(join(outDir, 'sft.jsonl'), sftExamples.join('\n') + '\n')
  }

  // DPO dataset
  const dpoPairs = buildDPODataset(trajectories)
  if (dpoPairs.length > 0) {
    writeFileSync(join(outDir, 'dpo.jsonl'), dpoPairs.join('\n') + '\n')
  }

  // Compute stats
  const rewards = withRewards.map(t => t.reward!.reward)
  const avgReward = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0

  const distribution = [
    { bucket: 'excellent (>= 0.8)', count: rewards.filter(r => r >= 0.8).length },
    { bucket: 'good (0.5-0.8)', count: rewards.filter(r => r >= 0.5 && r < 0.8).length },
    { bucket: 'poor (0.0-0.5)', count: rewards.filter(r => r >= 0 && r < 0.5).length },
    { bucket: 'negative (< 0)', count: rewards.filter(r => r < 0).length },
  ]

  const stats: DatasetStats = {
    totalTasks: trajectories.length,
    tasksWithRewards: withRewards.length,
    sftExamples: sftExamples.length,
    dpoPairs: dpoPairs.length,
    avgReward,
    rewardDistribution: distribution,
  }

  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')
  console.log(`[dataset] Exported: ${sftExamples.length} SFT, ${dpoPairs.length} DPO pairs, avg reward ${avgReward.toFixed(2)}`)

  return stats
}

/**
 * Backfill rewards for trajectories that don't have them.
 * Uses a simplified heuristic when full outcome data isn't available:
 * tool success rate + completion proxy.
 */
export function backfillRewards(
  trajectoryDir?: string,
  rewardDir?: string,
): number {
  const trajDir = trajectoryDir ?? join(homedir(), '.cynco', 'trajectories')
  const rewDir = rewardDir ?? join(homedir(), '.cynco', 'rewards')

  if (!existsSync(trajDir)) return 0

  mkdirSync(rewDir, { recursive: true })

  const files = readdirSync(trajDir).filter(f => f.endsWith('.jsonl'))
  let backfilled = 0

  for (const file of files) {
    const taskId = file.replace('.jsonl', '')
    const rewardPath = join(rewDir, `${taskId}.reward.json`)

    // Skip if reward already exists
    if (existsSync(rewardPath)) continue

    const lines = readFileSync(join(trajDir, file), 'utf-8').trim().split('\n').filter(l => l.trim())
    if (lines.length === 0) continue

    const turns: TurnRecord[] = []
    for (const line of lines) {
      try { turns.push(JSON.parse(line)) } catch {}
    }

    if (turns.length === 0) continue

    // Compute reward from available signals
    const allToolCalls = turns.flatMap(t => t.tool_calls)
    const totalCalls = allToolCalls.length
    const successCalls = allToolCalls.filter(tc => tc.success).length
    const toolSuccessRate = totalCalls > 0 ? successCalls / totalCalls : 0

    // Check if any Edit/Write tools were used (proxy for task completion)
    const usedActionTools = allToolCalls.some(tc =>
      ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'].includes(tc.name)
    )

    // Check if Bash was used for testing (proxy for verification)
    const ranTests = allToolCalls.some(tc => tc.name === 'Bash')

    // Check max stuck turns from reward_components
    const maxStuck = Math.max(0, ...turns.map(t => t.reward_components.stuckTurns))

    const components: RewardComponents = {
      testsPass: toolSuccessRate, // best proxy we have
      typecheckPass: 1, // assume OK if no data
      buildPass: 1,
      diffClean: usedActionTools ? 1 : 0,
      taskCompleted: usedActionTools ? 1 : 0,
      stuckTurns: maxStuck,
      iterFraction: turns.length / 500,
      userSatisfaction: 0, // no explicit feedback
      testsUnmodified: 1, // assume OK
    }

    finalizeTask(taskId, turns.length, components, rewDir)
    backfilled++
  }

  return backfilled
}
