import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { calibrate, instrumentOf } from '../cynco-campaign-calibrate.mjs'
import { SUITE_TIMEOUT_MS } from '../cynco-campaign-grade.mjs'

const baseLog = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')
const spec = { id: 'c8', repo: 'C:/repo', base: '1d03308', gate: 'C:/h/gate_c8.py', perturb: 'C:/h/perturb_c8.py', suiteBaseline: 'C:/h/suite_baseline_1d03308.txt' }
const header = '# EXPECT-FLIP: C8.5.palette.Atlas C8.5.river-reserved\n# MUST-FAIL: C8.1b C8.1c C8.2b\nimport os\n'

// A header that classifies EVERY line the c8 BASE log fails, which is what
// compareCalibration demands once a positive shim is in play.
const fullHeader = ['# EXPECT-FLIP: C8.5.palette.Atlas',
  '# MUST-FAIL: C8.1a C8.1b C8.1c C8.2a C8.2b C8.2c C8.3a C8.3b C8.4a C8.4b C8.4d C8.5.palette.House C8.5.palette.Powers',
  'import os', ''].join('\n')
const positiveLog = baseLog.replace(/: FAIL /g, ': PASS ').replace('GATE: MISS (14 fails)', 'GATE: PASS')

function io({ perturbLog, baselineExists, headerText = header, positiveOut = positiveLog, expectRepo = 'C:/tmp/c8_base' }) {
  const writes = [], ran = []
  return { writes, ran,
    run: (cmd, args, opts) => {
      const k = [cmd, ...args].join(' ')
      ran.push(k)
      if (/git -C "?C:\/repo"? archive/.test(k) || /tar/.test(k)) return { status: 0, stdout: '', stderr: '' }
      if (/gate_c8\.py/.test(k)) { expect(opts.env.CYNCO_GATE_REPO).toBe(expectRepo); return { status: 1, stdout: baseLog, stderr: '' } }
      if (/perturb_c8\.py/.test(k)) return { status: 1, stdout: perturbLog, stderr: '' }
      if (/positive_c8\.py/.test(k)) { expect(opts.env.CYNCO_GATE_REPO).toBe(expectRepo); return { status: 0, stdout: positiveOut, stderr: '' } }
      if (/pytest/.test(k)) return { status: 1, stdout: 'FAILED gilded/tests/a.py::t1 - AssertionError\nFAILED gilded/tests/b.py::t2 - x\n2 failed, 100 passed\n', stderr: '' }
      throw new Error('unscripted ' + k)
    },
    exists: (p) => p === spec.suiteBaseline ? baselineExists : true,
    readFile: (p) => p === spec.perturb ? headerText : '',
    writeFile: (p, s) => writes.push({ p, s }),
    sha256: (p) => `sha-${p.split('/').pop()}`,
  }
}
const withPositive = { ...spec, positive: 'C:/h/positive_c8.py' }
const pythonRuns = (ran) => ran.filter(k => k.startsWith('python ') && !k.includes('pytest'))

describe('calibrate', () => {
  it('passes a clean BASE + honest perturb and writes the suite baseline when missing', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: false })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.baseFails).toHaveLength(14)
    // The three PASS lines at BASE (C8.4c, C8.5.river-reserved, C8.9) are what
    // wave 1's brief prints as "Already PASS at BASE and must stay so"; wave 1
    // shipped without them because calibrate never returned them.
    expect(r.basePasses.map(p => p.id)).toEqual(['C8.4c.beds-honour-mute', 'C8.5.river-reserved', 'C8.9'])
    expect(r.gateSha256).toBe('sha-gate_c8.py')
    expect(r.perturbSha256).toBe('sha-perturb_c8.py')
    expect(r.suiteBaselineCreated).toBe(true)
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0].p).toBe(spec.suiteBaseline)
    expect(fake.writes[0].s).toMatch(/gilded\/tests\/a\.py::t1\ngilded\/tests\/b\.py::t2/)
    expect(fake.writes[0].s).toMatch(/^# standing failures of gilded\/tests at 1d03308, measured \d{4}-\d{2}-\d{2} by cynco-campaign calibrate\n/)
  })

  it('refuses when a discriminator flips', async () => {
    const perturbLog = baseLog.replace('C8.1b.tiers-differ: FAIL', 'C8.1b.tiers-differ: PASS').replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/C8\.1b/)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(fake.writes).toHaveLength(0)
  })

  it('does not rewrite an existing suite baseline', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(fake.writes).toHaveLength(0)
  })

  // The header is the declaration the whole comparison is judged against, and it
  // costs a file read; running two gates of up to two hours first to reach the
  // same refusal is the expensive way to learn it.
  it('refuses a perturb with no header BEFORE it runs either gate', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const ran = []
    const inner = fake.run
    fake.run = (cmd, args, opts) => { ran.push([cmd, ...args].join(' ')); return inner(cmd, args, opts) }
    fake.readFile = () => 'import os\n'
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/EXPECT-FLIP/)
    expect(ran.filter(k => /gate_c8\.py|perturb_c8\.py/.test(k))).toEqual([])
  })

  // Rule 14 becomes mechanical: the shim that makes every graded fact true must
  // reach GATE: PASS, or the gate was never winnable and a campaign against it
  // would spend its whole budget learning that.
  it('runs the positive shim when the spec declares one, and reports its sha and verdict', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true, headerText: fullHeader })
    const r = await calibrate(withPositive, fake)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(pythonRuns(fake.ran)).toEqual(['python C:/h/gate_c8.py', 'python C:/h/perturb_c8.py', 'python C:/h/positive_c8.py'])
    expect(r.positiveSha256).toBe('sha-positive_c8.py')
    expect(r.positive.terminator).toBe('PASS')
    expect(r.positiveOutputTail).toMatch(/GATE: PASS/)
  })

  it('runs two commands and reports a null positive when the spec declares none', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(pythonRuns(fake.ran)).toEqual(['python C:/h/gate_c8.py', 'python C:/h/perturb_c8.py'])
    expect(r.positiveSha256).toBeNull()
    expect(r.positive).toBeNull()
    expect(r.positiveOutputTail).toBeNull()
  })

  it('refuses when the positive shim cannot make the gate PASS', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true, headerText: fullHeader, positiveOut: baseLog })
    const r = await calibrate(withPositive, fake)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['positive shim did not PASS (terminator MISS) (positive_c8.py)'])
    expect(fake.writes).toHaveLength(0)
  })

  // The authoring verb's --check has already archived the BASE to run the lint
  // against it; archiving the same commit a second time is minutes of IO for a
  // byte-identical tree.
  it('uses a caller-supplied baseDir and skips the archive entirely', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: true, headerText: fullHeader, expectRepo: 'C:/tmp/c8_author_base' })
    const r = await calibrate(withPositive, fake, { baseDir: 'C:/tmp/c8_author_base' })
    expect(r.ok).toBe(true)
    expect(fake.ran.filter(k => /archive/.test(k))).toHaveLength(0)

    const archiving = io({ perturbLog, baselineExists: true, headerText: fullHeader })
    await calibrate(withPositive, archiving)
    expect(archiving.ran.filter(k => /archive/.test(k))).toHaveLength(1)
  })

  // A supplied baseDir replaces the archive, so nothing else notices it is
  // missing: the gate would run against an empty cwd and report a BASE that
  // misses every line by absence — a perfect-looking calibration of nothing.
  it('refuses a caller-supplied baseDir that does not exist, before running anything', async () => {
    const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
    fake.exists = (p) => p !== 'C:/tmp/gone'
    const r = await calibrate(withPositive, fake, { baseDir: 'C:/tmp/gone' })
    expect(r).toEqual({ ok: false, problems: ['provided baseDir does not exist: C:/tmp/gone'] })
    expect(fake.ran).toEqual([])
  })

  // F155. A run that produced nothing measured nothing, and `compareCalibration`
  // cannot tell that from a gate whose every line passed at BASE: fed the empty
  // run bun's stale spawnSync deadline produced, it reported a null terminator,
  // "too few gate lines: 0 < 8" and one MUST-FAIL complaint per discriminator —
  // nine inventions about a triple that had two real problems.
  // Phase 4 residual: a problem names the instrument the fix belongs in.
  it('names the instrument file on every problem — the stub for a flipped discriminator, the header for a missing key', async () => {
    const perturbLog = baseLog.replace('C8.1b.tiers-differ: FAIL', 'C8.1b.tiers-differ: PASS').replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const r = await calibrate(spec, io({ perturbLog, baselineExists: true }))
    expect(r.problems.length).toBeGreaterThan(0)
    expect(r.problems.every(p => p.endsWith(' (perturb_c8.py)'))).toBe(true)
    const noHeader = await calibrate(spec, io({ perturbLog, baselineExists: true, headerText: 'import os\n' }))
    expect(noHeader.problems).toEqual(['perturb header is missing a "# EXPECT-FLIP:" line — the runner cannot calibrate what the stub did not declare (perturb_c8.py)'])
    expect(instrumentOf('BASE must MISS the gate; terminator was PASS')).toBe('gate')
    expect(instrumentOf('too few gate lines: 3 < 8')).toBe('gate')
    expect(instrumentOf('unclassified base fails: C8.1a')).toBe('perturb')
    expect(instrumentOf('C8.1a flipped to PASS under the cheat stub but was not declared in EXPECT-FLIP')).toBe('perturb')
    expect(instrumentOf('positive shim printed errors: 2')).toBe('positive')
  })

  describe('a run that produced nothing is a HARNESS FAULT, not a reading', () => {
    it('reports a `fault` on the BASE run as a fault and never compares', async () => {
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/gate_c8\.py/.test(k)) return { status: null, stdout: '', stderr: '', elapsedMs: 7, timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 7 } }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBe(true)
      expect(r.problems).toEqual(['harness fault: gate run at BASE did not run (code ETIMEDOUT, status null, after 7 ms) — nothing was graded (gate_c8.py)'])
      // Not one invented finding about the gate itself.
      expect(r.problems.join('\n')).not.toMatch(/MUST-FAIL|too few gate lines|must MISS/)
      expect(r.baseFails).toEqual([])
      expect(r.suiteBaselineCreated).toBe(false)
    })

    it('reports an empty BASE run with no terminator as a fault even without an error', async () => {
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/gate_c8\.py/.test(k)) return { status: 1, stdout: '', stderr: '', elapsedMs: 4, timedOut: false, fault: null }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBe(true)
      expect(r.problems).toEqual(['harness fault: gate run at BASE produced no output (status 1, after 4 ms) — nothing was graded (gate_c8.py)'])
    })

    it('names the positive shim as a fault rather than a shim that "did not PASS"', async () => {
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/positive_c8\.py/.test(k)) return { status: null, stdout: '', stderr: '', elapsedMs: 5, timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 5 } }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBe(true)
      expect(r.problems).toEqual(['harness fault: positive shim run did not run (code ETIMEDOUT, status null, after 5 ms) — nothing was graded (positive_c8.py)'])
      expect(r.problems.join('\n')).not.toMatch(/did not PASS/)
    })

    /**
     * "Produced no output" means no output on EITHER stream. A child that dies at
     * import writes a traceback to stderr and nothing to stdout, and that is the
     * child's failure — a model defect. Reading stdout alone blamed the harness
     * for it and, worse, dropped the traceback, so the resume brief had nothing
     * to show.
     */
    it('a shim that dies at import with a traceback on stderr is the SHIM failing, not the harness', async () => {
      const traceback = 'Traceback (most recent call last):\n  File "positive_c8.py", line 9\nModuleNotFoundError: No module named \'gilded.ui.views\'\n'
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/positive_c8\.py/.test(k)) return { status: 1, stdout: '', stderr: traceback, elapsedMs: 900, timedOut: false, fault: null }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBe(false)
      expect(r.problems.join('\n')).not.toMatch(/harness fault/)
      // Graded as it always was: a null terminator is a shim that did not PASS.
      expect(r.problems.join('\n')).toMatch(/positive shim did not PASS/)
      // And the traceback survives into the tail, which is what the resume reads.
      expect(r.positiveOutputTail).toContain("No module named 'gilded.ui.views'")
    })

    it('still calls a run with NOTHING on either stream a harness fault', async () => {
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/positive_c8\.py/.test(k)) return { status: 1, stdout: '', stderr: '   \n', elapsedMs: 4, timedOut: false, fault: null }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.harnessFault).toBe(true)
      expect(r.problems).toEqual(['harness fault: positive shim run produced no output (status 1, after 4 ms) — nothing was graded (positive_c8.py)'])
    })

    it('a REAL timeout is still a timeout, not a fault', async () => {
      const fake = io({ perturbLog: baseLog, baselineExists: true, headerText: fullHeader })
      const inner = fake.run
      fake.run = (cmd, args, opts) => {
        const k = [cmd, ...args].join(' ')
        if (/gate_c8\.py/.test(k)) return { status: null, stdout: '', stderr: '', elapsedMs: 7_200_000, timedOut: true, fault: null }
        return inner(cmd, args, opts)
      }
      const r = await calibrate(withPositive, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBeFalsy()
      expect(r.problems.join('\n')).toMatch(/gate timed out after 7200000 ms at BASE/)
    })
  })

  it('refuses when git archive of the BASE fails', async () => {
    const fake = io({ perturbLog: baseLog, baselineExists: true })
    fake.run = (cmd, args) => {
      const k = [cmd, ...args].join(' ')
      if (/archive/.test(k)) return { status: 128, stdout: '', stderr: 'fatal: not a valid object name\n' }
      throw new Error('unscripted ' + k)
    }
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/git archive 1d03308 failed: fatal: not a valid object name/)
  })
})

// F242 (01-isolation 7.3, tests 9.7).
describe('calibrate runs contained, and a baseline run that did not complete writes no baseline', () => {
  const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
  /** io() with the pytest baseline run answered by `pytestResult`, and every call's options kept. */
  const withBaseline = (pytestResult) => {
    const fake = io({ perturbLog, baselineExists: false, headerText: fullHeader })
    const inner = fake.run
    fake.opts = []
    fake.run = (cmd, args, opts) => {
      fake.opts.push({ k: [cmd, ...args].join(' '), opts })
      if (/pytest/.test([cmd, ...args].join(' '))) return pytestResult
      return inner(cmd, args, opts)
    }
    return fake
  }

  it('the gate, perturb, positive and baseline runs each run in a grader containment around the BASE folder; the archive does not', async () => {
    const fake = withBaseline({ status: 0, stdout: '100 passed\n', stderr: '' })
    const r = await calibrate(withPositive, fake)
    expect(r.ok).toBe(true)
    const contained = fake.opts.filter(o => o.opts?.contained)
    expect(contained.map(o => o.k.split(' ')[1].split('/').pop())).toEqual(['gate_c8.py', 'perturb_c8.py', 'positive_c8.py', '-m'])
    for (const o of contained) expect(o.opts.contained).toEqual({ own: 'C:/tmp/c8_base' })
    const archive = fake.opts.find(o => /archive/.test(o.k))
    expect(archive.opts.contained).toBeUndefined()
    // The archive's git runs with the harness-git environment: the keys alone, for runSync to merge.
    expect(archive.opts.env.GIT_CONFIG_COUNT).toBeDefined()
    expect(archive.opts.env.PATH).toBeUndefined()
  })

  it('a baseline run that faulted: ok false, the problem named, no baseline written', async () => {
    const fake = withBaseline({ status: null, stdout: '', stderr: '[spawn] REFUSED: containment: x — nothing was run', fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 } })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.harnessFault).toBe(true)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(r.problems).toEqual(['suite baseline run did not complete (code ECONTAINMENT, status null, after 0 ms)'])
    expect(fake.writes).toEqual([])
  })

  it('a baseline run that timed out: the same, naming the cap', async () => {
    const fake = withBaseline({ status: null, stdout: 'FAILED gilded/tests/a.py::t1 - x\n', stderr: '', timedOut: true, fault: null })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.harnessFault).toBe(true)
    expect(r.problems).toEqual([`suite baseline run did not complete (timed out after ${SUITE_TIMEOUT_MS} ms)`])
    expect(fake.writes).toEqual([])
  })

  // Review finding of slice S2: pytest ran but measured nothing (2: interrupted or a collection
  // error; 3, 4, 5). Its empty FAILED list would read as "no standing failures".
  it('a baseline run whose pytest exit is not 0 or 1: the same, naming the exit', async () => {
    for (const status of [2, 3, 4, 5]) {
      const fake = withBaseline({ status, stdout: 'ERROR collecting gilded/tests/a.py\n', stderr: '', timedOut: false, fault: null })
      const r = await calibrate(spec, fake)
      expect(r.ok).toBe(false)
      expect(r.harnessFault).toBe(true)
      expect(r.suiteBaselineCreated).toBe(false)
      expect(r.problems).toEqual([`suite baseline run did not complete (pytest exit ${status})`])
      expect(fake.writes).toEqual([])
    }
    const failing = withBaseline({ status: 1, stdout: 'FAILED gilded/tests/a.py::t1 - x\n', stderr: '', timedOut: false, fault: null })
    const r1 = await calibrate(spec, failing)
    expect(r1.suiteBaselineCreated).toBe(true)
    expect(failing.writes.length).toBe(1)
  })
})
