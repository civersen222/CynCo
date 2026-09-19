import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { gradeWave, sweepTestsFor } from '../cynco-campaign-grade.mjs'

const baseLog = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')
const spec = { repo: 'C:/repo', gate: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/gate_c8.py', suiteBaseline: 'C:/x/suite_baseline.txt',
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, work: [] }
const row = { commitRange: { base: '1d03308', head: '1bc0f8c' }, toolStats: { total: 931, commits: 5, byClass: { sourceEdit: 86, fileWrite: 17, inspect: 828 }, bashByEffect: { revert: 1 } } }

// F147 fixture: a c8-like keepGreen command naming the twelve KEEP-GREEN test files.
const c8KeepGreenFiles = ['agenda', 'bonds', 'council', 'dominion', 'events', 'factions', 'gilded', 'ledger', 'market', 'petitions', 'tiers', 'ui']
  .map(n => `gilded/tests/test_c8_${n}.py`)
const c8KeepGreen = `python -m pytest ${c8KeepGreenFiles.join(' ')} -q`

function fakeIo(script, changedFiles = () => []) {
  const calls = []
  return { calls, changedFiles, run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); const key = [cmd, ...args].join(' '); for (const [re, r] of script) if (re.test(key)) return { status: 0, stdout: '', stderr: '', timedOut: false, ...r }; throw new Error(`unscripted: ${key}`) } }
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
    expect(g.sweepFault).toBeNull()
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
    expect(io.calls[0].opts.env.CYNCO_GATE_REPO).toBe('C:/repo')
    expect(io.calls[1].opts.env.CHK_SUITE_BASELINE).toBe('C:/x/suite_baseline.txt')
    expect(io.calls[1].opts.env.CYNCO_GATE_REPO).toBe('C:/repo')
    // default cap: 25 mutants, the sweep's own default made explicit
    expect(io.calls[2].args.join(' ')).toMatch(/--max 25/)
  })
  // The sweep re-runs the KEEP-GREEN suite once per mutant — the most expensive
  // instrument in the loop, and the one that has timed out where the gate did not.
  it('passes the spec\'s sweep cap through to cynco-mutation-sweep.py', async () => {
    const io = fakeIo([
      [/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }],
      [/g_suite_no_regression\.py/, { status: 0, stdout: 'g_suite: PASS' }],
      [/cynco-mutation-sweep\.py/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":6,"total":6,"survived":[]}' }],
    ])
    const g = await gradeWave({ ...spec, sweep: { max: 6 } }, row, io)
    expect(io.calls[2].args.join(' ')).toMatch(/--max 6/)
    expect(g.sweep.total).toBe(6)
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
  it('records why the sweep produced nothing: timeout, refusal, unparseable output, no diff', async () => {
    const green = [[/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }], [/g_suite/, { status: 0, stdout: 'g_suite: PASS' }]]
    const timedOut = await gradeWave(spec, row, fakeIo([...green, [/sweep/, { status: null, stdout: '', timedOut: true }]]))
    expect(timedOut.sweep).toBeNull(); expect(timedOut.sweepFault).toBe('timed out after 3600000 ms')
    const refused = await gradeWave(spec, row, fakeIo([...green, [/sweep/, { status: 2, stdout: '' }]]))
    expect(refused.sweepFault).toBe('sweep refused (exit 2)')
    const garbage = await gradeWave(spec, row, fakeIo([...green, [/sweep/, { status: 0, stdout: 'no json here\n' }]]))
    expect(garbage.sweepFault).toBe('unparseable sweep output')
    const broken = await gradeWave(spec, row, fakeIo([...green, [/sweep/, { status: 0, stdout: '{"killed":' }]]))
    expect(broken.sweepFault).toBe('unparseable sweep output')
    // No diff is not a fault: the sweep was never attempted.
    const noDiff = await gradeWave(spec, { ...row, commitRange: { base: '1d03308', head: '1d03308' } }, fakeIo(green))
    expect(noDiff.sweep).toBeNull(); expect(noDiff.sweepFault).toBeNull()
  })
  it('parses regressions by node id from the suite gate output', async () => {
    const io = fakeIo([[/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }], [/g_suite/, { status: 1, stdout: '  REGRESSED 2 test(s) that pass on the baseline:\n      - gilded/tests/a.py::test_x\n      - gilded/tests/b.py::test_y\ng_suite: FAIL' }], [/sweep/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":1,"total":1,"survived":[]}' }]])
    const g = await gradeWave(spec, row, io)
    expect(g.suite.regressions).toEqual(['gilded/tests/a.py::test_x', 'gilded/tests/b.py::test_y'])
    expect(g.verified).toBe(false)
  })

  // F147: a fix-only wave (no test file in the diff) must hand the sweep the
  // KEEP-GREEN test files, or the sweep refuses (exit 2) and the row goes
  // unlabeled even though the sealed gate and suite gate both PASSed.
  it('hands the sweep --tests <keepGreen .py files> when the diff delivered no test file', async () => {
    const io = fakeIo([
      [/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }],
      [/g_suite_no_regression\.py/, { status: 0, stdout: 'g_suite: PASS' }],
      [/cynco-mutation-sweep\.py/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":1,"total":1,"survived":[]}' }],
    ], () => ['gilded/ui/broadsheet.py'])
    const g = await gradeWave({ ...spec, keepGreen: c8KeepGreen }, row, io)
    const sweepArgs = io.calls[2].args
    const i = sweepArgs.indexOf('--tests')
    expect(i).toBeGreaterThan(-1)
    expect(sweepArgs[i + 1]).toBe(c8KeepGreenFiles.join(' '))
    expect(g.sweepFault).toBeNull()
  })

  it('leaves the sweep\'s own default alone when the diff already ships a test file', async () => {
    const io = fakeIo([
      [/gate_c8\.py/, { status: 0, stdout: 'GATE: PASS\n' }],
      [/g_suite_no_regression\.py/, { status: 0, stdout: 'g_suite: PASS' }],
      [/cynco-mutation-sweep\.py/, { status: 0, stdout: '{"command":"x","kind":"derived","killed":1,"total":1,"survived":[]}' }],
    ], () => ['gilded/ui/broadsheet.py', 'gilded/tests/test_c8_tiers.py'])
    const g = await gradeWave({ ...spec, keepGreen: c8KeepGreen }, row, io)
    expect(io.calls[2].args).not.toContain('--tests')
  })
})

describe('sweepTestsFor', () => {
  const spec = { keepGreen: c8KeepGreen }
  it('hands over the keepGreen .py files when the diff has no test file', () => {
    expect(sweepTestsFor(spec, ['gilded/ui/broadsheet.py'])).toBe(c8KeepGreenFiles.join(' '))
  })
  it('returns null when the diff already delivers a test file', () => {
    expect(sweepTestsFor(spec, ['gilded/ui/x.py', 'gilded/tests/test_c8_tiers.py'])).toBeNull()
  })
  it('returns null when keepGreen has no .py token', () => {
    expect(sweepTestsFor({ keepGreen: 'echo nothing to run' }, ['gilded/ui/broadsheet.py'])).toBeNull()
  })
})
