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
  // diffSize, contextPct and varietyEntropy are optional on disk: a call site
  // that did not measure one omits it rather than writing a 0 it cannot back
  // up. See trajectoryRecorder.StateFeatures.
  state_features: {
    filesTouched: number; diffSize?: number; testsTotal: number
    testsFailing: number; toolsUsed: string[]; contextPct?: number
  }
  reward_components: {
    toolSuccessRate: number; stuckTurns: number; varietyEntropy?: number
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
  /**
   * How well the snapshot corresponds to this task alone — see
   * trajectoryRecorder.TaskBoundary. Absent on snapshots written before the
   * boundary was recorded at all, which is not the same as 'exact'.
   */
  taskBoundary?: 'exact' | 'clamped' | 'unmeasured'
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
  /** Usable rows scoring at or below DPO_MAX_REWARD. */
  negativeExamples: number
  /** The subset of those that can actually form a DPO pair. What the gate uses. */
  pairableNegatives: number
  legacyExcluded: number
  avgReward: number
  rewardDistribution: { bucket: string; count: number }[]
}

export type DatasetStats = CorpusStats & {
  sftExamples: number
  dpoPairs: number
}

/**
 * Labels written before the grounded labeler landed are not training data.
 *
 * Raised from 2 to 3 by finding (z). Version 2 was a hardcoded literal that
 * never moved through sixteen changes to what the components mean, so "version
 * 2" is not one labeler but up to sixteen, and this filter — whose entire job
 * is to keep ungrounded labels out — was letting all of them through. L4.2 was
 * in the corpus at 0.9736 for a run that deleted 32 test cases; the labeler
 * that would score it -1.0 stamped its records with the same number.
 *
 * This empties the corpus of everything labeled before 2026-07-27, and none of
 * it can be relabeled: those runs did not persist what they were measured from.
 * That is the cost of the sixteen skipped bumps, and paying it is cheaper than
 * training on numbers nobody can vouch for. Runs from here carry their
 * evidence (see finalizeTask) and survive the next bump.
 */
export const MIN_LABELER_VERSION = 3
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
  if (!b || typeof b !== 'object') return ''
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
    // A single malformed message must not throw out of exportDatasets and take
    // the whole export with it.
    if (!m || typeof m !== 'object') continue
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

    // Round-robin rather than the full cross product. 100 chosen x 50 rejected
    // is 5,000 rows built from 150 conversations, most of them re-serializing
    // the same two megabyte-scale transcripts; the duplication teaches nothing
    // and dominates the file. One pass gives every trajectory on the short side
    // equal representation.
    if (chosen.length === 0 || rejected.length === 0) continue
    const n = Math.max(chosen.length, rejected.length)
    for (let i = 0; i < n; i++) {
      pairs.push(JSON.stringify({
        chosen: toChatML(chosen[i % chosen.length].snapshot!.messages),
        rejected: toChatML(rejected[i % rejected.length].snapshot!.messages),
      }))
    }
  }

  return pairs
}

// ─── Summary & Export ─────────────────────────────────────────────

/**
 * Negatives that buildDPODataset can actually turn into a pair: attributed to a
 * model, and with at least one chosen-side run under that same model.
 *
 * The gate exists to answer "is this corpus trainable", and a bare count of
 * low-reward rows does not answer it. 200 usable rows with 25 unattributed
 * negatives passes a naive count and exports zero DPO pairs.
 *
 * Uses only rewards and the turn log, never snapshot content, so it is safe on
 * a dashboard poll with loadSnapshots: false.
 */
function countPairableNegatives(usable: TrajectoryWithReward[]): number {
  const modelsWithChosen = new Set<string>()
  for (const t of usable) {
    const m = modelOf(t)
    if (m !== null && t.reward!.reward >= SFT_MIN_REWARD) modelsWithChosen.add(m)
  }
  return usable.filter(t => {
    if (t.reward!.reward > DPO_MAX_REWARD) return false
    const m = modelOf(t)
    return m !== null && modelsWithChosen.has(m)
  }).length
}

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
    // Same reward predicate buildDPODataset uses to pick a rejected side. It is
    // NOT the pairable count — that also needs model attribution and a chosen
    // counterpart in the same group. See pairableNegatives.
    negativeExamples: rewards.filter(r => r <= DPO_MAX_REWARD).length,
    pairableNegatives: countPairableNegatives(usable),
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

// ─── Readiness Gate ───────────────────────────────────────────────

/**
 * Thresholds, exported so they can be re-tuned without editing the gate. They
 * are a judgement about what a trainable corpus looks like, not a measurement.
 */
export const GATE_MIN_USABLE = 150
export const GATE_MIN_NEGATIVE = 20
export const GATE_MAX_AVG_REWARD = 0.9

export type ReadinessCondition = {
  name: string
  ok: boolean
  /** The measured value, or null when there was nothing to measure. */
  actual: number | null
  /** actual rendered for a human; 'not measured' when actual is null. */
  display: string
  required: string
  /** Why this condition failed, in its own numbers. Absent when ok. */
  reason?: string
}

export type Readiness = {
  ready: boolean
  conditions: ReadinessCondition[]
  /** The reason strings of the failing conditions, in order. */
  reasons: string[]
}

/**
 * Training readiness.
 *
 *  - usable examples — volume, but of examples that carry information
 *  - negative examples — without them DPO has nothing to pair and SFT only
 *    ever sees success, which is how a model learns that its failure modes
 *    are excellent work
 *  - avg reward below 0.9 — a saturated mean means the labeler regressed;
 *    the pre-2026-07-25 corpus scored 1.0 on all 147 rows
 *
 * The mean is only a condition when there were rows to average. summarizeCorpus
 * returns avgReward 0 for an empty corpus, and 0 < 0.9 — so a naive check
 * would print PASS for a measurement nobody took. An unmeasured mean fails,
 * loudly, and reports itself as unmeasured rather than as zero.
 *
 * When the caller has DatasetStats — i.e. the datasets were actually built —
 * two more conditions apply, on the rows that came out rather than the rows
 * that looked eligible. isUsable requires hasSnapshot, which is an existsSync
 * check: a snapshot that exists but does not parse is counted by the first
 * three conditions and dropped by both builders, so the gate could report
 * READY over a corpus that exports zero rows.
 *
 * They are conditional because summarizeCorpus is called on a dashboard poll
 * with loadSnapshots: false, where the datasets cannot be built at all. An
 * absent count means the check did not run; asserting it from a number nobody
 * computed would be the same fabrication this gate exists to catch.
 */
export function evaluateReadiness(stats: CorpusStats | DatasetStats): Readiness {
  // Refuse a shape that is not the summary. Handed anything else — the raw
  // trajectory array is the easy mistake, since both are "the corpus" in
  // conversation — every field reads undefined and the gate renders verdicts
  // like "have undefined usable examples, need 150 — NaN short". That is a
  // fabricated measurement wearing a number's clothes, and this gate exists
  // to catch exactly that. It fails loudly instead.
  for (const field of ['usableExamples', 'pairableNegatives', 'negativeExamples', 'avgReward'] as const) {
    if (!Number.isFinite((stats as Record<string, unknown>)?.[field] as number)) {
      throw new TypeError(
        `evaluateReadiness: ${field} is not a finite number ` +
        `(got ${JSON.stringify((stats as Record<string, unknown>)?.[field])}). ` +
        'Pass the result of summarizeCorpus, not the trajectories it summarizes.',
      )
    }
  }

  const usable = stats.usableExamples
  // The pairable count, not the raw one. A negative with no model attribution,
  // or with no chosen-side run under the same model, exports zero DPO pairs —
  // gating on the raw count would let a corpus that trains nothing pass.
  const negative = stats.pairableNegatives
  const measured = usable > 0

  const conditions: ReadinessCondition[] = [
    {
      name: 'usable examples',
      ok: usable >= GATE_MIN_USABLE,
      actual: usable,
      display: String(usable),
      required: `>= ${GATE_MIN_USABLE}`,
      reason: usable >= GATE_MIN_USABLE
        ? undefined
        : `have ${usable} usable examples, need ${GATE_MIN_USABLE} — ` +
          `${GATE_MIN_USABLE - usable} short`,
    },
    {
      name: 'pairable negatives',
      ok: negative >= GATE_MIN_NEGATIVE,
      actual: negative,
      display: String(negative),
      required: `>= ${GATE_MIN_NEGATIVE}`,
      reason: negative >= GATE_MIN_NEGATIVE
        ? undefined
        : `have ${negative} pairable negatives of ${stats.negativeExamples} ` +
          `low-reward runs (reward <= ${DPO_MAX_REWARD}), need ${GATE_MIN_NEGATIVE} — ` +
          `${GATE_MIN_NEGATIVE - negative} short`,
    },
    measured
      ? {
          name: 'avg reward',
          ok: stats.avgReward < GATE_MAX_AVG_REWARD,
          actual: stats.avgReward,
          display: stats.avgReward.toFixed(3),
          required: `< ${GATE_MAX_AVG_REWARD}`,
          reason: stats.avgReward < GATE_MAX_AVG_REWARD
            ? undefined
            : `mean reward over ${usable} usable examples is ` +
              `${stats.avgReward.toFixed(3)}, at or above ${GATE_MAX_AVG_REWARD} — ` +
              'a saturated mean is the labeler regressing, not the agent improving',
        }
      : {
          name: 'avg reward',
          ok: false,
          actual: null,
          display: 'not measured',
          required: `< ${GATE_MAX_AVG_REWARD}`,
          reason: 'no usable examples, so no mean reward has been measured',
        },
  ]

  const built = stats as Partial<DatasetStats>
  if (typeof built.sftExamples === 'number') {
    const sft = built.sftExamples
    conditions.push({
      name: 'SFT rows built',
      ok: sft > 0,
      actual: sft,
      display: String(sft),
      required: '> 0',
      reason: sft > 0
        ? undefined
        : `${usable} examples passed eligibility but the SFT builder produced ` +
          '0 rows — eligibility only checks that a snapshot file exists, so ' +
          'these have no readable conversation to train on',
    })
  }
  if (typeof built.dpoPairs === 'number') {
    const pairs = built.dpoPairs
    conditions.push({
      name: 'DPO pairs built',
      ok: pairs >= GATE_MIN_NEGATIVE,
      actual: pairs,
      display: String(pairs),
      required: `>= ${GATE_MIN_NEGATIVE}`,
      reason: pairs >= GATE_MIN_NEGATIVE
        ? undefined
        : `the DPO builder produced ${pairs} pairs from ${negative} pairable ` +
          `negatives, need ${GATE_MIN_NEGATIVE} — ${GATE_MIN_NEGATIVE - pairs} short`,
    })
  }

  return {
    ready: conditions.every(c => c.ok),
    conditions,
    reasons: conditions.map(c => c.reason).filter((r): r is string => r !== undefined),
  }
}
