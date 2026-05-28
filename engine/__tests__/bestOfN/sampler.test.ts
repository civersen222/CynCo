import { describe, it, expect } from 'bun:test'
import { selectWinner, parseTestOutput } from '../../bestOfN/sampler.js'
import type { CandidateResult } from '../../bestOfN/types.js'

function makeCandidate(overrides: Partial<CandidateResult>): CandidateResult {
  return {
    index: 0,
    worktreePath: '/tmp/worktree',
    patch: 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new',
    testsPassed: 0,
    testsTotal: 0,
    passRate: 0,
    stuckTurns: 0,
    totalTurns: 5,
    ...overrides,
  }
}

describe('selectWinner', () => {
  it('picks highest pass rate', () => {
    const candidates = [
      makeCandidate({ index: 0, passRate: 0.5 }),
      makeCandidate({ index: 1, passRate: 0.9 }),
      makeCandidate({ index: 2, passRate: 0.7 }),
    ]
    const winner = selectWinner(candidates)
    expect(winner).not.toBeNull()
    expect(winner!.index).toBe(1)
  })

  it('tiebreaks on fewer turns', () => {
    const candidates = [
      makeCandidate({ index: 0, passRate: 0.8, totalTurns: 10 }),
      makeCandidate({ index: 1, passRate: 0.8, totalTurns: 4 }),
      makeCandidate({ index: 2, passRate: 0.8, totalTurns: 7 }),
    ]
    const winner = selectWinner(candidates)
    expect(winner).not.toBeNull()
    expect(winner!.index).toBe(1)
  })

  it('returns null for empty array', () => {
    expect(selectWinner([])).toBeNull()
  })

  it('skips candidates with empty patches', () => {
    const candidates = [
      makeCandidate({ index: 0, patch: '', passRate: 1.0 }),
      makeCandidate({ index: 1, patch: '   ', passRate: 0.9 }),
      makeCandidate({ index: 2, passRate: 0.5 }),
    ]
    const winner = selectWinner(candidates)
    expect(winner).not.toBeNull()
    expect(winner!.index).toBe(2)
  })

  it('returns null when all patches are empty', () => {
    const candidates = [
      makeCandidate({ index: 0, patch: '' }),
      makeCandidate({ index: 1, patch: '   ' }),
    ]
    expect(selectWinner(candidates)).toBeNull()
  })
})

describe('parseTestOutput', () => {
  it('parses pytest output', () => {
    const output = '3 passed, 1 failed in 0.42s'
    const result = parseTestOutput(output, 'pytest')
    expect(result.passed).toBe(3)
    expect(result.total).toBe(4)
  })

  it('parses pytest output with only passing', () => {
    const output = '5 passed in 1.23s'
    const result = parseTestOutput(output, 'pytest')
    expect(result.passed).toBe(5)
    expect(result.total).toBe(5)
  })

  it('parses jest output', () => {
    const output = 'Tests: 4 passed, 6 total'
    const result = parseTestOutput(output, 'jest')
    expect(result.passed).toBe(4)
    expect(result.total).toBe(6)
  })

  it('parses bun output', () => {
    const output = '7 pass\n2 fail'
    const result = parseTestOutput(output, 'bun')
    expect(result.passed).toBe(7)
    expect(result.total).toBe(9)
  })

  it('returns zeros for unparseable output', () => {
    const result = parseTestOutput('something completely different', 'unknown')
    expect(result.passed).toBe(0)
    expect(result.total).toBe(0)
  })

  it('returns zeros for empty output with unknown framework', () => {
    const result = parseTestOutput('', 'unknown')
    expect(result.passed).toBe(0)
    expect(result.total).toBe(0)
  })
})
