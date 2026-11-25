/**
 * Decision sheet item 25 (the owner, 2026-11-24: "Driver runs outside box"): the gate-authoring check
 * cannot start inside the box (a Bun at low integrity cannot load a module from a folder not labelled
 * low), so the authoring dispatch carries one mark and its driver runs the check itself, as a harness
 * process. These are the pure halves the driver calls (`scripts/cynco-mission-driver.mjs` cannot be
 * imported: it runs a mission when loaded; its call sites are pinned in
 * `engine/__tests__/guards/containmentWiring.test.ts`).
 */
import { describe, it, expect } from 'vitest'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SELF_SCRIPT, AUTHOR_CHECK_MARK, CHECK_JSON_MARKER, BASELINE_OWED, checkCommand, parseCheckCommand, authorCheckPlan, runAuthorCheck, authorRunOpts,
} from '../cynco-gate-author.mjs'
import { waveDispatch } from '../cynco-campaign.mjs'
import { toolEnv, testContainment } from '../../engine/containment.js'

// Wave 19b (check A-F2): the paths are absolute on the host that runs the suite (the Linux CI too), so the parse
// that asks node:path's isAbsolute reads them as the driver's own host would. Read from isAbsolute itself, not from
// the platform's name, so the same file also runs under a POSIX path module.
const ROOT = isAbsolute('C:/x') ? 'C:/' : '/'
const STAGING = `${ROOT}Users/x/.cynco/authoring/c9`
const BASE = `${ROOT}tmp/c9_author_base`
const CMD = checkCommand(STAGING, BASE)
const CHECKOUT = dirname(dirname(SELF_SCRIPT))
const OTHER_SCRIPT = `${ROOT}elsewhere/scripts/cynco-gate-author.mjs`

describe('parseCheckCommand: the exact inverse of checkCommand', () => {
  it('round-trips what checkCommand builds, spaces and other scripts included', () => {
    const rows = [[STAGING, BASE], [`${ROOT}a b/c9`, `${ROOT}tmp/c 9_author_base`]]
    if (ROOT === 'C:/') rows.push(['D:/w/c10', 'C:/tmp/c10_author_base'])
    for (const [s, b] of rows) {
      expect(parseCheckCommand(checkCommand(s, b))).toEqual({ stagingDir: s, baseDir: b })
    }
    expect(parseCheckCommand(checkCommand(STAGING, BASE, OTHER_SCRIPT), OTHER_SCRIPT)).toEqual({ stagingDir: STAGING, baseDir: BASE })
  })

  it('rejects every near miss: another script path, a third argument, a `;`, --json, a backslash spelling, a relative folder, extra spaces', () => {
    const near = [
      checkCommand(STAGING, BASE, OTHER_SCRIPT),
      `${CMD} "${ROOT}x"`,
      `${CMD}; rm -rf ~`,
      `${CMD} --json`,
      `${CMD}\n`,
      CMD.replace('--check', '--check '),
      CMD.replace('bun ', 'bun  '),
      CMD.replace(/^bun /, 'node '),
      `bun ${JSON.stringify(SELF_SCRIPT)} --check ${JSON.stringify(STAGING.replace(/\//g, '\\'))} ${JSON.stringify(BASE)}`,
      `bun ${JSON.stringify(SELF_SCRIPT)} --check ${JSON.stringify('authoring/c9')} ${JSON.stringify(BASE)}`,
      `bun ${JSON.stringify(SELF_SCRIPT)} --check ${JSON.stringify(STAGING)} ${JSON.stringify('')}`,
      `bun ${SELF_SCRIPT} --check ${STAGING} ${BASE}`,
      // Wave 19b (check A-R4): the script by a backslash spelling, or with a trailing slash, is not the form either.
      `bun ${JSON.stringify(SELF_SCRIPT.replace(/\//g, '\\'))} --check ${JSON.stringify(STAGING)} ${JSON.stringify(BASE)}`,
      `bun ${JSON.stringify(`${SELF_SCRIPT}/`)} --check ${JSON.stringify(STAGING)} ${JSON.stringify(BASE)}`,
      '', null, undefined,
    ]
    for (const c of near) expect(parseCheckCommand(c), String(c)).toBeNull()
  })

  it('A-R4: the script is this checkout\'s whatever the case of its drive letter on Windows (a runner started from c:\\ and a driver loaded through Git Bash name the same file); elsewhere the case counts', () => {
    if (process.platform === 'win32') {
      // Wave 19c (check CB-A-4): the other case of the drive letter, whichever case the module's own path holds (a
      // lower-case `c:` spelling of SELF_SCRIPT is the very situation A-R4 is about).
      const other = SELF_SCRIPT.replace(/^([A-Za-z]):/, (_, d) => `${d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()}:`)
      expect(other).not.toBe(SELF_SCRIPT)
      const cmd = checkCommand(STAGING, BASE, other)
      expect(parseCheckCommand(cmd)).toEqual({ stagingDir: STAGING, baseDir: BASE })
      expect(authorCheckPlan({ mark: '1', checkCmd: cmd, cwd: STAGING })).toEqual({ kind: 'run', stagingDir: STAGING, baseDir: BASE })
    } else {
      expect(parseCheckCommand(checkCommand(STAGING, BASE, SELF_SCRIPT.toUpperCase()))).toBeNull()
    }
  })
})

describe('authorCheckPlan: one explicit mark, set only by the gate-authoring script', () => {
  it('without the mark the check stays in the box, whatever the command', () => {
    for (const mark of [undefined, null, '']) expect(authorCheckPlan({ mark, checkCmd: CMD, cwd: STAGING })).toEqual({ kind: 'none' })
  })

  it('with the mark and the exact command for this mission folder, the driver runs this checkout\'s script for it', () => {
    expect(authorCheckPlan({ mark: '1', checkCmd: CMD, cwd: STAGING })).toEqual({ kind: 'run', stagingDir: STAGING, baseDir: BASE })
    expect(authorCheckPlan({ mark: '1', checkCmd: CMD, cwd: `${STAGING}/` }).kind).toBe('run')
  })

  it('with the mark, anything else is refused by name and nothing runs', () => {
    const cases = [
      [{ mark: '0', checkCmd: CMD, cwd: STAGING }, /is "0", not "1"/],
      [{ mark: 'yes', checkCmd: CMD, cwd: STAGING }, /is "yes", not "1"/],
      [{ mark: '1', checkCmd: 'python -m pytest -q', cwd: STAGING }, /not the one this checkout's cynco-gate-author\.mjs builds/],
      [{ mark: '1', checkCmd: `${CMD}; echo`, cwd: STAGING }, /not the one this checkout's/],
      [{ mark: '1', checkCmd: '', cwd: STAGING }, /not the one this checkout's/],
      [{ mark: '1', checkCmd: CMD, cwd: `${ROOT}Users/x/.cynco/authoring/c10` }, `for another mission folder (${STAGING}, not ${ROOT}Users/x/.cynco/authoring/c10)`],
      [{ mark: '1', checkCmd: CMD, cwd: STAGING, markerCheck: 'python gate.py' }, /marker check on its own channel/],
      [{ mark: '1', checkCmd: CMD, cwd: STAGING, probeCmd: 'pytest -q' }, /probe command/],
    ]
    for (const [input, why] of cases) {
      const p = authorCheckPlan(input)
      expect(p.kind, JSON.stringify(input)).toBe('refused')
      expect(p.why).toMatch(/^the authoring dispatch's mark \(LOCALCODE_MISSION_AUTHOR_CHECK\) /)
      if (typeof why === 'string') expect(p.why).toContain(why)
      else expect(p.why).toMatch(why)
      expect(p.why).toMatch(/so nothing is run outside the box$/)
    }
  })

  it('the mark is a LOCALCODE_MISSION_ key, which every tool child drops (toolEnv) and the dispatch takes out of its own environment', () => {
    expect(AUTHOR_CHECK_MARK).toBe('LOCALCODE_MISSION_AUTHOR_CHECK')
    // Wave 19b (check A-R8): the drop itself, with no run context and with one (nothing on disk is made).
    const root = join(tmpdir(), 'cynco-w19b-a-r8-never-made')
    const ctx = testContainment({
      missionCwd: join(root, 'mission'),
      sandbox: { root: join(root, 'run'), home: join(root, 'run', 'home'), tmp: join(root, 'run', 'tmp'), scratch: join(root, 'run', 'scratch') },
      home: join(root, 'home'), folders: { state: join(root, 'state'), models: join(root, 'models'), guard: join(root, 'guard'), audit: join(root, 'audit') },
    })
    for (const c of [null, ctx]) {
      const env = toolEnv({ PATH: process.env.PATH ?? '', [AUTHOR_CHECK_MARK]: '1', KEPT_FOR_THE_CHILD: 'x' }, c)
      expect(env[AUTHOR_CHECK_MARK], c ? 'with a run context' : 'without one').toBeUndefined()
      expect(env.KEPT_FOR_THE_CHILD).toBe('x')
    }
  })

  // Wave 19b (check A-F4): the runner's own environment and the campaign spec's `env` may both hold the mark; the wave
  // dispatch removes it after its environment is built (package G's waveDispatch), so the driver never refuses a wave.
  it('a wave dispatch never carries the mark, even when the runner\'s own environment and the spec\'s env hold it', () => {
    const spec = { id: 'c9', marker: 'c9', repo: `${ROOT}r`, keepGreen: 'pytest -q', markerCheck: 'python g.py', budget: { iterations: 1, bashTimeoutMs: 1 }, env: { [AUTHOR_CHECK_MARK]: '1' } }
    const d = waveDispatch(spec, { briefFile: 'b.txt', invariants: {}, timeoutS: 1, pidFile: 'p', driverLog: 'd' }, { PATH: 'p', [AUTHOR_CHECK_MARK]: '1' })
    expect(d.env[AUTHOR_CHECK_MARK]).toBeUndefined()
    const plain = waveDispatch({ ...spec, env: undefined }, { briefFile: 'b.txt', invariants: {}, timeoutS: 1, pidFile: 'p', driverLog: 'd' }, {})
    expect(plain.env[AUTHOR_CHECK_MARK]).toBeUndefined()
  })
})

/** A stand-in for execFile and the tree: records the start, answers as told. */
function stand({ code = 0, stdout = '', stderr = '', hang = false } = {}) {
  const calls = { starts: [], owned: [], killed: 0, released: 0 }
  let answer = null
  const execFile = (file, args, opts, cb) => {
    calls.starts.push({ file, args, opts })
    answer = cb
    if (!hang) setTimeout(() => cb(code === 0 ? null : Object.assign(new Error('exit'), { code }), stdout, stderr), 5)
    return { pid: 4242 }
  }
  const own = (pid) => {
    calls.owned.push(pid)
    return { kind: 'job', kill: async () => { calls.killed++; setTimeout(() => answer?.(Object.assign(new Error('killed'), { killed: true, code: null }), '', ''), 1) }, release: () => { calls.released++ } }
  }
  return { calls, hooks: { execFile, own, bun: 'C:/bin/bun.exe', graceMs: 50 } }
}

/** What the `--check` CLI prints with `--json` (authorMain): its headline, its problems, and the verdict line last on stdout. */
const PASS_OUT = { stdout: `[check] c9: PASS — 11 graded lines, BASE MISS, cheat stub honest, positive shim PASS\n${CHECK_JSON_MARKER}${JSON.stringify({ ok: true, problems: [], at: [], lineIds: ['C9.1'], tails: { base: 'x' } })}\n` }
const refusedOut = (problems) => ({
  stdout: `${CHECK_JSON_MARKER}${JSON.stringify({ ok: false, problems, at: [], lineIds: [], tails: { base: 'tail' } })}\n`,
  stderr: `[check] c9: REFUSED — ${problems.length} problem(s)\n${problems.map(p => `  ${p}\n`).join('')}`,
})
const FROZEN = 'suite baseline not written: a mission or daemon task is running (m-1); this would change a protected folder and stop it. Try again when it has ended. If nothing is running, that run died before its compare: bun scripts/cynco-guard.mjs post m-1'

describe('runAuthorCheck: the driver\'s own run of the check, a harness process', () => {
  const base = { stagingDir: STAGING, baseDir: BASE, timeoutMs: 60_000 }

  // Changed on purpose in wave 19b (checks A-F1 and A-R5): the check is asked for its --json verdict.
  it('starts this checkout\'s script by argument vector, no shell, with --no-install, from the checkout, without the mark, its tree owned at start', async () => {
    process.env[AUTHOR_CHECK_MARK] = '1'
    try {
      const { calls, hooks } = stand({ code: 0, ...PASS_OUT })
      const r = await runAuthorCheck({ ...base, ordinal: 2 }, hooks)
      expect(calls.starts).toHaveLength(1)
      const s = calls.starts[0]
      expect(s.file).toBe('C:/bin/bun.exe')
      expect(s.args).toEqual(['--no-install', SELF_SCRIPT, '--check', STAGING, BASE, '--json'])
      expect(s.opts.shell).toBe(false)
      expect(s.opts.cwd).toBe(CHECKOUT)
      expect(s.opts.env[AUTHOR_CHECK_MARK]).toBeUndefined()
      expect(s.opts.env.CYNCO_CHECK_ORDINAL).toBe('2')
      expect(calls.owned).toEqual([4242])
      expect(calls.released).toBe(1)
      expect(r).toMatchObject({ verified: true, exitCode: 0, harnessFault: null, timedOut: false, spawnFailed: false, integrity: null })
      expect(r.output).toContain('[check] c9: PASS')
      // The verdict line (with its tails) is the runner's, never a note's: it is not kept in the output.
      expect(r.output).not.toContain(CHECK_JSON_MARKER)
    } finally { delete process.env[AUTHOR_CHECK_MARK] }
  })

  it('exit 1 is the check\'s REFUSED (a failed check); exit 2 and any other code are a harness fault, never a verdict', async () => {
    const failed = await runAuthorCheck(base, stand({ code: 1, ...refusedOut(['missing: gate_c9.py was never written into the staging dir']) }).hooks)
    expect(failed).toMatchObject({ verified: false, exitCode: 1, harnessFault: null, baselineOwed: false })
    expect(failed.output).toContain('  missing: gate_c9.py was never written into the staging dir')
    expect(failed.output).not.toContain(CHECK_JSON_MARKER)
    expect(await runAuthorCheck(base, stand({ code: 2 }).hooks)).toMatchObject({ verified: null, exitCode: 2, harnessFault: 'the check refused its own arguments (exit 2)' })
    expect(await runAuthorCheck(base, stand({ code: 9 }).hooks)).toMatchObject({ verified: null, exitCode: 9 })
  })

  it('A-R5: exit 0 or 1 counts only with the check\'s own headline and a verdict line that agrees; a tree ended from outside (exit 1, nothing said) did not run', async () => {
    const cases = [
      ['exit 1, nothing printed (a tree ended from outside)', { code: 1 }],
      ['exit 1, a crash\'s stack', { code: 1, stderr: 'TypeError: x is not a function\n    at checkStaged' }],
      ['exit 1, the headline without a verdict line', { code: 1, stderr: '[check] c9: REFUSED — 1 problem(s)\n' }],
      ['exit 0, the headline without a verdict line', { code: 0, stdout: '[check] c9: PASS — 11 graded lines\n' }],
      ['exit 0, a verdict line that says not ok', { code: 0, stdout: `[check] c9: PASS\n${CHECK_JSON_MARKER}{"ok":false,"problems":["x"]}\n` }],
      ['exit 1, another staging folder\'s headline', { code: 1, ...refusedOut(['x']), stderr: '[check] c10: REFUSED — 1 problem(s)\n' }],
      ['exit 1, the headline inside a line', { code: 1, ...refusedOut(['x']), stderr: 'a [check] c9: REFUSED — 1 problem(s)\n' }],
      ['exit 1, a verdict line that does not read', { code: 1, stdout: `${CHECK_JSON_MARKER}{"ok":false,\n`, stderr: '[check] c9: REFUSED — 1 problem(s)\n' }],
    ]
    for (const [what, out] of cases) {
      const r = await runAuthorCheck(base, stand(out).hooks)
      expect(r.verified, what).toBeNull()
      expect(r.harnessFault, what).toMatch(/^the check ended with exit [01] without its verdict \(its "\[check\] <id>: (PASS|REFUSED)" line and a \[check-json\] line that agrees\), so it is not read as (passed|failed)$/)
      expect(r.output, what).toContain('[check] HARNESS FAULT: the check ended with exit')
    }
  })

  it('A-F1: a check whose only problem is the frozen suite baseline is no failure: verified null, owed to the runner\'s check, never a note; with any other problem beside it, it is a failure', async () => {
    const owed = await runAuthorCheck(base, stand({ code: 1, ...refusedOut([FROZEN]) }).hooks)
    expect(owed).toMatchObject({ verified: null, exitCode: 1, harnessFault: BASELINE_OWED, baselineOwed: true, integrity: null })
    expect(owed.harnessFault).toMatch(/^not a failure: the triple passed its lint and every gate run; /)
    expect(owed.harnessFault).toMatch(/Still owed: the authoring runner's check after the run, once the run has settled, takes the suite baseline and gives the verdict$/)
    expect(owed.output).toContain(`[check] HARNESS FAULT: ${BASELINE_OWED}`)
    const mixed = await runAuthorCheck(base, stand({ code: 1, ...refusedOut([FROZEN, 'BASE must MISS the gate; terminator was PASS (gate_c9.py)']) }).hooks)
    expect(mixed).toMatchObject({ verified: false, harnessFault: null, baselineOwed: false })
    // Wave 19c (check CB-A-6): a REFUSED with an empty problem list is a failure, never owed (every problem of none is
    // not "every problem is the frozen baseline").
    const empty = await runAuthorCheck(base, stand({ code: 1, ...refusedOut([]) }).hooks)
    expect(empty).toMatchObject({ verified: false, exitCode: 1, harnessFault: null, baselineOwed: false })
  })

  it('A-R7: a latch that throws is a guard that cannot be asked: before the start nothing starts, while it runs its tree is ended; never an uncaught throw', async () => {
    const thrower = () => { throw new Error('EACCES reading HALT.json') }
    const s1 = stand()
    const before = await runAuthorCheck({ ...base, latch: thrower }, s1.hooks)
    expect(s1.calls.starts).toEqual([])
    expect(before.integrity).toEqual({ state: 'unusable', summary: 'the latch could not be asked (EACCES reading HALT.json)' })
    expect(before.harnessFault).toMatch(/^the integrity guard became unusable \(the latch could not be asked \(EACCES reading HALT\.json\)\) before the check started/)
    const s2 = stand({ hang: true })
    let asked = 0
    const r = await runAuthorCheck({ ...base, latch: () => { if (++asked > 1) thrower(); return { state: 'clear' } } }, { ...s2.hooks, pollMs: 10 })
    expect(s2.calls.killed).toBe(1)
    expect(r.verified).toBeNull()
    expect(r.integrity).toMatchObject({ state: 'unusable' })
  })

  it('a latch, or a guard folder that cannot be used, before the start: nothing is started, and it reads "did not run"', async () => {
    for (const state of [{ state: 'latched', summary: 'HALT' }, { state: 'unusable', summary: 'no folder' }]) {
      const { calls, hooks } = stand()
      const r = await runAuthorCheck({ ...base, latch: () => state }, hooks)
      expect(calls.starts).toEqual([])
      expect(r.verified).toBeNull()
      expect(r.integrity).toEqual(state)
      expect(r.harnessFault).toMatch(state.state === 'unusable' ? /^the integrity guard became unusable \(no folder\) before the check started/ : /^the integrity latch was set \(HALT\) before the check started/)
    }
  })

  it('a latch set while it runs ends its tree; the check reads "did not run", never failed or passed', async () => {
    const { calls, hooks } = stand({ hang: true })
    let latched = null
    setTimeout(() => { latched = { state: 'latched', summary: 'HALT' } }, 30)
    const r = await runAuthorCheck({ ...base, latch: () => latched }, { ...hooks, pollMs: 10 })
    expect(calls.killed).toBe(1)
    expect(r.verified).toBeNull()
    expect(r.integrity).toEqual({ state: 'latched', summary: 'HALT' })
    expect(r.harnessFault).toMatch(/^the integrity latch was set \(HALT\) while the check ran: its process tree was ended/)
  })

  // Wave 19c (check CB-A-2): the poll saw the latch in the same window in which the check ended by itself, so its tree
  // was not ended: the result still carries the latch (the driver's cuts end the mission on it, landed or not), and the
  // check's own reading is kept, since it did run to its end.
  it('CB-A-2: a latch the poll saw while the check ended by itself is carried, with the check\'s own reading', async () => {
    const LATCHED = { state: 'latched', summary: 'HALT' }
    let asks = 0
    const ownedExec = (_start, o) => new Promise(res => o.signal.addEventListener('abort', () => res({ err: null, stdout: PASS_OUT.stdout, stderr: '', timedOut: false, stopped: false, overran: false }), { once: true }))
    const r = await runAuthorCheck({ ...base, latch: () => (++asks > 1 ? LATCHED : null) }, { ...stand().hooks, ownedExec, pollMs: 10 })
    expect(r).toMatchObject({ verified: true, exitCode: 0, harnessFault: null, integrity: LATCHED })
  })

  it('the cap ends its tree and reads "did not run"', async () => {
    const { calls, hooks } = stand({ hang: true })
    const r = await runAuthorCheck({ ...base, timeoutMs: 20 }, hooks)
    expect(calls.killed).toBe(1)
    expect(r).toMatchObject({ verified: null, timedOut: true, harnessFault: 'timed out after 20ms' })
  })

  it('records its start before it starts, and a start that cannot be written starts nothing', async () => {
    const recs = []
    const handle = { start: (rec) => { recs.push(['start', rec]); return { ok: true, call: 7 } }, end: (call, rec) => recs.push(['end', call, rec.exitCode]) }
    const { hooks } = stand({ code: 0, ...PASS_OUT })
    await runAuthorCheck({ ...base, audit: { handle, src: 'driver-marker' } }, hooks)
    expect(recs[0][0]).toBe('start')
    expect(recs[0][1].src).toBe('driver-marker')
    // Changed on purpose in wave 19b (check A-F1): the check is asked for its --json verdict.
    expect(recs[0][1].command).toBe(['C:/bin/bun.exe', '--no-install', SELF_SCRIPT, '--check', STAGING, BASE, '--json'].join(' '))
    expect(recs[1]).toEqual(['end', 7, 0])
    const refusing = { start: () => ({ ok: false, reason: 'audit-dir-missing' }), end: () => { throw new Error('no end without a start') } }
    const s2 = stand()
    const r = await runAuthorCheck({ ...base, audit: { handle: refusing, src: 'driver-marker' } }, s2.hooks)
    expect(s2.calls.starts).toEqual([])
    expect(r).toMatchObject({ verified: null, harnessFault: '[tool-audit] not run: audit-dir-missing' })
  })

  it('outside Bun it starts nothing', async () => {
    const { calls, hooks } = stand()
    const r = await runAuthorCheck(base, { ...hooks, bun: null })
    expect(calls.starts).toEqual([])
    expect(r.verified).toBeNull()
  })
})

describe('authorRunOpts: the check\'s gate runs are recorded (plan P6 item 7)', () => {
  it('a contained run gets the audit with src gate and its own run id; any other run is left alone', () => {
    const o = authorRunOpts({ contained: { own: 'C:/tmp/b' }, timeoutMs: 5 })
    expect(o.audit.src).toBe('gate')
    expect(typeof o.audit.forRun).toBe('function')
    expect(o.timeoutMs).toBe(5)
    const plain = { timeoutMs: 5 }
    expect(authorRunOpts(plain)).toBe(plain)
  })
})
