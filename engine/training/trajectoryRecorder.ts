/**
 * TrajectoryRecorder — per-turn JSONL writer for SFT/DPO training data.
 * Records tool calls, state features, and reward components for each turn
 * in a task. Follows the same fsync'd append-only pattern as DecisionJournalWriter.
 *
 * Output: ~/.cynco/trajectories/<taskId>.jsonl
 */

import { appendFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { sanitizeMessages } from './messageSnapshot.js'
import type { Message } from '../types.js'

// ─── Types ────────────────────────────────────────────────────────

export type ToolCallRecord = {
  name: string
  inputHash: string
  success: boolean
  latencyMs: number
}

/**
 * diffSize and contextPct are optional because not every call site measures
 * them. An absent field is honest; a 0 is a claim — and a persisted 0 is
 * indistinguishable from a measured zero for every consumer downstream.
 */
export type StateFeatures = {
  filesTouched: number
  diffSize?: number
  testsTotal: number
  testsFailing: number
  toolsUsed: string[]
  contextPct?: number
}

/** varietyEntropy is optional for the same reason as diffSize — see above. */
export type RewardComponents = {
  toolSuccessRate: number
  stuckTurns: number
  varietyEntropy?: number
}

export type TurnRecord = {
  toolCalls: ToolCallRecord[]
  stateFeatures: StateFeatures
  rewardComponents: RewardComponents
}

type TurnLine = {
  task_id: string
  turn_idx: number
  ts: string
  model: string
  adapter_id: string | undefined
  tool_calls: ToolCallRecord[]
  state_features: StateFeatures
  reward_components: RewardComponents
}

// ─── Task boundary ────────────────────────────────────────────────

/**
 * How much of the conversation the snapshot actually corresponds to this task.
 *
 *  - 'exact'      — the caller recorded where the task began and the array
 *                   still holds that boundary; the snapshot is the tail.
 *  - 'clamped'    — a boundary was recorded but the array has since shrunk
 *                   below it (compaction), so it points nowhere and the whole
 *                   array was kept.
 *  - 'unmeasured' — the caller never recorded a boundary. Not the same claim
 *                   as 'exact' over the whole array, and not written as one.
 */
export type TaskBoundary = 'exact' | 'clamped' | 'unmeasured'

/**
 * The slice of a session that belongs to one task.
 *
 * ConversationLoop.messages accumulates across a whole session and is never
 * reset at a task boundary, so snapshotting it whole made task 2 a strict
 * superset of task 1. That produced near-duplicate corpus rows carrying
 * DIFFERENT rewards, and let a DPO pair drawn from one session share an
 * identical prefix on both the chosen and the rejected side — training the
 * model to discriminate between two things that are textually the same.
 *
 * Compaction interaction: compactNow replaces this.messages wholesale and can
 * leave it shorter than the recorded index. Slicing from a stale index would
 * silently emit an empty or wrong-boundary snapshot, so an out-of-range index
 * clamps to 0 and keeps everything. The compacted array IS mostly this task's
 * own history in summarized form, and a row that is too broad is recoverable
 * while a row that is empty is not — but the snapshot records which of the two
 * happened rather than letting the reader assume the boundary held.
 *
 * System messages before the boundary are carried over: they were in the
 * model's context for this task (the engine sends the whole array), so they
 * are measured context, and a ChatML row missing its system prompt is a
 * different training example than the one that actually ran.
 */
export function sliceTaskMessages(
  messages: Message[],
  startIndex: number | null,
): { messages: Message[]; boundary: TaskBoundary } {
  if (startIndex === null) return { messages, boundary: 'unmeasured' }
  if (startIndex <= 0) return { messages, boundary: 'exact' }
  if (startIndex >= messages.length) return { messages, boundary: 'clamped' }

  const head = messages.slice(0, startIndex).filter(m => m?.role === 'system')
  return { messages: [...head, ...messages.slice(startIndex)], boundary: 'exact' }
}

// ─── Recorder class ───────────────────────────────────────────────

export class TrajectoryRecorder {
  private readonly baseDir: string
  /**
   * Where this task's reward label is written. A caller that redirects the
   * trajectory directory is recording somewhere other than the user's corpus —
   * a test, a sandbox — and its labels must not land in the real one. Until
   * this existed, every full test-suite run wrote a dozen manufactured reward
   * files into ~/.cynco/rewards: trajectories in a temp dir, labels in the live
   * corpus. So rewards follow the trajectories unless told otherwise.
   */
  readonly rewardDir: string
  private _taskId: string | null = null
  private _model: string = ''
  private _adapterId: string | undefined = undefined
  private _turnIdx: number = 0
  private _startedAt: string = ''
  /**
   * Where this task's messages begin in the caller's session array, or null
   * when the caller did not record one. Lives here rather than on the loop
   * because the recorder already owns the task boundary and clears its own
   * state — two owners would have to stay in sync.
   */
  private _messageStartIdx: number | null = null

  constructor(baseDir?: string, rewardDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.cynco', 'trajectories')
    this.rewardDir = rewardDir
      ?? (baseDir ? join(baseDir, 'rewards') : join(homedir(), '.cynco', 'rewards'))
    mkdirSync(this.baseDir, { recursive: true })
  }

  /**
   * Begin a new task trajectory. Resets turn counter.
   *
   * messageStartIndex is where this task's messages begin in the caller's
   * session array — see sliceTaskMessages. Omitting it is honest (some callers
   * have no session array) and the snapshot then reports its boundary as
   * 'unmeasured' rather than claiming the whole array was one task.
   */
  startTask(taskId: string, model: string, adapterId?: string, messageStartIndex?: number): void {
    this._taskId = taskId
    this._model = model
    this._adapterId = adapterId
    this._turnIdx = 0
    this._startedAt = new Date().toISOString()
    this._messageStartIdx =
      typeof messageStartIndex === 'number' && Number.isFinite(messageStartIndex)
        ? Math.max(0, Math.floor(messageStartIndex))
        : null
  }

  /** Append one turn's data to <baseDir>/<taskId>.jsonl with fsync. */
  recordTurn(turn: TurnRecord): void {
    if (!this._taskId) {
      console.error('[trajectory] recordTurn called before startTask')
      return
    }

    const line: TurnLine = {
      task_id: this._taskId,
      turn_idx: this._turnIdx,
      ts: new Date().toISOString(),
      model: this._model,
      adapter_id: this._adapterId,
      tool_calls: turn.toolCalls,
      state_features: turn.stateFeatures,
      reward_components: turn.rewardComponents,
    }

    this._turnIdx++

    const filePath = join(this.baseDir, `${this._taskId}.jsonl`)
    const content = JSON.stringify(line) + '\n'

    try {
      const fd = openSync(filePath, 'a')
      appendFileSync(fd, content)
      fsyncSync(fd)
      closeSync(fd)
    } catch (e) {
      console.error(`[trajectory] Write failed (task=${this._taskId}): ${e}`)
    }
  }

  /**
   * Close the task and persist the conversation as training corpus.
   *
   * Only this task's slice of the caller's array is persisted — see
   * sliceTaskMessages.
   *
   * Returns the snapshot path, or null when there is nothing worth keeping
   * (no active task, or an empty conversation). Clears the active task, so a
   * second call is a no-op and a late recordTurn cannot write into a finished
   * task.
   */
  endTask(messages: Message[], meta?: { endedAt?: string }): string | null {
    const taskId = this._taskId
    if (!taskId) return null
    this._taskId = null
    const startIdx = this._messageStartIdx
    // Cleared with the task, the same way _taskId is: a stale boundary applied
    // to the next task would slice it at a point that means nothing.
    this._messageStartIdx = null

    if (!Array.isArray(messages) || messages.length === 0) return null

    // Everything is inside the try: this is called from a finally in the
    // conversation loop, so a throw escaping here would mask whatever error
    // actually ended the task. Losing a corpus row is always the cheaper loss.
    const filePath = join(this.baseDir, `${taskId}.messages.json`)
    try {
      const { messages: scoped, boundary } = sliceTaskMessages(messages, startIdx)
      if (scoped.length === 0) return null
      const { messages: cleaned, truncatedMessages } = sanitizeMessages(scoped)

      const snapshot = {
        schemaVersion: 2,
        taskId,
        model: this._model,
        adapterId: this._adapterId,
        startedAt: this._startedAt,
        endedAt: meta?.endedAt ?? new Date().toISOString(),
        truncatedMessages,
        taskBoundary: boundary,
        messages: cleaned,
      }

      writeFileSync(filePath, JSON.stringify(snapshot) + '\n', 'utf-8')
      return filePath
    } catch (e) {
      console.error(`[trajectory] Snapshot write failed (task=${taskId}): ${e}`)
      return null
    }
  }

  get taskId(): string | null {
    return this._taskId
  }

  get turnIdx(): number {
    return this._turnIdx
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let _instance: TrajectoryRecorder | null = null

export function getTrajectoryRecorder(): TrajectoryRecorder | null {
  return _instance
}

export function initTrajectoryRecorder(baseDir?: string, rewardDir?: string): TrajectoryRecorder {
  _instance = new TrajectoryRecorder(baseDir, rewardDir)
  return _instance
}
