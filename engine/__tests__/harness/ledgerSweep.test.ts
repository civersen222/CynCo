import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore — untyped harness module
import { arg, argList, sweepProblems, main } from '../../../scripts/cynco-ledger-sweep.mjs'

// Regression origin: recording a 21/29 sweep with eight survivors wrote
// `survived: ["11"]`. Two defects combined — `--survived` read only one argv
// token, and nothing checked the list length against total - killed. The record
// that resulted said "one rule unpinned" when eight were, and it read as
// measured. These tests pin both halves.

const argv = (...rest: string[]) => ['bun', 'cynco-ledger-sweep.mjs', ...rest]

describe('cynco-ledger-sweep argument parsing', () => {
  it('--survived a,b and --survived a b produce the same list', () => {
    const comma = argList(argv('--survived', 'a,b,c'), 'survived')
    const spaced = argList(argv('--survived', 'a', 'b', 'c'), 'survived')
    expect(comma).toEqual(['a', 'b', 'c'])
    expect(spaced).toEqual(['a', 'b', 'c'])
  })

  it('gathers every token, not just the first — the eight-survivor bug', () => {
    const ids = argList(
      argv('--killed', '21', '--survived', '11', '11.1', '13.1', '13.2', '14', '14.1', '16', '16.1', '--dry-run'),
      'survived',
    )
    expect(ids).toHaveLength(8)
    expect(ids).toEqual(['11', '11.1', '13.1', '13.2', '14', '14.1', '16', '16.1'])
  })

  it('stops at the next --flag so trailing flags are not read as ids', () => {
    expect(argList(argv('--survived', '11', '--dry-run'), 'survived')).toEqual(['11'])
    expect(argList(argv('--survived', '--dry-run'), 'survived')).toEqual([])
  })

  it('distinguishes an absent flag (undefined) from an empty list', () => {
    expect(argList(argv('--killed', '3'), 'survived')).toBeUndefined()
    expect(argList(argv('--survived'), 'survived')).toEqual([])
  })

  it('arg reads a single value and returns undefined when absent', () => {
    expect(arg(argv('--killed', '21'), 'killed')).toBe('21')
    expect(arg(argv('--killed', '21'), 'total')).toBeUndefined()
  })
})

describe('cynco-ledger-sweep validation', () => {
  it('rejects a survivor list shorter than total - killed', () => {
    const problems = sweepProblems('21', '29', ['11'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('names 1 id(s)')
    expect(problems[0]).toContain('29 - 21 = 8')
  })

  it('rejects a gap with no survivors named', () => {
    const problems = sweepProblems('21', '29', [])
    expect(problems.some((p: string) => p.includes('8 mutation(s) survived'))).toBe(true)
  })

  it('rejects survivors named when nothing survived', () => {
    const problems = sweepProblems('29', '29', ['11'])
    expect(problems.some((p: string) => p.includes('29 - 29 = 0'))).toBe(true)
  })

  it('rejects a list padded to the right length with a repeat', () => {
    const eight = ['11', '11', '13.1', '13.2', '14', '14.1', '16', '16.1']
    const problems = sweepProblems('21', '29', eight)
    expect(problems.some((p: string) => p.includes('repeats id(s): 11'))).toBe(true)
  })

  it('accepts a partial sweep that names exactly its survivors', () => {
    expect(sweepProblems('21', '29', ['11', '11.1', '13.1', '13.2', '14', '14.1', '16', '16.1'])).toEqual([])
  })

  it('accepts a clean sweep with no survivors', () => {
    expect(sweepProblems('15', '15', [])).toEqual([])
  })

  it('rejects non-counts and killed > total', () => {
    expect(sweepProblems('abc', '29', []).some((p: string) => p.includes('not a count'))).toBe(true)
    expect(sweepProblems('1', '0', []).some((p: string) => p.includes('positive count'))).toBe(true)
    expect(sweepProblems('30', '29', []).some((p: string) => p.includes('killed (30) > total (29)'))).toBe(true)
  })
})

/**
 * The write path went untested for as long as the only way to run it was to
 * write to the real 58 MB ledger. Splitting that file across shards changed
 * exactly this code — it now has to pick the right shard and rewrite only that
 * one — so it gets a throwaway ledger and real assertions.
 */
describe('cynco-ledger-sweep writes back to the shard the record lives in', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    writeFileSync(join(dir, 'missions.jsonl'),
      '{"missionId":"a","mutationSweep":null}\n{"missionId":"b","mutationSweep":null}\n')
    writeFileSync(join(dir, 'missions.0002.jsonl'),
      '{"missionId":"c","mutationSweep":null}\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))

  it('--record N counts across shards, so N is the Nth mission ever run', () => {
    // Record 3 is the only row in the SECOND shard. Numbering that restarted
    // per file would have edited row "a" here.
    expect(main(argv('--record', '3', '--command', 'x', '--killed', '2', '--total', '2'), dir)).toBe(0)
    expect(read('missions.0002.jsonl')[0].mutationSweep).toEqual(
      { command: 'x', killed: 2, total: 2, survived: [] })
    // The other shard is untouched, byte for byte.
    expect(read('missions.jsonl').map((r) => r.mutationSweep)).toEqual([null, null])
  })

  it('leaves every other shard alone, and every other row in its own shard intact', () => {
    expect(main(argv('--mission', 'b', '--command', 'y', '--killed', '1', '--total', '2',
      '--survived', 'r7'), dir)).toBe(0)
    const head = read('missions.jsonl')
    expect(head).toHaveLength(2)
    expect(head[0]).toEqual({ missionId: 'a', mutationSweep: null })
    expect(head[1].mutationSweep).toEqual({ command: 'y', killed: 1, total: 2, survived: ['r7'] })
    expect(read('missions.0002.jsonl')[0].mutationSweep).toBeNull()
  })

  // The shard tag is bookkeeping the reader attaches, not ledger content. A
  // visible one would be re-serialized straight back into every rewritten row.
  it('does not write its own bookkeeping into the records', () => {
    expect(main(argv('--record', '1', '--command', 'z', '--killed', '1', '--total', '1'), dir)).toBe(0)
    expect(read('missions.jsonl').every((r) => !('__shard' in r) && !('__line' in r))).toBe(true)
  })

  // `kind` decides whether a survivor FAILS the mission or merely reports thin
  // coverage (see labelOf in scripts/cynco-signal-validation.mjs), so the two
  // must be distinguishable in the written record and must not be conflated.
  it('an authored sweep records no kind, keeping all 42 existing rows valid', () => {
    expect(main(argv('--record', '1', '--command', 'z', '--killed', '1', '--total', '1'), dir)).toBe(0)
    const rec = read('missions.jsonl')[0].mutationSweep
    expect('kind' in rec).toBe(false)
    expect(rec).toEqual({ command: 'z', killed: 1, total: 1, survived: [] })
  })

  it('a derived sweep is marked, so its survivors are not read as unmet DoD claims', () => {
    expect(main(argv('--record', '1', '--command', 'gen', '--killed', '0', '--total', '2',
      '--survived', 'ai.py:12:cmp->LtE,ai.py:13:bool->Or', '--kind', 'derived'), dir)).toBe(0)
    expect(read('missions.jsonl')[0].mutationSweep).toEqual({
      kind: 'derived', command: 'gen', killed: 0, total: 2,
      survived: ['ai.py:12:cmp->LtE', 'ai.py:13:bool->Or'],
    })
  })

  it('an unknown --kind writes nothing rather than guessing', () => {
    const before = read('missions.jsonl')
    expect(main(argv('--record', '1', '--command', 'z', '--killed', '1', '--total', '1',
      '--kind', 'advisory'), dir)).toBe(2)
    expect(read('missions.jsonl')).toEqual(before)
  })

  it('--dry-run and an out-of-range record both leave the ledger exactly as it was', () => {
    const before = read('missions.jsonl')
    expect(main(argv('--record', '1', '--command', 'z', '--killed', '1', '--total', '1',
      '--dry-run'), dir)).toBe(0)
    expect(main(argv('--record', '99', '--command', 'z', '--killed', '1', '--total', '1'), dir)).toBe(2)
    expect(main(argv('--mission', 'nope', '--command', 'z', '--killed', '1', '--total', '1'), dir)).toBe(2)
    // An invalid sweep must not write either: a half-written record reads as
    // measured, which is worse than no record.
    expect(main(argv('--record', '1', '--command', 'z', '--killed', '1', '--total', '3'), dir)).toBe(2)
    expect(read('missions.jsonl')).toEqual(before)
  })
})
