import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { intervalsOf, intervalRows, INTERVAL_MIN_TURNS, DATASET_INTERVALS_PATH, main } from '../cynco-outcome-dataset.mjs'

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
    expect(excluded).toEqual({ short: 0, noTicks: 0, noTurnTimes: 0, otherVersion: 0, afterZero: 0 })
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
    expect(intervalsOf({ ...wave, shadowDecisions: [] }, row)).toEqual({ intervals: [], excluded: { short: 0, noTicks: 1, noTurnTimes: 0, otherVersion: 0, afterZero: 0 } })
    const v1 = { ...row, turns: row.turns.map(({ t, ...rest }) => rest) }
    expect(intervalsOf(wave, v1).excluded.noTurnTimes).toBe(1)
  })
  it('M5: a turn without a numeric t is skipped from its interval, not the whole row — noTurnTimes is row-level only', () => {
    const partial = { ...row, turns: row.turns.map((t, i) => { if (i !== 5) return t; const { t: _dropped, ...rest } = t; return rest }) }
    const { intervals, excluded } = intervalsOf(wave, partial)
    expect(excluded.noTurnTimes).toBe(0)
    expect(intervals[0].turns).toBe(19)   // turn index 5 falls inside interval 0 and is dropped, not the row
    expect(intervals[1].turns).toBe(20)
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

  it('I1: a faulted tick is dropped; its span merges into the next interval (ticks 20 → FAULT → 12)', () => {
    const faultAt = '2026-10-01T01:15:00.000Z'
    const faulted = {
      ...wave,
      // shadowNoProgress copies the LAST MEASURED reading's fails onto a
      // faulted tick (cynco-campaign-progress.mjs:242) — the fault tick is
      // not a real reading of 20, it is the previous reading's stale count.
      progress: [
        { at: '2026-10-01T00:45:00.000Z', sha: 'a', fails: 20, passes: 1, failIds: [], durationMs: 100, elapsedFraction: 0.094 },
        { at: faultAt, fault: 'archive of a failed', durationMs: 50 },
        { at: '2026-10-01T01:45:00.000Z', sha: 'b', fails: 12, passes: 1, failIds: [], durationMs: 100, elapsedFraction: 0.219 },
      ],
      shadowDecisions: [
        { rule: 'R1.no-progress', at: '2026-10-01T00:45:00.000Z', elapsedFraction: 0.094, fired: false, startFails: 20, fails: 20, wouldHaveSavedS: 26100 },
        { rule: 'R1.no-progress', at: faultAt, elapsedFraction: 0.156, fired: false, startFails: 20, fails: 20, wouldHaveSavedS: 24300 },
        { rule: 'R1.no-progress', at: '2026-10-01T01:45:00.000Z', elapsedFraction: 0.219, fired: false, startFails: 20, fails: 12, wouldHaveSavedS: 22500 },
      ],
    }
    const { intervals, excluded } = intervalsOf(faulted, row)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]).toMatchObject({
      failsStart: 20, failsEnd: 12, label: 'improved', turns: 40,
      at: ['2026-10-01T00:45:00.000Z', '2026-10-01T01:45:00.000Z'],
    })
    expect(excluded).toEqual({ short: 0, noTicks: 0, noTurnTimes: 0, otherVersion: 0, afterZero: 0 })
  })

  it('I2: an interval whose failsStart is 0 is excluded as afterZero, not labeled stalled (ticks 2 → 0 → 0 → 0)', () => {
    const solved = { ...wave, shadowDecisions: wave.shadowDecisions.map((d, i) => ({ ...d, fails: [2, 0, 0, 0][i] })) }
    const { intervals, excluded } = intervalsOf(solved, row)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]).toMatchObject({ failsStart: 2, failsEnd: 0, label: 'improved' })
    expect(excluded.afterZero).toBe(2)
  })

  it('M1: the slice is sorted by t before aggregating, not left in array order', () => {
    const reversed = { ...row, turns: [...row.turns].reverse() }
    expect(intervalsOf(wave, reversed).intervals).toEqual(intervalsOf(wave, row).intervals)
  })

  it('M2: the R1.no-progress decision at an `at` wins the tick even when another rule is listed first', () => {
    // The wave started at 25 fails (a commit landed before the first tick), so
    // the first tick's own `fails` (20) is NOT the wave's `startFails` — only
    // R1's decision carries `startFails`; a wrong pick falls back to `fails`
    // and would silently read a different (here, equal-looking but wrong)
    // share.
    const withDistinctStart = { ...wave, shadowDecisions: wave.shadowDecisions.map((d, i) => (i === 0 ? { ...d, startFails: 25 } : d)) }
    const r2First = {
      ...withDistinctStart,
      shadowDecisions: withDistinctStart.shadowDecisions.flatMap((d) => {
        const { startFails, ...r2 } = d
        return [{ ...r2, rule: 'R2.stalled' }, d]
      }),
    }
    const direct = intervalsOf(withDistinctStart, row)
    const { intervals } = intervalsOf(r2First, row)
    expect(intervals.map(i => i.label)).toEqual(direct.intervals.map(i => i.label))
    expect(intervals[0].failsStart).toBe(20)
    expect(intervals[0].features['interval.failsStartShare']).toBe(direct.intervals[0].features['interval.failsStartShare'])
    expect(intervals[0].features['interval.failsStartShare']).toBeCloseTo(20 / 25, 5)
  })

  describe('CLI: --export-intervals', () => {
    it('reads the ledger and campaign waves under CYNCO_HOME, writes JSONL, and prints the counts', async () => {
      const prevHome = process.env.CYNCO_HOME
      const home = mkdtempSync(join(tmpdir(), 'outcome-intervals-home-'))
      const ledgerDir = mkdtempSync(join(tmpdir(), 'outcome-intervals-ledger-'))
      process.env.CYNCO_HOME = home
      try {
        const campaignDir = join(home, 'campaigns', 'fx')
        mkdirSync(campaignDir, { recursive: true })
        writeFileSync(join(campaignDir, 'waves.jsonl'), JSON.stringify(wave) + '\n', 'utf8')
        writeFileSync(join(ledgerDir, 'missions.jsonl'), JSON.stringify(row) + '\n', 'utf8')
        const lines = []
        const io = { log: (s) => lines.push(s), error: (s) => lines.push(s) }
        const code = await main(['--export-intervals', '--ledger-dir', ledgerDir], io)
        expect(code).toBe(0)
        const out = join(home, 'datasets', 'outcome-dataset-intervals.jsonl')
        const written = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
        expect(written).toHaveLength(3)
        expect(written.map(r => r.label)).toEqual(['improved', 'stalled', 'improved'])
        expect(lines[0]).toMatch(/reading-level outcomes: 3 rows from 1 waves \(excluded 0 short, 0 no ticks, 0 no turn times, 0 other signals version, 0 after zero fails, 0 no ledger row\) →/)
      } finally {
        if (prevHome === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prevHome
        // T1-N2: the temp home and ledger are this test's alone — removed, not left behind.
        for (const d of [home, ledgerDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
      }
    })
  })
})
