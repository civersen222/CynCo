/**
 * BrainRecorder — persists per-turn brain telemetry to <trajectoryDir>/brain/<taskId>.jsonl,
 * keyed the same way trajectory rows are so the two can be joined on (task_id, turn_idx).
 *
 * Until this existed everything the Brain measured — token entropy, the
 * divergence floor — was broadcast to the dashboard and then dropped. A signal
 * that cannot be attached to a turn is a picture, not a measurement: there was
 * no way to ask whether the turn where the model wrote a hollow test looked
 * different from the turn where it wrote a biting one, even though the mutation
 * harness answers exactly that question hours later.
 *
 * The directory is injected rather than defaulted so brain rows follow the
 * trajectories they join to. A caller that redirects the trajectory directory
 * is recording somewhere other than the user's corpus — a test, a sandbox — and
 * its telemetry must not land in the real one.
 */

import { appendFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'

/**
 * Tool-token entropy over one model call. n is carried because a mean over two
 * tokens and a mean over two hundred are not the same claim, and a reader with
 * only the mean cannot tell them apart.
 */
export type ToolEntropySummary = { n: number; mean: number; min: number; max: number }

export type BrainTurnLine = {
  task_id: string
  turn_idx: number
  ts: string
  kind: 'turn'
  /**
   * Summarizes the model call that emitted this tool call, not the individual
   * tool token. null when no tool-token logprobs were seen — the provider may
   * not return them, and an absent measurement is not a zero one.
   */
  tool_entropy: ToolEntropySummary | null
}

export type BrainDivergenceLine = {
  task_id: string
  turn_idx: number
  ts: string
  kind: 'divergence'
  tool: string
  entropy: number
  floor: number
  diverged: boolean
  pruned_messages: number
}

export class BrainRecorder {
  private xs: number[] = []

  /** Returns the directory to write into, or null when nothing should be written. */
  constructor(private readonly dirFor: () => string | null) {}

  observeToolEntropy(h: number): void {
    if (Number.isFinite(h)) this.xs.push(h)
  }

  /**
   * Summarize what has been observed since the last reset, without clearing.
   * One model call can emit several tool calls, and each of them was selected
   * under this same distribution; clearing on the first would report the rest
   * as unmeasured when they were merely later in the stream.
   */
  snapshot(): ToolEntropySummary | null {
    if (this.xs.length === 0) return null
    let sum = 0
    let min = Infinity
    let max = -Infinity
    for (const x of this.xs) {
      sum += x
      if (x < min) min = x
      if (x > max) max = x
    }
    return { n: this.xs.length, mean: sum / this.xs.length, min, max }
  }

  /** Clear the observation window. Called at model-call start. */
  reset(): void {
    this.xs = []
  }

  recordTurn(taskId: string, turnIdx: number, entropy: ToolEntropySummary | null): void {
    this.write({
      task_id: taskId,
      turn_idx: turnIdx,
      ts: new Date().toISOString(),
      kind: 'turn',
      tool_entropy: entropy,
    })
  }

  recordDivergence(
    taskId: string,
    turnIdx: number,
    v: { tool: string; entropy: number; floor: number; diverged: boolean; prunedMessages: number },
  ): void {
    this.write({
      task_id: taskId,
      turn_idx: turnIdx,
      ts: new Date().toISOString(),
      kind: 'divergence',
      tool: v.tool,
      entropy: v.entropy,
      floor: v.floor,
      diverged: v.diverged,
      pruned_messages: v.prunedMessages,
    })
  }

  private write(line: BrainTurnLine | BrainDivergenceLine): void {
    const dir = this.dirFor()
    if (!dir) return
    try {
      mkdirSync(dir, { recursive: true })
      const fd = openSync(join(dir, `${line.task_id}.jsonl`), 'a')
      try {
        appendFileSync(fd, JSON.stringify(line) + '\n')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (e) {
      console.error(`[brain] telemetry write failed (task=${line.task_id}): ${e}`)
    }
  }
}
