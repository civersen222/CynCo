import { describe, expect, it } from 'vitest'
// @ts-ignore — untyped harness module
import { arg, argList, sweepProblems } from '../../../scripts/cynco-ledger-sweep.mjs'

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
