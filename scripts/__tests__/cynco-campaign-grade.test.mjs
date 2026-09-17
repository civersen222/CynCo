import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { gradeWave } from '../cynco-campaign-grade.mjs'

const baseLog = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')
const spec = { repo: 'C:/repo', gate: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/gate_c8.py', suiteBaseline: 'C:/x/suite_baseline.txt',
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, work: [] }
const row = { commitRange: { base: '1d03308', head: '1bc0f8c' }, toolStats: { total: 931, commits: 5, byClass: { sourceEdit: 86, fileWrite: 17, inspect: 828 }, bashByEffect: { revert: 1 } } }

function fakeIo(script) {
  const calls = []
  return { calls, run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); const key = [cmd, ...args].join(' '); for (const [re, r] of script) if (re.test(key)) return { status: 0, stdout: '', stderr: '', timedOut: false, ...r }; throw new Error(`unscripted: ${key}`) } }
}

describe('gradeWave', () => {
  it('runs gate, suite gate and sweep in the repo and assembles the grade', async () => {
    const io = fakeIo([
      [/gate_c8\.py/, { status: 1, stdout: baseLog }],
      [/g_suite_no_regression\.py/, { status: 0, stdout: 'g_suite: PASS — no test that passes on the baseline is red on this tree.\n' }],
      [/cynco-mutation-sweep\.py/, { status: 1, stdout: 'Record it with:\n\n{"command":"python scripts/cynco-mutation-sweep.py --repo C:/repo --base 1d03308 --head 1bc0f8c","kind":"derived","killed":6,"total":25,"survived":["gilded/x.py:12"]}\n' }],
    ])
    const g = await gradeWave(spec, row, io)
    expect(g.sha).toBe('1bc0f8c')
    expect(g.gate.failCount).toBe(14); expect(g.gate.exit).toBe(1); expect(g.gate.harnessFault).toBeNull()
    expect(g.suite.exit).toBe(0); expect(g.suite.regressions).toEqual([])
    expect(g.sweep).toMatchObject({ kind: 'derived', killed: 6, total: 25, survived: ['gilded/x.py:12'] })
    expect(g.verified).toBe(false)
    // Hand-computed (ruling 2): stated {sourceEdit:0.15, commit:1/150≈0.006667, inspect:0.843333},
    // observed counts {sourceEdit:103, commit:5, inspect:828, other(revert):1}, support=937, ε=1e-3, n=4.
    // p ≈ [0.109926, 0.005337, 0.883669, 0.001068]; q ≈ [0.150398, 0.007636, 0.840969, 0.000996].
    // KL(p‖q) = Σ p_i·ln(p_i/q_i) ≈ 0.0074686 — below driftThreshold 0.1, so verdict is Consistent,
    // not Drifting as originally drafted; see task-5-report.md for the full number.
    expect(g.posiwid.verdict).toBe('Consistent')
    expect(g.posiwid.divergence).toBeCloseTo(0.0074686, 6)
    expect(g.posiwid.dominantObserved).toBe('inspect')
    expect(io.calls[0].opts.cwd).toBe('C:/repo')
    expect(io.calls[1].opts.env.CHK_SUITE_BASELINE).toBe('C:/x/suite_baseline.txt')
  })
  it('a gate that raises is a harness fault → verified null', async () => {
    const io = fakeIo([[/gate_c8\.py/, { status: 1, stdout: 'Traceback (most recent call last):\nKeyError: 1\n' }], [/g_suite/, { status: 0, stdout: 'g_suite: PASS' }], [/sweep/, { status: 2, stdout: '' }]])
    const g = await gradeWave(spec, row, io)
    expect(g.gate.harnessFault).toMatch(/Traceback/)
    expect(g.verified).toBeNull()
    expect(g.sweep).toBeNull()
  })
  it('a refused suite gate (exit 2) is a harness fault', async () => {
    const io = fakeIo([[/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }], [/g_suite/, { status: 2, stdout: 'g_suite: REFUSING — a regression gate with no baseline measures nothing.' }], [/sweep/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":1,"total":1,"survived":[]}' }]])
    const g = await gradeWave(spec, row, io)
    expect(g.suite.harnessFault).toMatch(/REFUSING/)
    expect(g.verified).toBeNull()
  })
  it('parses regressions by node id from the suite gate output', async () => {
    const io = fakeIo([[/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }], [/g_suite/, { status: 1, stdout: '  REGRESSED 2 test(s) that pass on the baseline:\n      - gilded/tests/a.py::test_x\n      - gilded/tests/b.py::test_y\ng_suite: FAIL' }], [/sweep/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":1,"total":1,"survived":[]}' }]])
    const g = await gradeWave(spec, row, io)
    expect(g.suite.regressions).toEqual(['gilded/tests/a.py::test_x', 'gilded/tests/b.py::test_y'])
    expect(g.verified).toBe(false)
  })
})
