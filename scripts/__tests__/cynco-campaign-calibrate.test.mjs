import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { ownIntegrityLevel } from '../../engine/containment.js'
import { basename, dirname, join } from 'node:path'
import { calibrate, instrumentOf, archiveBase, defaultIo, removeNoFollow } from '../cynco-campaign-calibrate.mjs'
import { listEntries } from '../../engine/realPath.js'
import { removeLinkEntry } from '../../engine/__tests__/helpers/linkEntry.js'
import { SUITE_TIMEOUT_MS } from '../cynco-campaign-grade.mjs'

const baseLog = readFileSync(new URL('./fixtures/gate_c8_base.log', import.meta.url), 'utf8')
const spec = { id: 'c8', repo: 'C:/repo', base: '1d03308', gate: 'C:/h/gate_c8.py', perturb: 'C:/h/perturb_c8.py', suiteBaseline: 'C:/h/suite_baseline_1d03308.txt' }
// The real c8 header also declares C8.5.river-reserved, a line that PASSes at BASE in this log: since the
// EXPECT-FLIP check of wave 15 that is a problem of its own (compareCalibration), so the fixture declares
// the one line the stub really flips. The refusal of the real header is pinned below.
const header = '# EXPECT-FLIP: C8.5.palette.Atlas\n# MUST-FAIL: C8.1b C8.1c C8.2b\nimport os\n'
const c8RealHeader = '# EXPECT-FLIP: C8.5.palette.Atlas C8.5.river-reserved\n# MUST-FAIL: C8.1b C8.1c C8.2b\nimport os\n'

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

  // The c8 header as it is on disk declares a flip of C8.5.river-reserved, which PASSes at BASE: refused now,
  // in the perturb's name, and no baseline is written.
  it('refuses the real c8 header, whose EXPECT-FLIP names a line already PASSing at BASE, in the stub\'s name', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: false, headerText: c8RealHeader })
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['EXPECT-FLIP C8.5.river-reserved names only lines that already PASS at BASE (C8.5.river-reserved), so the cheat stub cannot flip it (perturb_c8.py)'])
    expect(fake.writes).toHaveLength(0)
  })

  // R3-F2 (wave 12): the runner's --dry-run takes the reading and writes nothing, the suite baseline included.
  it('dryRun takes the reading and neither runs nor writes the suite baseline, and says one was due', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const fake = io({ perturbLog, baselineExists: false })
    fake.frozenWriteRefusal = () => { throw new Error('a dry run must not ask whether it may write') }
    const r = await calibrate(spec, fake, { dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.baseFails).toHaveLength(14)
    expect(r.suiteBaselineCreated).toBe(false)
    expect(r.suiteBaselineSkipped).toBe(true)
    expect(fake.writes).toEqual([])
    expect(fake.ran.filter(k => /pytest/.test(k))).toEqual([])
    // A baseline that exists already is not "due": nothing to say.
    const again = await calibrate(spec, io({ perturbLog, baselineExists: true }), { dryRun: true })
    expect(again.suiteBaselineSkipped).toBeUndefined()
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
    expect(instrumentOf('EXPECT-FLIP C8.5.river-reserved names only lines that already PASS at BASE (C8.5.river-reserved), so the cheat stub cannot flip it')).toBe('perturb')
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

// F242, slice S7, entry 4.M5: the suite baseline lands in the held-out folder, FROZEN while a run is open.
describe('calibrate while an integrity baseline is open', () => {
  it('no pytest run, no write, ok false, and the problem says why', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    const why = 'a mission or daemon task is running (r1); this would change a protected folder and stop it. Try again when it has ended.'
    const fake = { ...io({ perturbLog, baselineExists: false }), frozenWriteRefusal: () => why }
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([`suite baseline not written: ${why}`])
    expect(r.suiteBaselineCreated).toBe(false)
    expect(fake.writes).toEqual([])
    expect(fake.ran.some(k => k.includes('pytest'))).toBe(false)
  })

  it('an existing suite baseline is not a write, so an open baseline does not refuse calibration', async () => {
    const perturbLog = baseLog.replace('C8.5.palette.Atlas: FAIL', 'C8.5.palette.Atlas: PASS')
    let asked = 0
    const fake = { ...io({ perturbLog, baselineExists: true }), frozenWriteRefusal: () => { asked++; return 'running' } }
    const r = await calibrate(spec, fake)
    expect(r.ok).toBe(true)
    expect(asked).toBe(0)
  })
})

// B5-5 (wave 15c): the BASE folder (default C:/tmp/<id>_base) is where a contained grader ran at low integrity
// (`contained: { own: baseDir }`), so it may hold a junction that low process made, which lstat reads as a folder
// (decision record F4). freshDir empties it by the listing-based walk that never enters a link, as the sandbox
// sweep does, never by fs.rmSync (whose not entering one is the runtime's choice: F5), and refuses by name a link
// it cannot remove as an entry. Everything here is under a folder of this file's own, removed at the end.
describe('freshDir: the BASE folder is emptied without ever entering a link', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'cynco-freshdir-test-'))
  const links = []
  afterAll(() => {
    // Links first, as entries (a case that failed half way may leave one), then this file's own folder.
    const linksUnder = (d, out = []) => {
      for (const e of listEntries(d)) {
        if (e.kind === 'link') out.push(join(d, e.name))
        else if (e.kind === 'dir') linksUnder(join(d, e.name), out)
      }
      return out
    }
    // Wave 19: a link whose folder a passing case removed with it is gone, not a link that could not be removed;
    // asking its parent's listing threw ENOENT there and printed a false 'could not be removed' line.
    const entryThere = (l) => { try { return readdirSync(dirname(l)).includes(basename(l)) } catch { return false } }
    for (const l of [...links, ...linksUnder(ROOT)]) {
      if (!entryThere(l)) continue
      try { removeLinkEntry(l) } catch (e) { console.error(`[test] the link ${l} could not be removed as an entry: ${e.message}`) }
    }
    const left = linksUnder(ROOT)
    if (left.length > 0) throw new Error(`links are left under ${ROOT}, so it is not removed: ${left.join(', ')}`)
    rmSync(ROOT, { recursive: true, force: true })
  })
  /** A BASE folder with a nested tree, a read-only file and a junction to an outside folder holding the owner's file. */
  const baseWithJunction = () => {
    const t = mkdtempSync(join(ROOT, 't-'))
    const outside = join(t, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the owner\'s file')
    const base = join(t, 'c8_base')
    mkdirSync(join(base, 'gilded', 'tests'), { recursive: true })
    writeFileSync(join(base, 'gilded', 'tests', 'a.py'), 'x')
    const ro = join(base, 'gilded', 'pack.idx')
    writeFileSync(ro, 'z')
    chmodSync(ro, 0o444)
    const junction = join(base, 'gilded', 'to-outside')
    symlinkSync(outside, junction, 'junction')
    links.push(junction)
    return { t, base, outside, junction }
  }

  it('empties the folder and makes it again; a junction in it is removed as an entry and the file it points at stays', () => {
    const { base, outside } = baseWithJunction()
    defaultIo.freshDir(base)
    expect(existsSync(base)).toBe(true)
    expect(readdirSync(base)).toEqual([])
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
  })

  // The hazard itself: a junction made by a LOW-integrity process, stored with the substitute name
  // \??\Global\..., for which lstat answers with the target's stat. A walk that asked lstat would enter it.
  // Skipped by name where a low copy of cmd.exe cannot be made (off Windows, in a process already low, no USERNAME).
  const SYS = (n) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', n)
  const sh = (file, args, o = {}) => {
    const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: o.verbatim, cwd: o.cwd, timeout: 60_000 })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? ` (${r.error.message})` : ''}` }
  }
  const icaclsOk = (args) => {
    const r = sh(SYS('icacls.exe'), args)
    if (r.code !== 0) throw new Error(`icacls ${args.join(' ')} failed (${r.code}): ${r.out.trim().slice(0, 300)}`)
  }
  const cannotMakeLow = process.platform !== 'win32' || ownIntegrityLevel() === 'low' || !process.env.USERNAME
  it.skipIf(cannotMakeLow)('Windows: a junction a LOW-integrity process made in the BASE folder is removed as an entry, its target\'s file stays (skipped off Windows, in a process already low, or with USERNAME unset)', () => {
    const user = process.env.USERNAME
    const t = mkdtempSync(join(ROOT, 'low-'))
    const lowCmd = join(t, 'lowcmd.exe')
    copyFileSync(SYS('cmd.exe'), lowCmd)
    icaclsOk([lowCmd, '/grant', `${user}:(F)`])
    icaclsOk([lowCmd, '/setintegritylevel', 'low'])
    expect(sh(lowCmd, ['/d', '/c', `${SYS('whoami.exe')} /groups`]).out, 'the copy of cmd.exe runs at low integrity (S-1-16-4096)').toMatch(/S-1-16-4096/)
    const base = join(t, 'c8_base')
    const outside = join(t, 'outside')
    mkdirSync(base)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the file the junction points at')
    for (const d of [base, outside]) {
      icaclsOk([d, '/grant', `${user}:(OI)(CI)(F)`])
      icaclsOk([d, '/setintegritylevel', '(OI)(CI)low'])
    }
    const junction = join(base, 'gilded', 'to-outside')
    links.push(junction)
    const made = sh(lowCmd, [`/d /c mkdir gilded && mklink /J "${junction}" "${outside}"`], { verbatim: true, cwd: base })
    expect(made.code, `the low cmd made the junction: ${made.out.trim()}`).toBe(0)
    expect(listEntries(join(base, 'gilded'))).toEqual([{ name: 'to-outside', kind: 'link' }])
    console.log(`[test] lstat of the low-made junction: isSymbolicLink ${lstatSync(junction).isSymbolicLink()}, isDirectory ${lstatSync(junction).isDirectory()}`)
    defaultIo.freshDir(base)
    expect(readdirSync(base)).toEqual([])
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the file the junction points at')
  })

  it('a folder that is not there is made; the BASE folder itself a junction is removed as an entry, its target untouched', () => {
    const t = mkdtempSync(join(ROOT, 't-'))
    const absent = join(t, 'c9_base')
    defaultIo.freshDir(absent)
    expect(readdirSync(absent)).toEqual([])
    const target = join(t, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'k')
    const asLink = join(t, 'c10_base')
    symlinkSync(target, asLink, 'junction')
    links.push(asLink)
    defaultIo.freshDir(asLink)
    expect(listEntries(t).find(e => e.name === 'c10_base')).toEqual({ name: 'c10_base', kind: 'dir' })
    expect(readdirSync(asLink)).toEqual([])
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('k')
  })

  it('an entry the listing calls a folder but that resolves elsewhere is refused by name and not entered', () => {
    const { base, outside, junction } = baseWithJunction()
    const lying = (d) => listEntries(d).map(e => (e.name === 'to-outside' ? { ...e, kind: 'dir' } : e))
    expect(() => removeNoFollow(base, lying)).toThrow(/to-outside resolves to .*outside, not to .*to-outside; it was not entered and nothing beneath it was removed/)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
    expect(listEntries(dirname(junction)).find(e => e.name === 'to-outside')?.kind).toBe('link')
  })

  it('a link it cannot remove as an entry is refused by name, nothing beneath it is removed', () => {
    const t = mkdtempSync(join(ROOT, 't-'))
    const base = join(t, 'c8_base')
    mkdirSync(join(base, 'full'), { recursive: true })
    writeFileSync(join(base, 'full', 'keep.txt'), 'k')
    // A listing that calls a folder with a file in it a link: rmdir answers ENOTEMPTY and unlink refuses a folder.
    const lying = (d) => listEntries(d).map(e => (e.name === 'full' ? { ...e, kind: 'link' } : e))
    expect(() => removeNoFollow(base, lying)).toThrow(/full is a link that could not be removed as an entry \(rmdir answered ENOTEMPTY, unlink answered [A-Z]+\); nothing beneath it was entered/)
    expect(readFileSync(join(base, 'full', 'keep.txt'), 'utf8')).toBe('k')
  })

  it('archiveBase: a BASE folder that cannot be emptied is a named problem and nothing is archived', () => {
    const ran = []
    const r = archiveBase('C:/repo', '1d03308', 'C:/tmp/c8_base', {
      freshDir: () => { throw new Error('C:/tmp/c8_base\\x is a link that could not be removed as an entry (rmdir answered EPERM, unlink answered EPERM); nothing beneath it was entered') },
      run: (cmd, args) => { ran.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } },
    })
    expect(r).toEqual({ ok: false, problems: ['the BASE folder C:/tmp/c8_base could not be emptied, so nothing was archived: C:/tmp/c8_base\\x is a link that could not be removed as an entry (rmdir answered EPERM, unlink answered EPERM); nothing beneath it was entered'] })
    expect(ran).toEqual([])
  })

  it('cynco-campaign-calibrate.mjs calls no recursive remove: no rmSync, no rm, no rimraf, no shell delete in its code', () => {
    const text = readFileSync(new URL('../cynco-campaign-calibrate.mjs', import.meta.url), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).toContain('rmdirSync(')
    expect(code).not.toMatch(/\brmSync\b/)
    expect(code).not.toMatch(/\brm\s*\(|[{,]\s*rm\s*[,}]|\.rm\b|\brm -r|\brd \/s|Remove-Item|rimraf/)
  })
})
