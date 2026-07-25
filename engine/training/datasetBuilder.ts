/**
 * DatasetBuilder — converts trajectory + reward data into training datasets.
 *
 * Reads trajectory JSONL turn logs, their reward files and their message
 * snapshots, filters by eligibility and reward, and outputs ChatML records for
 * Unsloth SFT and (chosen, rejected) pairs for DPO.
 *
 * Eligibility (see isUsable): a v2+ reward label AND a captured conversation.
 * Everything recorded before 2026-07-25 fails both and is excluded here rather
 * than deleted from ~/.cynco.
 *
 * Output formats:
 *   SFT:  { messages: [{ role, content }] }  — one per trajectory
 *   DPO:  { chosen: [{ role, content }], rejected: [{ role, content }] }
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { TaskReward } from './rewardLabeler.js'
import type { Message, ContentBlock } from '../types.js'

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

export type TrajectorySnapshot = {
  schemaVersion: number
  taskId: string
  model?: string
  adapterId?: string | null
  startedAt?: string
  endedAt?: string
  truncatedMessages?: number
  messages: Message[]
}

export type TrajectoryWithReward = {
  taskId: string
  turns: TurnRecord[]
  reward: TaskReward | null
  /** A snapshot file exists on disk. Cheap — existsSync only. */
  hasSnapshot: boolean
  /** Parsed snapshot; null when loadSnapshots was false or parsing failed. */
  snapshot: TrajectorySnapshot | null
}

/** Corpus shape — computable without reading any message content. */
export type CorpusStats = {
  totalTasks: number
  tasksWithRewards: number
  usableExamples: number
  negativeExamples: number
  legacyExcluded: number
  avgReward: number
  rewardDistribution: { bucket: string; count: number }[]
}

export type DatasetStats = CorpusStats & {
  sftExamples: number
  dpoPairs: number
}

/** Labels written before the grounded labeler landed are not training data. */
export const MIN_LABELER_VERSION = 2
export const SFT_MIN_REWARD = 0.7
export const DPO_MAX_REWARD = 0.3

// ─── Core Functions ───────────────────────────────────────────────

/**
 * Load all trajectories with their rewards, and optionally their message
 * snapshots, from disk.
 *
 * Snapshots run to 2 MB. Callers that only need counts (the dashboard, which
 * polls) pass loadSnapshots: false and rely on hasSnapshot.
 */
export function loadTrajectories(
  trajectoryDir?: string,
  rewardDir?: string,
  opts: { loadSnapshots?: boolean } = {},
): TrajectoryWithReward[] {
  const loadSnapshots = opts.loadSnapshots !== false
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

    let reward: TaskReward | null = null
    const rewardPath = join(rewDir, `${taskId}.reward.json`)
    if (existsSync(rewardPath)) {
      try {
        reward = JSON.parse(readFileSync(rewardPath, 'utf-8'))
      } catch {}
    }

    const snapPath = join(trajDir, `${taskId}.messages.json`)
    const hasSnapshot = existsSync(snapPath)
    let snapshot: TrajectorySnapshot | null = null
    if (hasSnapshot && loadSnapshots) {
      try {
        const parsed = JSON.parse(readFileSync(snapPath, 'utf-8'))
        if (parsed && Array.isArray(parsed.messages)) snapshot = parsed
      } catch {}
    }

    results.push({ taskId, turns, reward, hasSnapshot, snapshot })
  }

  return results
}

/**
 * Eligible as training data: labeled by the grounded labeler, not degenerate,
 * and with the real conversation on disk. A reward label without a
 * conversation is untrainable — there is no text to learn.
 */
export function isUsable(t: TrajectoryWithReward): boolean {
  if (!t.reward) return false
  if ((t.reward.labelerVersion ?? 1) < MIN_LABELER_VERSION) return false
  if (t.reward.degenerate) return false
  return t.hasSnapshot
}

/** Labeled by the pre-grounding labeler — reported, never exported. */
export function isLegacy(t: TrajectoryWithReward): boolean {
  return t.reward !== null && (t.reward.labelerVersion ?? 1) < MIN_LABELER_VERSION
}

/**
 * The model that produced a trajectory, or null when it was never recorded.
 * Never guessed: a pair built from two unattributed runs would assert they
 * came from the same policy, which is exactly the kind of unmeasured claim
 * this corpus is being repaired to remove.
 */
function modelOf(t: TrajectoryWithReward): string | null {
  const m = t.snapshot?.model || t.turns[0]?.model
  return typeof m === 'string' && m.trim() ? m : null
}

// ─── ChatML ───────────────────────────────────────────────────────

/**
 * Render one content block as training text.
 *
 * redacted_thinking carries no readable content and renders to '' — an
 * assistant message holding nothing else is then dropped. image and document
 * blocks carry no signal in a text corpus but did occur, so they leave a
 * visible marker (same policy as messageSnapshot.blockText) rather than
 * vanishing and leaving the next message answering a phantom.
 */
function blockToText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
    case 'thinking':
    case 'connector_text':
      return typeof b.text === 'string' ? b.text : ''
    case 'tool_use':
      return `<tool name="${b.name}">${JSON.stringify(b.input)}</tool>`
    case 'tool_result': {
      // Snapshots are JSON off disk: content is string | ContentBlock[] by the
      // type, but anything else must render to nothing rather than to
      // "[object Object]".
      const body =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map(blockToText).join('')
            : ''
      return `<tool_result${b.is_error ? ' error="true"' : ''}>${body}</tool_result>`
    }
    case 'image':
    case 'document':
      return `[${b.type} block omitted]`
    default:
      return ''
  }
}

/**
 * Flatten engine messages (content blocks) into the { role, content: string }
 * pairs a chat template expects. Tool calls and results survive as tagged
 * text so the tool-use structure is still learnable.
 */
export function toChatML(messages: Message[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = []
  for (const m of messages) {
    // Message.content is ContentBlock[] by the type, but these come off disk.
    const content = m.content as ContentBlock[] | string | undefined
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(blockToText).filter(Boolean).join('\n')
          : ''
    if (!text.trim()) continue
    out.push({ role: m.role, content: text })
  }
  return out
}

// ─── Builders ─────────────────────────────────────────────────────

/**
 * Build SFT examples from the captured conversations of high-reward,
 * eligible trajectories.
 */
export function buildSFTDataset(
  trajectories: TrajectoryWithReward[],
  rewardThreshold = SFT_MIN_REWARD,
): string[] {
  const examples: string[] = []

  for (const traj of trajectories) {
    if (!isUsable(traj) || !traj.snapshot) continue
    if (traj.reward!.reward < rewardThreshold) continue

    const messages = toChatML(traj.snapshot.messages)
    if (messages.length < 2) continue

    examples.push(JSON.stringify({ messages }))
  }

  return examples
}

/**
 * Build DPO pairs from real conversations. Low-reward trajectories are never
 * dropped: a failed run is the most valuable row in the corpus because a pair
 * needs one of each, and there were zero of these before 2026-07-25.
 */
export function buildDPODataset(
  trajectories: TrajectoryWithReward[],
  chosenMinReward = SFT_MIN_REWARD,
  rejectedMaxReward = DPO_MAX_REWARD,
): string[] {
  const pairs: string[] = []

  // Group by model — a pair is only meaningful within one policy, so a run
  // whose model was never recorded cannot be paired at all.
  const byModel = new Map<string, TrajectoryWithReward[]>()
  for (const t of trajectories) {
    if (!isUsable(t) || !t.snapshot) continue
    const model = modelOf(t)
    if (model === null) continue
    if (!byModel.has(model)) byModel.set(model, [])
    byModel.get(model)!.push(t)
  }

  for (const [, group] of byModel) {
    const chosen = group.filter(t => t.reward!.reward >= chosenMinReward)
    const rejected = group.filter(t => t.reward!.reward <= rejectedMaxReward)

    for (const c of chosen) {
      for (const r of rejected) {
        pairs.push(JSON.stringify({
          chosen: toChatML(c.snapshot!.messages),
          rejected: toChatML(r.snapshot!.messages),
        }))
      }
    }
  }

  return pairs
}

// ─── Summary & Export ─────────────────────────────────────────────

/**
 * Corpus statistics. Reads no message content, so it is safe to call on a
 * dashboard poll with loadSnapshots: false.
 *
 * avgReward covers usable rows only. Averaging over the legacy rows would
 * fold in 147 saturated 1.0s and mask exactly the regression the gate checks.
 */
export function summarizeCorpus(trajectories: TrajectoryWithReward[]): CorpusStats {
  const withRewards = trajectories.filter(t => t.reward !== null)
  const usable = trajectories.filter(isUsable)
  const rewards = usable.map(t => t.reward!.reward)
  const avgReward = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0

  return {
    totalTasks: trajectories.length,
    tasksWithRewards: withRewards.length,
    usableExamples: usable.length,
    // Same predicate buildDPODataset uses to pick a rejected side, so the
    // reported negative count is the count that can actually form pairs.
    negativeExamples: rewards.filter(r => r <= DPO_MAX_REWARD).length,
    legacyExcluded: trajectories.filter(isLegacy).length,
    avgReward,
    rewardDistribution: [
      { bucket: 'excellent (>= 0.8)', count: rewards.filter(r => r >= 0.8).length },
      { bucket: 'good (0.5-0.8)', count: rewards.filter(r => r >= 0.5 && r < 0.8).length },
      { bucket: 'poor (0.0-0.5)', count: rewards.filter(r => r >= 0 && r < 0.5).length },
      { bucket: 'negative (< 0)', count: rewards.filter(r => r < 0).length },
    ],
  }
}

/** Build both datasets in memory. Requires snapshots to have been loaded. */
export function buildDatasets(
  trajectories: TrajectoryWithReward[],
): { sft: string[]; dpo: string[]; stats: DatasetStats } {
  const sft = buildSFTDataset(trajectories)
  const dpo = buildDPODataset(trajectories)
  return {
    sft,
    dpo,
    stats: { ...summarizeCorpus(trajectories), sftExamples: sft.length, dpoPairs: dpo.length },
  }
}

/**
 * Export datasets to disk for Unsloth consumption.
 *
 * Both files are rewritten unconditionally, including when empty — otherwise
 * a stale sft.jsonl from a previous labeler survives and every consumer that
 * counts its lines reports a corpus that no longer exists.
 */
export function exportDatasets(
  outputDir?: string,
  trajectoryDir?: string,
  rewardDir?: string,
): DatasetStats {
  const outDir = outputDir ?? join(homedir(), '.cynco', 'datasets')
  mkdirSync(outDir, { recursive: true })

  const trajectories = loadTrajectories(trajectoryDir, rewardDir)
  const { sft, dpo, stats } = buildDatasets(trajectories)

  writeFileSync(join(outDir, 'sft.jsonl'), sft.length > 0 ? sft.join('\n') + '\n' : '')
  writeFileSync(join(outDir, 'dpo.jsonl'), dpo.length > 0 ? dpo.join('\n') + '\n' : '')
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')

  console.log(
    `[dataset] ${stats.sftExamples} SFT, ${stats.dpoPairs} DPO pairs, ` +
    `${stats.usableExamples} usable / ${stats.negativeExamples} negative, ` +
    `${stats.legacyExcluded} legacy excluded, avg reward ` +
    `${stats.usableExamples > 0 ? stats.avgReward.toFixed(3) : 'n/a'}`,
  )

  return stats
}
