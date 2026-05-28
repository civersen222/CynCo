/**
 * TrajectoryRecorder — per-turn JSONL writer for SFT/DPO training data.
 * Records tool calls, state features, and reward components for each turn
 * in a task. Follows the same fsync'd append-only pattern as DecisionJournalWriter.
 *
 * Output: ~/.cynco/trajectories/<taskId>.jsonl
 */

import { appendFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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

  get taskId(): string | null {
    return this._taskId
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
