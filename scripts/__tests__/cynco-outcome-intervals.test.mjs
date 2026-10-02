import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { intervalsOf, intervalRows, INTERVAL_MIN_TURNS, DATASET_INTERVALS_PATH } from '../cynco-outcome-dataset.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const wave = JSON.parse(readFileSync(join(here, 'fixtures/intervals/wave.json'), 'utf8'))
const row = JSON.parse(readFileSync(join(here, 'fixtures/intervals/row.json'), 'utf8'))

describe('intervalsOf: the span between two ticks is one labeled sample', () => {
  it('labels improved when fails fell by the next tick, stalled otherwise, over the turns inside (at_i, at_i+1]', () => {
    const { intervals, excluded } = intervalsOf(wave, row)
    expect(intervals.map(i => i.label)).toEqual(['improved', 'stalled', 'improved'])   // ticks 20 → 16 → 16 → 10
    expect(intervals[0]).toMatchObject({ missionId: row.missionId, campaign: 'fx', wave: 1, interval: 0, failsStart: 20, failsEnd: 16, signalsVersion: 2, leakGuard: true })
    expect(intervals[0].turns).toBe(20)                      // 30 min / 90 s
    expect(intervals[0].features['interval.turns']).toBe(20)
    expect(intervals[0].features['interval.minutes']).toBeCloseTo(30, 1)
    expect(intervals[0].features['interval.elapsedFractionStart']).toBe(0.094)
    expect(intervals[0].features['interval.failsStart']).toBe(20)
    expect(intervals[0].features['interval.failsStartShare']).toBe(1)
    expect(intervals[1].features['interval.failsStartShare']).toBe(0.8)
    expect(excluded).toEqual({ short: 0, noTicks: 0, noTurnTimes: 0, otherVersion: 0 })
  })
  it('uses the same aggregate keys as the mission features, computed only from the slice', () => {
    const { intervals } = intervalsOf(wave, row)
    expect(intervals[0].features['consecutiveUnstable.max']).toBe(3)   // the fixture's first slice peaks at 3; the second at 7
    expect(intervals[1].features['consecutiveUnstable.max']).toBe(7)
    expect(Object.keys(intervals[0].features)).toEqual(Object.keys(intervals[2].features))
  })
  it('a skipped tick keeps the previous fails; ticks are deduplicated by at', () => {
    const w = { ...wave, shadowDecisions: [...wave.shadowDecisions, { ...wave.shadowDecisions[1], rule: 'R2.stalled' }] }
    expect(intervalsOf(w, row).intervals).toHaveLength(3)
  })
  it(`an interval with fewer than INTERVAL_MIN_TURNS = ${INTERVAL_MIN_TURNS} turns is short, not a row of nulls`, () => {
    const thin = { ...row, turns: row.turns.filter((_, i) => i % 10 === 0) }   // 2 turns per interval
    const { intervals, excluded } = intervalsOf(wave, thin)
    expect(intervals).toEqual([])
    expect(excluded.short).toBe(3)
  })
  it('a record with no shadow decisions, or a row whose turns carry no t, yields nothing and says why', () => {
    expect(intervalsOf({ ...wave, shadowDecisions: [] }, row)).toEqual({ intervals: [], excluded: { short: 0, noTicks: 1, noTurnTimes: 0, otherVersion: 0 } })
    const v1 = { ...row, turns: row.turns.map(({ t, ...rest }) => rest) }
    expect(intervalsOf(wave, v1).excluded.noTurnTimes).toBe(1)
  })
  it('v1 slices are otherVersion under signalsVersion 2', () => {
    const v1 = { ...row, turns: row.turns.map(t => ({ ...t, signalsVersion: 1 })) }
    expect(intervalsOf(wave, v1).excluded.otherVersion).toBe(3)
  })
  it('intervalRows joins waves to rows by missionId and counts the excluded', () => {
    const { rows, excluded, waves } = intervalRows([row, { ...row, missionId: 'other' }], [wave])
    expect(waves).toBe(1); expect(rows).toHaveLength(3); expect(excluded.short).toBe(0)
  })
  it('DATASET_INTERVALS_PATH is under the home datasets dir', () => {
    expect(DATASET_INTERVALS_PATH('C:/h/.cynco').replace(/\\/g, '/')).toBe('C:/h/.cynco/datasets/outcome-dataset-intervals.jsonl')
  })
})
