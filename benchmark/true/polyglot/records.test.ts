// benchmark/true/polyglot/records.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRecord, loadRecords, completedKeys, fitsInBudget, WORST_CASE_MS } from './records.js'
import type { ExerciseRecord } from './types.js'

const rec = (over: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  language: 'python', exercise: 'bowling', passed: true, passedTry: 1,
  durationMs: 1000, tryDurationsMs: [1000], testDurationMs: 200, ...over,
})

describe('appendRecord / loadRecords', () => {
  it('appends one JSON line per record and loads them back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'polyglot-rec-')), 'out.jsonl')
    appendRecord(path, rec())
    appendRecord(path, rec({ exercise: 'connect', passed: false, passedTry: null }))
    const raw = readFileSync(path, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    const loaded = loadRecords(path)
    expect(loaded).toHaveLength(2)
    expect(loaded[1].passedTry).toBeNull()
  })

  it('loadRecords returns [] for a missing file (fresh run)', () => {
    expect(loadRecords(join(tmpdir(), 'does-not-exist.jsonl'))).toEqual([])
  })
})

describe('completedKeys (resume filtering)', () => {
  it('keys records as language/exercise', () => {
    const done = completedKeys([rec(), rec({ language: 'go', exercise: 'zebra' })])
    expect(done.has('python/bowling')).toBe(true)
    expect(done.has('go/zebra')).toBe(true)
    expect(done.has('go/bowling')).toBe(false)
  })
})

describe('fitsInBudget', () => {
  it('always fits the first exercise of a chunk (budget >= worst case)', () => {
    expect(fitsInBudget(0, 60 * 60_000)).toBe(true)
  })
  it('stops before an exercise that could overrun the budget', () => {
    const budget = 60 * 60_000
    expect(fitsInBudget(budget - WORST_CASE_MS, budget)).toBe(true)
    expect(fitsInBudget(budget - WORST_CASE_MS + 1, budget)).toBe(false)
  })
})
