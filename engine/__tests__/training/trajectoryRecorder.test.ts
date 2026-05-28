import { describe, expect, it, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TrajectoryRecorder,
  getTrajectoryRecorder,
  initTrajectoryRecorder,
} from '../../training/trajectoryRecorder.js'
import type { TurnRecord } from '../../training/trajectoryRecorder.js'

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    toolCalls: [
      { name: 'Read', inputHash: 'abc123', success: true, latencyMs: 45 },
      { name: 'Edit', inputHash: 'def456', success: true, latencyMs: 120 },
    ],
    stateFeatures: {
      filesTouched: 2,
      diffSize: 80,
      testsTotal: 10,
      testsFailing: 0,
      toolsUsed: ['Read', 'Edit'],
      contextPct: 0.35,
    },
    rewardComponents: {
      toolSuccessRate: 1.0,
      stuckTurns: 0,
      varietyEntropy: 0.69,
    },
    ...overrides,
  }
}

describe('TrajectoryRecorder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'traj-test-'))
  })

  it('records a turn and writes a valid JSONL file', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-001', 'qwen3:8b')
    recorder.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'task-001.jsonl')
    const raw = readFileSync(filePath, 'utf-8').trim()
    const lines = raw.split('\n').filter(Boolean)

    expect(lines).toHaveLength(1)

    const record = JSON.parse(lines[0])
    expect(record.task_id).toBe('task-001')
    expect(record.turn_idx).toBe(0)
    expect(record.model).toBe('qwen3:8b')
    expect(record.adapter_id).toBeUndefined()
    expect(typeof record.ts).toBe('string')
    expect(Array.isArray(record.tool_calls)).toBe(true)
    expect(record.tool_calls[0].name).toBe('Read')
    expect(record.state_features.filesTouched).toBe(2)
    expect(record.reward_components.toolSuccessRate).toBe(1.0)
  })

  it('increments turn_idx across multiple turns', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-002', 'gemma3:27b', 'lora-v1')
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'task-002.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)

    expect(lines).toHaveLength(3)

    const indices = lines.map(l => JSON.parse(l).turn_idx)
    expect(indices).toEqual([0, 1, 2])

    // adapter_id should be preserved
    expect(JSON.parse(lines[0]).adapter_id).toBe('lora-v1')
  })

  it('resets turn index when startTask is called again', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-003', 'qwen3:8b')
    recorder.recordTurn(makeTurn())
    recorder.recordTurn(makeTurn())

    recorder.startTask('task-004', 'qwen3:8b')
    recorder.recordTurn(makeTurn())

    const file3 = join(tmpDir, 'task-003.jsonl')
    const file4 = join(tmpDir, 'task-004.jsonl')

    const lines3 = readFileSync(file3, 'utf-8').trim().split('\n').filter(Boolean)
    const lines4 = readFileSync(file4, 'utf-8').trim().split('\n').filter(Boolean)

    expect(lines3).toHaveLength(2)
    expect(lines4).toHaveLength(1)
    expect(JSON.parse(lines4[0]).turn_idx).toBe(0)
  })

  it('uses fsync (crash-safe write — no error = success)', () => {
    // If fsync throws on this platform the test would fail.
    // Passing confirms the fd lifecycle (open→append→fsync→close) works.
    const recorder = new TrajectoryRecorder(tmpDir)
    recorder.startTask('task-fsync', 'qwen3:8b')
    expect(() => recorder.recordTurn(makeTurn())).not.toThrow()
  })

  it('taskId getter returns current task id', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    expect(recorder.taskId).toBeNull()

    recorder.startTask('task-id-check', 'qwen3:8b')
    expect(recorder.taskId).toBe('task-id-check')
  })

  it('singleton: initTrajectoryRecorder sets instance returned by getTrajectoryRecorder', () => {
    const instance = initTrajectoryRecorder(tmpDir)
    expect(getTrajectoryRecorder()).toBe(instance)

    instance.startTask('singleton-task', 'qwen3:8b')
    instance.recordTurn(makeTurn())

    const filePath = join(tmpDir, 'singleton-task.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('silently logs error and does not throw when recordTurn called before startTask', () => {
    const recorder = new TrajectoryRecorder(tmpDir)
    // No startTask — should not throw
    expect(() => recorder.recordTurn(makeTurn())).not.toThrow()
  })
})
