import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrainRecorder } from '../../brain/brainRecorder.js'

function lines(dir: string, taskId: string): any[] {
  const p = join(dir, `${taskId}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('BrainRecorder', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brainrec-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('summarizes the entropies it observed', () => {
    const r = new BrainRecorder(() => dir)
    r.observeToolEntropy(0.2)
    r.observeToolEntropy(0.8)
    r.observeToolEntropy(0.5)
    expect(r.snapshot()).toEqual({ n: 3, mean: 0.5, min: 0.2, max: 0.8 })
  })

  it('reports no observations as null, not as zero', () => {
    const r = new BrainRecorder(() => dir)
    expect(r.snapshot()).toBeNull()
    r.recordTurn('t1', 0, r.snapshot())
    expect(lines(dir, 't1')[0].tool_entropy).toBeNull()
  })

  it('ignores non-finite entropies', () => {
    const r = new BrainRecorder(() => dir)
    r.observeToolEntropy(NaN)
    r.observeToolEntropy(Infinity)
    expect(r.snapshot()).toBeNull()
  })

  it('keeps the window across several tool calls in one model call', () => {
    const r = new BrainRecorder(() => dir)
    r.observeToolEntropy(0.4)
    r.recordTurn('t1', 0, r.snapshot())
    r.recordTurn('t1', 1, r.snapshot())
    const rows = lines(dir, 't1')
    expect(rows).toHaveLength(2)
    expect(rows[0].tool_entropy).toEqual({ n: 1, mean: 0.4, min: 0.4, max: 0.4 })
    expect(rows[1].tool_entropy).toEqual({ n: 1, mean: 0.4, min: 0.4, max: 0.4 })
  })

  it('clears the window on reset', () => {
    const r = new BrainRecorder(() => dir)
    r.observeToolEntropy(0.4)
    r.reset()
    expect(r.snapshot()).toBeNull()
  })

  it('writes rows keyed for a join on (task_id, turn_idx)', () => {
    const r = new BrainRecorder(() => dir)
    r.observeToolEntropy(0.1)
    r.recordTurn('task-abc', 7, r.snapshot())
    const [row] = lines(dir, 'task-abc')
    expect(row.task_id).toBe('task-abc')
    expect(row.turn_idx).toBe(7)
    expect(row.kind).toBe('turn')
    expect(typeof row.ts).toBe('string')
  })

  it('records a divergence verdict with its floor', () => {
    const r = new BrainRecorder(() => dir)
    r.recordDivergence('task-abc', 3, {
      tool: 'Read', entropy: 0.01, floor: 0.05, diverged: true, prunedMessages: 12,
    })
    const [row] = lines(dir, 'task-abc')
    expect(row).toMatchObject({
      task_id: 'task-abc', turn_idx: 3, kind: 'divergence',
      tool: 'Read', entropy: 0.01, floor: 0.05, diverged: true, pruned_messages: 12,
    })
  })

  it('separates tasks into their own files', () => {
    const r = new BrainRecorder(() => dir)
    r.recordTurn('a', 0, null)
    r.recordTurn('b', 0, null)
    expect(lines(dir, 'a')).toHaveLength(1)
    expect(lines(dir, 'b')).toHaveLength(1)
  })

  // The reason the directory is injected: a caller with no active trajectory
  // has no task to key on, and telemetry it cannot join is worse than none —
  // it would land in whatever directory happened to be default.
  it('writes nothing when there is no directory', () => {
    const r = new BrainRecorder(() => null)
    r.recordTurn('t1', 0, null)
    r.recordDivergence('t1', 0, { tool: 'Read', entropy: 0, floor: 0, diverged: false, prunedMessages: 0 })
    expect(lines(dir, 't1')).toHaveLength(0)
  })

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'brain')
    const r = new BrainRecorder(() => nested)
    r.recordTurn('t1', 0, null)
    expect(lines(nested, 't1')).toHaveLength(1)
  })
})
