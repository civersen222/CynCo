import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ThinkingRecorder } from '../../memory/thinkingRecorder.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'thinkrec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const digest = { mean: 1.2, max: 2.5, spikeCount: 1 }

describe('ThinkingRecorder', () => {
  it('appends one record per turn with text and entropy', () => {
    const r = new ThinkingRecorder('s1', dir)
    r.onThinkingDelta('let me ')
    r.onThinkingDelta('think')
    r.finalizeTurn({ tokenCount: 2, durationMs: 500, entropy: { thinking: digest, output: null } })
    const lines = readFileSync(join(dir, 's1.thinking.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0])
    expect(rec.turn).toBe(1)
    expect(rec.text).toBe('let me think')
    expect(rec.tokenCount).toBe(2)
    expect(rec.durationMs).toBe(500)
    expect(rec.entropy.thinking.mean).toBeCloseTo(1.2)
  })

  it('skips turns with no thinking and no entropy', () => {
    const r = new ThinkingRecorder('s1', dir)
    r.finalizeTurn({ tokenCount: 0, durationMs: 10, entropy: null })
    expect(existsSync(join(dir, 's1.thinking.jsonl'))).toBe(false)
    r.onThinkingDelta('x')
    r.finalizeTurn({ tokenCount: 1, durationMs: 10, entropy: null })
    // turn numbering counts all turns, including skipped ones
    expect(JSON.parse(readFileSync(join(dir, 's1.thinking.jsonl'), 'utf-8').trim()).turn).toBe(2)
  })

  it('readTurns lists turn indexes; readTurn returns one record; corrupt lines skipped', () => {
    const r = new ThinkingRecorder('s1', dir)
    r.onThinkingDelta('a'); r.finalizeTurn({ tokenCount: 1, durationMs: 1, entropy: null })
    r.onThinkingDelta('b'); r.finalizeTurn({ tokenCount: 1, durationMs: 1, entropy: null })
    writeFileSync(join(dir, 's1.thinking.jsonl'), readFileSync(join(dir, 's1.thinking.jsonl'), 'utf-8') + '{corrupt\n')
    expect(ThinkingRecorder.readTurns('s1', dir).map(t => t.turn)).toEqual([1, 2])
    expect(ThinkingRecorder.readTurn('s1', 2, dir)?.text).toBe('b')
    expect(ThinkingRecorder.readTurn('s1', 99, dir)).toBeNull()
  })

  it('aggregateSession averages means, maxes maxes, sums spikes', () => {
    const r = new ThinkingRecorder('s1', dir)
    r.onThinkingDelta('a')
    r.finalizeTurn({ tokenCount: 1, durationMs: 1, entropy: { thinking: { mean: 1, max: 2, spikeCount: 1 }, output: null } })
    r.onThinkingDelta('b')
    r.finalizeTurn({ tokenCount: 1, durationMs: 1, entropy: { thinking: { mean: 3, max: 5, spikeCount: 2 }, output: null } })
    const agg = ThinkingRecorder.aggregateSession('s1', dir)!
    expect(agg.thinking!.mean).toBeCloseTo(2)
    expect(agg.thinking!.max).toBe(5)
    expect(agg.thinking!.spikeCount).toBe(3)
    expect(agg.output).toBeNull()
    expect(ThinkingRecorder.aggregateSession('missing', dir)).toBeNull()
  })
})
