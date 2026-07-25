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

export type StateFeatures = {
  filesTouched: number
  diffSize: number
  testsTotal: number
  testsFailing: number
  toolsUsed: string[]
  contextPct: number
}

export type RewardComponents = {
  toolSuccessRate: number
  stuckTurns: number
  varietyEntropy: number
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

// ─── Recorder class ───────────────────────────────────────────────

export class TrajectoryRecorder {
  private readonly baseDir: string
  private _taskId: string | null = null
  private _model: string = ''
  private _adapterId: string | undefined = undefined
  private _turnIdx: number = 0
  private _startedAt: string = ''

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.cynco', 'trajectories')
    mkdirSync(this.baseDir, { recursive: true })
  }

  /** Begin a new task trajectory. Resets turn counter. */
  startTask(taskId: string, model: string, adapterId?: string): void {
    this._taskId = taskId
    this._model = model
    this._adapterId = adapterId
    this._turnIdx = 0
    this._startedAt = new Date().toISOString()
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
   * Returns the snapshot path, or null when there is nothing worth keeping
   * (no active task, or an empty conversation). Clears the active task, so a
   * second call is a no-op and a late recordTurn cannot write into a finished
   * task.
   */
  endTask(messages: Message[], meta?: { endedAt?: string }): string | null {
    const taskId = this._taskId
    if (!taskId) return null
    this._taskId = null

    if (!Array.isArray(messages) || messages.length === 0) return null

    // Everything is inside the try: this is called from a finally in the
    // conversation loop, so a throw escaping here would mask whatever error
    // actually ended the task. Losing a corpus row is always the cheaper loss.
    const filePath = join(this.baseDir, `${taskId}.messages.json`)
    try {
      const { messages: cleaned, truncatedMessages } = sanitizeMessages(messages)

      const snapshot = {
        schemaVersion: 2,
        taskId,
        model: this._model,
        adapterId: this._adapterId,
        startedAt: this._startedAt,
        endedAt: meta?.endedAt ?? new Date().toISOString(),
        truncatedMessages,
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

export function initTrajectoryRecorder(baseDir?: string): TrajectoryRecorder {
  _instance = new TrajectoryRecorder(baseDir)
  return _instance
}
