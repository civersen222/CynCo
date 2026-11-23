// F237: the driver's verification shows every failing line, not only the tail.
//
// 2026-11-14, the t5 wave 2a gate: its two FAIL lines came early, then dozens of
// regression PASS lines and `GATE: MISS (2 fails)`. The driver printed the last
// 2,000 characters ("[verify] output tail"), which held PASS lines alone, and
// the ledger row's `outputTail` the same; the operator re-ran the gate to see
// what failed. The fixture has that shape: the two failures, then enough PASS
// lines (verbatim shapes from that log) that the tail cannot hold them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { failingLines, failReport, FAIL_LINE, FAIL_LINES_MAX, runCheck, runCheckAsync } from '../cynco-verify.mjs'
import { testContainment } from '../../engine/containment.js'

const passes = [
  'regression T3.8 an expert bluffs the player who folds and never the one who calls; a sharp does not tell them apart: PASS',
  'regression T3.9 five card draw: a sharp lets a pair of kings go to a one-card drawer more often than to a three-card drawer; a greenhorn does not notice: PASS',
  'regression T4.2 bookMove is exactly today\'s by-the-book play, move for move: PASS',
  'regression T4.7 bets: within the table limits and the stack, a whole number of steps; no bet it cannot cover; insurance only when it can be paid: PASS',
]
const gateOutput = [
  'W2.1 omaha starting estimate scaled per game: PASS',
  'W2.2 calibration: every cell within 0.05 of its target: FAIL 47 cells out of band (worst: omaha/steady/greenhorn 0.71 vs 0.55)',
  'W2.3 draw: a pair of kings stands pat against a one-card draw: FAIL stood 31% of the time, need >= 60%',
  ...Array.from({ length: 6 }, () => passes).flat(),
  'W2.9 whole suite: PASS passed=755 (need >= 752) failed=0 skipped=0 todo=0',
  'W2.10 typecheck: PASS',
  'W2.11 build: PASS',
  'GATE: MISS (2 fails)',
].join('\n')
const tail = gateOutput.slice(-2000)

describe('the 2026-11-14 gate output', () => {
  it('the 2,000-character tail the driver printed holds no FAIL line — the defect', () => {
    expect(tail).not.toMatch(/: FAIL/)
    expect(tail).toContain('GATE: MISS (2 fails)')
  })
  it('the report names both failures and the terminator, then the tail as before', () => {
    const report = failReport(gateOutput, tail)
    expect(report).toMatch(/^\[verify\] failing lines \(3\):\n/)
    expect(report).toContain('  W2.2 calibration: every cell within 0.05 of its target: FAIL 47 cells out of band')
    expect(report).toContain('  W2.3 draw: a pair of kings stands pat against a one-card draw: FAIL stood 31% of the time')
    expect(report).toContain('  GATE: MISS (2 fails)')
    expect(report).toContain('\n[verify] output tail:\n')
    expect(report.endsWith(tail)).toBe(true)
  })
  it('a count is not a failure: "failed=0" and "PASS" lines are never listed', () => {
    expect(failingLines(gateOutput).lines.some(l => /failed=0|: PASS$/.test(l))).toBe(false)
  })
})

describe('the other shapes a check prints', () => {
  it('vitest, pytest and a CivKings gate line', () => {
    const out = [
      ' FAIL  packages/engine/test/poker/nerve.slow.test.ts > nerve > a brave seat raises',
      ' × a brave seat raises more than a timid one 12ms',
      'FAILED gilded/tests/test_c11_rivals.py::test_reads_you - AssertionError',
      'C11.1a.rival-reads-you: FAIL no line belonging to House Ashworth changes across the nine states',
      ' ✓ passes 3ms',
      ' Test Files  3 failed | 7 passed (10)',
    ].join('\n')
    expect(failingLines(out).lines).toEqual([
      ' FAIL  packages/engine/test/poker/nerve.slow.test.ts > nerve > a brave seat raises',
      ' × a brave seat raises more than a timid one 12ms',
      'FAILED gilded/tests/test_c11_rivals.py::test_reads_you - AssertionError',
      'C11.1a.rival-reads-you: FAIL no line belonging to House Ashworth changes across the nine states',
    ])
    expect(FAIL_LINE.test(' Test Files  3 failed | 7 passed (10)')).toBe(false)
  })
  it('a runaway suite is capped, and says how many more there were', () => {
    const out = Array.from({ length: 75 }, (_, i) => `T${i}: FAIL x`).join('\n')
    const r = failingLines(out)
    expect(r.lines).toHaveLength(FAIL_LINES_MAX)
    expect(r.more).toBe(15)
    expect(failReport(out, 'tail')).toMatch(/^\[verify\] failing lines \(75, the first 60 shown\):/)
  })
  it('an output that names no failure says so instead of an empty heading', () => {
    expect(failReport('Error: Cannot find module x\n    at y', 'Error: Cannot find module x')).toMatch(/^\[verify\] no line of the output names a failure/)
  })
})

describe('the driver uses it', () => {
  const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8')
  it('both places that printed only the tail print the report, and the ledger row keeps the lines', () => {
    expect(driver).not.toMatch(/console\.log\(`\[verify\] output tail:/)
    expect(driver.match(/console\.log\(failReport\(/g)).toHaveLength(2)
    expect(driver).toMatch(/failLines: failingLines\(r\.output\)\.lines \}/)
    expect(driver).toMatch(/failLines: failingLines\(attempt\.r\.output\)\.lines,/)
  })
})

// F242 (01-isolation 7.2, tests 9.7): the driver's check and probe run inside the run's containment.
// A check that could not be started there is a harness fault, never a failed delivery.
describe('runCheck with the run context', () => {
  const ctx = () => {
    const d = join(tmpdir(), 'cynco-verify-contained-nowhere')
    return testContainment({ missionCwd: d, sandbox: { root: d, home: join(d, 'h'), tmp: join(d, 't'), scratch: join(d, 's') }, home: d, folders: { state: d, models: d, guard: d, audit: null } })
  }
  it('a check that cannot start contained is UNMEASURED, naming ECONTAINMENT; without the option it runs as before', async () => {
    const before = process.env.LOCALCODE_CONTAINMENT_OFF
    process.env.LOCALCODE_CONTAINMENT_OFF = 'nonsense'
    try {
      const r = runCheck('exit 0', process.cwd(), 30_000, { contained: ctx() })
      expect(r.verified).toBeNull()
      expect(r.spawnFailed).toBe(true)
      expect(r.exitCode).toBeNull()
      expect(r.harnessFault).toMatch(/^spawn failed: code ECONTAINMENT/)
      expect(r.outputTail).toContain('[spawn] REFUSED: containment: LOCALCODE_CONTAINMENT_OFF names an unknown layer: nonsense')
      const a = await runCheckAsync('exit 0', process.cwd(), 30_000, { contained: ctx() })
      expect(a.verified).toBeNull()
      expect(a.harnessFault).toMatch(/^spawn failed: code ECONTAINMENT/)
    } finally {
      if (before === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
      else process.env.LOCALCODE_CONTAINMENT_OFF = before
    }
    const plain = runCheck('exit 0', process.cwd(), 30_000)
    expect(plain.verified).toBe(true)
    expect(plain.spawnFailed).toBe(false)
  }, 60_000)
})
