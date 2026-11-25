// F155. The two readings that must never be confused: a run that spent the cap,
// and a run the harness failed to make. `spawnSync` reports both as
// `error.code === 'ETIMEDOUT'` under bun on Windows, because its timeout
// deadline is measured from the PREVIOUS spawn in the same process — the
// reviewer's reproduction, one process: warmup 36 ms normal, then after a 12 s
// gap a spawn killed in 7 ms with ETIMEDOUT and empty output, then the two
// spawns behind it normal. The live C9 authoring runner's previous spawn was
// four hours earlier, so its gate at BASE died in milliseconds and eleven
// problems were recorded against a triple that had two.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { runSync, runAsync, faultSummary, TIMEOUT_ELAPSED_FRACTION, bashBin, gitExeOnPath, bashExe, instrumentEnv } from '../cynco-spawn.mjs'
import { testContainment } from '../../engine/containment.js'
import { runCheck, runCheckAsync } from '../cynco-verify.mjs'

/** A spawnSync stand-in: returns `result`, and advances the injected clock by `ms`. */
const fakeSpawn = (result, ms, clock) => (...args) => { clock.t += ms; return { ...result, _args: args } }

const clockOf = () => ({ t: 1_000_000 })

const ETIMEDOUT = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }

describe('runSync: a timeout is an elapsed measurement', () => {
  it('calls an early ETIMEDOUT a harness fault, not a timeout', () => {
    const clock = clockOf()
    const r = runSync('python', ['gate.py'], { timeoutMs: 7_200_000 }, {
      spawn: fakeSpawn(ETIMEDOUT, 7, clock),
      now: () => clock.t,
    })
    expect(r.timedOut).toBe(false)
    expect(r.elapsedMs).toBe(7)
    expect(r.fault).toEqual({ code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 7 })
    expect(faultSummary(r.fault)).toBe('code ETIMEDOUT, status null, after 7 ms')
  })

  /**
   * The stale deadline belongs to the PREVIOUS call, so the spawn behind the
   * killed one runs normally — the reproduction's B and C. Live C9 attempt 5
   * proved that naming the fault is not enough on its own: it refused correctly
   * ("the re-check subprocess did not run … after 15 ms") and the triple still
   * went ungraded, because the runner's first spawn after four idle hours was
   * the spawn of the subprocess itself.
   */
  it('retries an impossible ETIMEDOUT exactly once and returns the retry as the reading', () => {
    const clock = clockOf()
    const calls = []
    const spawn = (...a) => {
      calls.push(a[0])
      if (calls.length === 1) { clock.t += 15; return ETIMEDOUT }
      clock.t += 240_000
      return { status: 1, stdout: '[check] c9: REFUSED — 2 problem(s)\n', stderr: '' }
    }
    const r = runSync('bun', ['x.mjs', '--check'], { timeoutMs: 7_200_000, retryImpossibleTimeout: true }, { spawn, now: () => clock.t })
    expect(calls).toHaveLength(2)
    expect(r.fault).toBeNull()
    expect(r.timedOut).toBe(false)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/REFUSED/)
    expect(r.staleDeadlineRetried).toBe(true)
  })

  // Phase 6 fix wave (P-F155): at a 20 s probe cadence every tick's first
  // spawn trips the stale deadline, and a red line per tick buries the log. A
  // caller that counts its retries takes the line through `onStaleRetry` and
  // decides how often to print it; nothing is written to stderr then.
  it('hands the retry line to onStaleRetry instead of stderr when the caller gives one', () => {
    const clock = clockOf()
    let n = 0
    const spawn = () => { n += 1; clock.t += n === 1 ? 6 : 20; return n === 1 ? ETIMEDOUT : { status: 0, stdout: 'abc\n', stderr: '' } }
    const lines = []
    const errors = []
    const saved = console.error
    console.error = (m) => errors.push(m)
    try {
      const r = runSync('git', ['rev-parse'], { timeoutMs: 30_000, retryImpossibleTimeout: true, onStaleRetry: (m) => lines.push(m) }, { spawn, now: () => clock.t })
      expect(r.staleDeadlineRetried).toBe(true)
      expect(r.stdout).toBe('abc\n')
    } finally { console.error = saved }
    expect(lines).toEqual(["[spawn] git: an impossible ETIMEDOUT after 6 ms (cap 30000 ms) — bun's stale deadline; retried once and the retry ran (F155)"])
    expect(errors).toEqual([])
  })

  /**
   * Opt-in, per call. Running a command twice is only safe when running it twice
   * is the same as running it once — a gate, a stub, a shim and a `--check` are
   * reads of a tree. A `git commit` or a `git apply` is not, and a harness that
   * silently double-applied a patch to recover from a timeout it invented would be
   * a worse bug than the one being fixed.
   */
  it('never retries a command the caller did not mark idempotent', () => {
    const clock = clockOf()
    let n = 0
    const spawn = () => { n += 1; clock.t += 11; return ETIMEDOUT }
    const r = runSync('git', ['apply', 'p.patch'], { timeoutMs: 60_000 }, { spawn, now: () => clock.t })
    expect(n).toBe(1)
    expect(r.fault?.code).toBe('ETIMEDOUT')
    expect(r.staleDeadlineRetried).toBeUndefined()
  })

  it('the three gate spawns and the check subprocess opt in; git writes do not', () => {
    const src = readFileSync(new URL('../cynco-campaign-calibrate.mjs', import.meta.url), 'utf8')
    // The gate, the perturb, the positive shim and the suite baseline: all reads.
    expect(src.match(/retryImpossibleTimeout: true/g) ?? []).toHaveLength(4)
    // archiveBase shells out to `git archive | tar -x`, which writes a tree.
    expect(/archive [\s\S]{0,400}retryImpossibleTimeout/.test(src)).toBe(false)
    const author = readFileSync(new URL('../cynco-gate-author.mjs', import.meta.url), 'utf8')
    expect(/io\.run\('bun', args, \{ timeoutMs, retryImpossibleTimeout: true \}\)/.test(author)).toBe(true)
    // commitStaging / restoreUncommittedWork run git writes and must not retry.
    expect(/'apply'[\s\S]{0,200}retryImpossibleTimeout/.test(author)).toBe(false)
    expect(/'commit'[\s\S]{0,200}retryImpossibleTimeout/.test(author)).toBe(false)
    // Review I2: the wave grader's gate and suite-gate runs are reads and opt
    // in; the mutation sweep rewrites the tree per mutant and must not.
    const grade = readFileSync(new URL('../cynco-campaign-grade.mjs', import.meta.url), 'utf8')
    // Phase 6: the gate's retry is runGate's `retry` option, true by default
    // (the verdict's read) and false for the mid-wave progress probe.
    expect(grade.match(/retryImpossibleTimeout: true/g) ?? []).toHaveLength(1)
    expect(/export function runGate\(spec, io, \{[^}]*retry = true[^}]*\}/.test(grade)).toBe(true)
    expect(/\[spec\.gate\][\s\S]{0,200}retryImpossibleTimeout: retry\b/.test(grade)).toBe(true)
    // …and the probe never retries: a 215 s gate re-run is not free, and a
    // stale ETIMEDOUT mid-wave is a fault reading (F155).
    const progress = readFileSync(new URL('../cynco-campaign-progress.mjs', import.meta.url), 'utf8')
    expect(/runGate\(spec, grade, \{[^}]*retry: false[^}]*\}\)/.test(progress)).toBe(true)
    expect(/retry: true|retryImpossibleTimeout: true/.test(progress)).toBe(false)
    expect(/\[SUITE_GATE\(\)\][\s\S]{0,300}retryImpossibleTimeout: true/.test(grade)).toBe(true)
    expect(/cynco-mutation-sweep[\s\S]{0,600}retryImpossibleTimeout/.test(grade)).toBe(false)
  })

  it('retries at most once, and the second failure is the fault it reports', () => {
    const clock = clockOf()
    let n = 0
    const spawn = () => { n += 1; clock.t += 9; return ETIMEDOUT }
    const r = runSync('bun', ['x.mjs'], { timeoutMs: 7_200_000, retryImpossibleTimeout: true }, { spawn, now: () => clock.t })
    expect(n).toBe(2)
    expect(r.fault?.code).toBe('ETIMEDOUT')
    expect(r.staleDeadlineRetried).toBeUndefined()
  })

  it('never retries an error that is not an impossible timeout', () => {
    const clock = clockOf()
    let n = 0
    const spawn = () => { n += 1; clock.t += 3; return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('nope'), { code: 'ENOENT' }) } }
    const r = runSync('nope', [], { timeoutMs: 1000 }, { spawn, now: () => clock.t })
    expect(n).toBe(1)
    expect(r.fault?.code).toBe('ENOENT')
  })

  it('never retries a REAL timeout — it is a reading, not a fault', () => {
    const clock = clockOf()
    let n = 0
    const spawn = () => { n += 1; clock.t += 7_200_000; return ETIMEDOUT }
    const r = runSync('python', ['slow.py'], { timeoutMs: 7_200_000 }, { spawn, now: () => clock.t })
    expect(n).toBe(1)
    expect(r.timedOut).toBe(true)
    expect(r.fault).toBeNull()
  })

  it('calls a real timeout a timeout once the elapsed time reaches the fraction', () => {
    const clock = clockOf()
    const spent = Math.ceil(7_200_000 * TIMEOUT_ELAPSED_FRACTION)
    const r = runSync('python', ['gate.py'], { timeoutMs: 7_200_000 }, {
      spawn: fakeSpawn({ status: null, stdout: 'partial\n', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, spent, clock),
      now: () => clock.t,
    })
    expect(r.timedOut).toBe(true)
    expect(r.fault).toBeNull()
    expect(r.elapsedMs).toBe(spent)
  })

  it('names any other spawn error as a fault, carrying signal and status', () => {
    const clock = clockOf()
    const r = runSync('python', ['gate.py'], { timeoutMs: 1000 }, {
      spawn: fakeSpawn({ status: null, stdout: '', stderr: '', signal: 'SIGKILL', error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }, 3, clock),
      now: () => clock.t,
    })
    expect(r.timedOut).toBe(false)
    expect(r.fault).toEqual({ code: 'ENOENT', status: null, signal: 'SIGKILL', elapsedMs: 3 })
    expect(faultSummary(r.fault)).toContain('signal SIGKILL')
  })

  it('a clean run reports neither, and carries its elapsed time', () => {
    const clock = clockOf()
    const r = runSync('python', ['gate.py'], { timeoutMs: 1000 }, {
      spawn: fakeSpawn({ status: 0, stdout: 'GATE: PASS\n', stderr: '' }, 42, clock),
      now: () => clock.t,
    })
    expect(r).toMatchObject({ status: 0, stdout: 'GATE: PASS\n', stderr: '', elapsedMs: 42, timedOut: false, fault: null })
    expect(faultSummary(null)).toBe('')
  })

  it('an ETIMEDOUT with no cap to compare against is a fault, never a timeout', () => {
    const clock = clockOf()
    const r = runSync('python', ['gate.py'], {}, {
      spawn: fakeSpawn({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }, 5, clock),
      now: () => clock.t,
    })
    expect(r.timedOut).toBe(false)
    expect(r.fault?.code).toBe('ETIMEDOUT')
  })

  it('really runs a process, and passes cwd and env through', () => {
    const r = runSync(process.execPath, ['-e', 'process.stdout.write(process.env.CYNCO_SPAWN_PROBE ?? "")'],
      { timeoutMs: 60_000, env: { CYNCO_SPAWN_PROBE: 'live' } })
    expect(r.stdout).toBe('live')
    expect(r.status).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.fault).toBeNull()
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

// F160. A bare `bash` on a Windows PATH is the WSL launcher unless Git's bin
// dir is ahead of System32 — true in a Git Bash terminal, false from
// PowerShell, cmd, Start-Process or Task Scheduler. The Phase 4 live proof's
// first wave, launched from PowerShell, faulted at `set -o pipefail`.
describe('bashBin (F160): Git Bash by path, never whatever `bash` PATH holds', () => {
  const only = (...ok) => (p) => ok.includes(p)

  it('resolves <root>\\bin\\bash.exe from Git for Windows\' PATH entry <root>\\cmd\\git.exe', () => {
    const got = bashBin({ platform: 'win32', gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe', exists: only('C:\\Program Files\\Git\\bin\\bash.exe') })
    expect(got).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('resolves the same bash from <root>\\mingw64\\bin\\git.exe', () => {
    const got = bashBin({ platform: 'win32', gitPath: 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe', exists: only('C:\\Program Files\\Git\\bin\\bash.exe') })
    expect(got).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('never probes outside the Git root: <root>\\bin only, for both layouts', () => {
    const probed = []
    const exists = (p) => { probed.push(p); return false }
    expect(() => bashBin({ platform: 'win32', gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe', exists })).toThrow(/F160/)
    expect(() => bashBin({ platform: 'win32', gitPath: 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe', exists })).toThrow(/F160/)
    expect(probed).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'])
  })

  it('on win32 REFUSES with a named error when no Git Bash is found (no git, or no bash beside it); off win32 it is bare `bash`', () => {
    expect(() => bashBin({ platform: 'win32', gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe', exists: () => false })).toThrow(/F160: no Git Bash found beside C:\\Program Files\\Git\\cmd\\git.exe/)
    expect(() => bashBin({ platform: 'win32', gitPath: null, exists: () => true })).toThrow(/F160: no Git Bash found \(no git.exe on PATH\)/)
    expect(bashBin({ platform: 'linux', gitPath: '/usr/bin/git', exists: () => true })).toBe('bash')
    expect(bashBin({ platform: 'darwin', gitPath: null, exists: () => false })).toBe('bash')
  })

  it('gitExeOnPath runs System32\\where.exe by full path for $PATH:git.exe (PATH only, never the cwd), takes its first line, and null when it prints nothing', () => {
    const calls = []
    const spawn = (out) => (cmd, args) => { calls.push([cmd, args]); return out }
    expect(gitExeOnPath(spawn({ stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\nC:\\Program Files\\Git\\mingw64\\bin\\git.exe\r\n' }), 'C:\\Windows')).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(calls[0]).toEqual(['C:\\Windows\\System32\\where.exe', ['$PATH:git.exe']])
    expect(gitExeOnPath(spawn({ stdout: '' }), null)).toBeNull()   // no SystemRoot: bare name is all there is
    expect(calls[1][0]).toBe('where.exe')
    expect(gitExeOnPath(spawn({ stdout: undefined, error: new Error('ENOENT') }), 'C:\\Windows')).toBeNull()
  })

  it('on this machine, win32: bashExe() is an existing file under a Git install, never System32; elsewhere: bash', () => {
    const b = bashExe()
    if (process.platform !== 'win32') { expect(b).toBe('bash'); return }
    expect(b).not.toBe('bash')
    expect(b.toLowerCase()).not.toContain('system32')
    expect(b.toLowerCase()).toMatch(/\\bin\\bash\.exe$/)
    expect(existsSync(b)).toBe(true)
  })

  // The guard: no spawn under scripts/ names bare 'bash' again, and the wave
  // dispatch reads the spec's env through waveEnvBase (F161).
  it('source guard: every bash spawn in scripts/ goes through bashExe(), and dispatch uses waveEnvBase(spec)', () => {
    const dir = fileURLToPath(new URL('../', import.meta.url))
    const bare = []
    for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        // Any quoting, any of the spawn family, `shell: 'bash'`, and the
        // command-string forms (`execSync('bash …')`, `exec("bash -c …")`).
        const bare1 = /\b(spawnSync|spawn|run|execFileSync|execFile|execSync|exec)\(\s*(['"`])bash(?:\s|\2)/.test(line)
        const bare2 = /\bshell:\s*(['"`])bash\1/.test(line)
        if (bare1 || bare2) bare.push(`${f}:${i + 1}`)
      }
    }
    expect(bare).toEqual([])
    const campaign = readFileSync(join(dir, 'cynco-campaign.mjs'), 'utf8')
    // Phase 7 ruling 3: the wave's env is built in waveDispatch, over the runner's env.
    expect(campaign).toMatch(/dispatchEnv\(waveEnvBase\(spec, base\)/)
    // I3: both dispatches (wave and authoring) go through the one runDispatch,
    // whose spawn is runSync WITHOUT retryImpossibleTimeout.
    expect(campaign.match(/\['scripts\/dispatch-mission\.sh'/g)?.length).toBe(1)
    const dispatchCall = campaign.split('\n').find(l => l.includes("['scripts/dispatch-mission.sh'"))
    expect(dispatchCall).toMatch(/runSync\(bash \?\? bashExe\(\), \['scripts\/dispatch-mission\.sh'/)
    expect(dispatchCall).not.toMatch(/retryImpossibleTimeout/)
    expect(campaign.match(/\brunDispatch\((\[|args, env\))/g)?.length).toBe(2)
    expect(readFileSync(join(dir, 'cynco-campaign-calibrate.mjs'), 'utf8')).toMatch(/io\.run\(bashExe\(\), \['-c'/)
  })
})

describe('runSync envExact: a stripped environment stays stripped', () => {
  it('merges over process.env by default, and passes env as the whole environment with envExact', () => {
    const seen = []
    const spawn = (_c, _a, o) => { seen.push(o.env); return { status: 0, stdout: '', stderr: '' } }
    const prev = process.env.CYNCO_NTFY_URL
    process.env.CYNCO_NTFY_URL = 'https://example.invalid/topic'
    try {
      runSync('x', [], { env: { A: '1' } }, { spawn })
      runSync('x', [], { env: { A: '1' }, envExact: true }, { spawn })
    } finally {
      if (prev === undefined) delete process.env.CYNCO_NTFY_URL; else process.env.CYNCO_NTFY_URL = prev
    }
    expect(seen[0].CYNCO_NTFY_URL).toBe('https://example.invalid/topic')
    expect(seen[1]).toEqual({ A: '1' })
  })
})

// I3: the wave dispatch is the first spawn after waitForDriver's multi-hour
// idle — F155's exact trigger. It must name a stale-deadline kill as a harness
// fault, keep a real timeout a timeout, and never re-dispatch on its own.
describe('runDispatch: the mission launch names a stale ETIMEDOUT and never retries it', () => {
  const quiet = () => { const log = console.log; console.log = () => {}; return () => { console.log = log } }

  it('an ETIMEDOUT in milliseconds is a named harness fault, spawned exactly once', async () => {
    const { runDispatch, DISPATCH_TIMEOUT_MS } = await import('../cynco-campaign.mjs')
    const clock = clockOf()
    const calls = []
    const spawn = (...a) => { calls.push(a); clock.t += 7; return ETIMEDOUT }
    let err
    try { runDispatch(['b.md', 'M', 'repo', '60', ''], { DRIVER_LOG: 'd.log' }, { bash: 'bash.exe', spawn, now: () => clock.t }) }
    catch (e) { err = e }
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('bash.exe')
    expect(calls[0][1]).toEqual(['scripts/dispatch-mission.sh', 'b.md', 'M', 'repo', '60', ''])
    expect(calls[0][2].timeout).toBe(DISPATCH_TIMEOUT_MS)
    // envExact: the dispatch env is the whole environment, nothing merged back.
    expect(calls[0][2].env).toEqual({ DRIVER_LOG: 'd.log' })
    expect(err?.message).toMatch(/^dispatch harness fault: dispatch-mission\.sh did not run \(code ETIMEDOUT, status null, after 7 ms\)/)
    expect(err?.message).toMatch(/F155/)
    expect(err?.message).not.toMatch(/exit null/)
  })

  it('an ETIMEDOUT that spent the cap stays a timeout', async () => {
    const { runDispatch, DISPATCH_TIMEOUT_MS } = await import('../cynco-campaign.mjs')
    const clock = clockOf()
    const spawn = () => { clock.t += DISPATCH_TIMEOUT_MS; return ETIMEDOUT }
    expect(() => runDispatch(['b.md'], {}, { bash: 'bash.exe', spawn, now: () => clock.t }))
      .toThrow(new RegExp(`^dispatch timed out after ${DISPATCH_TIMEOUT_MS} ms`))
  })

  it('a non-zero exit is a failed dispatch; a clean one re-emits the launcher output', async () => {
    const { runDispatch } = await import('../cynco-campaign.mjs')
    const clock = clockOf()
    const failing = () => { clock.t += 50; return { status: 3, stdout: 'no engine\n', stderr: '' } }
    expect(() => runDispatch(['b.md'], {}, { bash: 'bash.exe', spawn: failing, now: () => clock.t }))
      .toThrow(/^dispatch failed \(exit 3\): no engine/)
    const ok = () => { clock.t += 50; return { status: 0, stdout: '[dispatch] driver pid 42\n', stderr: '' } }
    const restore = quiet()
    let r
    try { r = runDispatch(['b.md'], {}, { bash: 'bash.exe', spawn: ok, now: () => clock.t }) } finally { restore() }
    expect(r.status).toBe(0)
    expect(r.fault).toBeNull()
  })
})

// F166. The operator's terminal exported FORCE_COLOR=3; the runner inherited it
// through a detached launch; pytest honours it on a pipe and printed
// `\x1b[31mFAILED\x1b[0m …`; the suite gate's `startswith("FAILED ")` then saw a
// run with one real regression as "failures but no FAILED lines" and C10 wave 1
// became a harness fault instead of a graded MISS. An instrument's output is
// parsed, so the instrument is never handed a colour-forcing environment.
describe('F166: a parsed instrument never inherits a colour-forcing environment', () => {
  const envSeen = (opts) => {
    const clock = clockOf()
    let seen = null
    const spawn = (_cmd, _args, o) => { clock.t += 10; seen = o.env; return { status: 0, stdout: '', stderr: '' } }
    runSync('python', ['g_suite_no_regression.py'], opts, { spawn, now: () => clock.t })
    return seen
  }
  const withForced = (fn) => {
    const saved = { FORCE_COLOR: process.env.FORCE_COLOR, CLICOLOR_FORCE: process.env.CLICOLOR_FORCE, NO_COLOR: process.env.NO_COLOR, PY_COLORS: process.env.PY_COLORS }
    process.env.FORCE_COLOR = '3'; process.env.CLICOLOR_FORCE = '1'; delete process.env.NO_COLOR; delete process.env.PY_COLORS
    try { return fn() } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }

  it('merge mode drops FORCE_COLOR / CLICOLOR_FORCE and pins NO_COLOR=1, PY_COLORS=0 beside the caller keys', () => {
    const env = withForced(() => envSeen({ env: { CHK_SUITE_BASELINE: 'b.txt' }, timeoutMs: 1000 }))
    expect(env.FORCE_COLOR).toBeUndefined()
    expect(env.CLICOLOR_FORCE).toBeUndefined()
    expect(env.NO_COLOR).toBe('1')
    expect(env.PY_COLORS).toBe('0')
    expect(env.CHK_SUITE_BASELINE).toBe('b.txt')
    expect(env.PATH ?? env.Path).toBeDefined()
  })

  it('a caller that sets the colour keys itself is obeyed', () => {
    const env = withForced(() => envSeen({ env: { FORCE_COLOR: '1', PY_COLORS: '1' }, timeoutMs: 1000 }))
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.PY_COLORS).toBe('1')
    expect(env.NO_COLOR).toBe('1')
  })

  it('envExact is passed through untouched (the dispatch env is built on purpose)', () => {
    const env = withForced(() => envSeen({ env: { ONLY: 'this', FORCE_COLOR: '3' }, envExact: true, timeoutMs: 1000 }))
    expect(env).toEqual({ ONLY: 'this', FORCE_COLOR: '3' })
  })

  it('instrumentEnv is the one rule, exported so the probe and the sweep share it', async () => {
    const { instrumentEnv, COLOUR_FORCING_KEYS, NO_COLOUR_ENV } = await import('../cynco-spawn.mjs')
    expect(COLOUR_FORCING_KEYS).toEqual(['FORCE_COLOR', 'CLICOLOR_FORCE'])
    expect(NO_COLOUR_ENV).toEqual({ NO_COLOR: '1', PY_COLORS: '0' })
    expect(instrumentEnv({ FORCE_COLOR: '3', PATH: 'p' }, { X: '1' })).toEqual({ PATH: 'p', X: '1', NO_COLOR: '1', PY_COLORS: '0' })
  })
})

// Phase 7 review C1: the marker check must not block the driver's event loop,
// so it runs through runAsync — same result shape, same F166 env, same
// elapsed-time reading of a timeout.
describe('runAsync: the async sibling of runSync', () => {
  const node = process.execPath
  it('returns status and output without blocking the event loop', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 50)
    try {
      const r = await runAsync(node, ['-e', "setTimeout(() => { console.log('out'); console.error('err'); process.exit(3) }, 600)"], { timeoutMs: 30_000 })
      expect(r).toMatchObject({ status: 3, timedOut: false, fault: null })
      expect(r.stdout).toContain('out')
      expect(r.stderr).toContain('err')
      expect(ticks).toBeGreaterThan(3)
    } finally { clearInterval(timer) }
  })
  it('a deadline that was spent is a timeout, and the child is killed', async () => {
    const r = await runAsync(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 800 })
    expect(r.timedOut).toBe(true)
    expect(r.fault).toBeNull()
    expect(r.status).toBeNull()
    expect(r.elapsedMs).toBeGreaterThanOrEqual(800 * TIMEOUT_ELAPSED_FRACTION)
  })
  it('a deadline the clock says was NOT spent is a fault, never a timeout (the shared rule)', async () => {
    let t = 0
    const killed = []
    const fakeChild = () => {
      const handlers = {}
      const child = { pid: 1, on: (ev, fn) => { handlers[ev] = fn }, stdout: null, stderr: null }
      setTimeout(() => handlers.close?.(null, 'SIGKILL'), 30)
      return child
    }
    const r = await runAsync('x', [], { timeoutMs: 10 }, { spawn: fakeChild, now: () => t, kill: (c) => { killed.push(c.pid) } })
    expect(killed).toEqual([1])
    expect(r.timedOut).toBe(false)
    expect(r.fault).toMatchObject({ code: 'ETIMEDOUT' })
  })
  it('a spawn error is a fault', async () => {
    const r = await runAsync(node, ['-e', '0'], { cwd: join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-dir-7f1c'), timeoutMs: 30_000 })
    expect(r.fault).not.toBeNull()
    expect(r.timedOut).toBe(false)
  })
  it('hands the child the colourless instrument env (F166)', async () => {
    const prev = process.env.FORCE_COLOR
    process.env.FORCE_COLOR = '3'
    try {
      const r = await runAsync(node, ['-e', "console.log(String(process.env.FORCE_COLOR) + '/' + process.env.NO_COLOR)"], { timeoutMs: 30_000 })
      expect(r.stdout.trim()).toBe('undefined/1')
    } finally { if (prev === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prev }
  })
})

// Plan P6 item 6, the in-box half (wave 19b): the driver polls the integrity latch every 30 s and
// must be able to end an in-box marker check it is waiting on. The `signal` option: an aborted run
// ends its child's tree and is its own fault code, EABORTED, never a status, a timeout or a pass.
describe('runAsync: the signal option', () => {
  const node = process.execPath
  /** A child stand-in that closes only when killed (or after `closeAfterMs`, if given). */
  const childOf = (pid, closeAfterMs = null) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = pid
    if (closeAfterMs !== null) setTimeout(() => { child.stdout.emit('data', 'done'); child.emit('close', 0, null) }, closeAfterMs)
    return child
  }

  it('an abort while the child runs ends its tree and is EABORTED, never a status or a timeout', async () => {
    const killed = []
    let child
    const ac = new AbortController()
    const p = runAsync('x', [], { timeoutMs: 60_000, signal: ac.signal }, {
      spawn: () => { child = childOf(31); return child },
      kill: (c) => { killed.push(c.pid); setTimeout(() => c.emit('close', null, 'SIGKILL'), 5) },
    })
    setTimeout(() => ac.abort(), 20)
    const r = await p
    expect(killed).toEqual([31])
    expect(r.status).toBeNull()
    expect(r.timedOut).toBe(false)
    expect(r.fault).toMatchObject({ code: 'EABORTED', status: null })
    expect(faultSummary(r.fault)).toContain('code EABORTED')
  })

  it('really ends a running process: the run comes back long before its own end or its cap', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 300)
    const r = await runAsync(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 60_000, signal: ac.signal })
    expect(r.fault?.code).toBe('EABORTED')
    expect(r.timedOut).toBe(false)
    expect(Date.now() - t0).toBeLessThan(30_000)
  })

  it('a signal aborted before the start: nothing is spawned, recorded or established, EABORTED', async () => {
    let spawned = 0
    const events = []
    const handle = { start: (rec) => { events.push(rec); return { ok: true, call: 1 } }, end: () => { events.push('end') } }
    const ac = new AbortController()
    ac.abort()
    const r = await runAsync('python', ['gate.py'], { timeoutMs: 1000, signal: ac.signal, audit: { handle, src: 'driver-marker' }, contained: { own: 'C:/never-made' } }, {
      spawn: () => { spawned++; return childOf(9, 5) },
      establish: () => { throw new Error('must not establish') },
    })
    expect(spawned).toBe(0)
    expect(events).toEqual([])
    expect(r).toMatchObject({ status: null, timedOut: false, fault: { code: 'EABORTED', started: false } })
    expect(r.stderr).toContain('aborted before it was started')
    // Wave 19c (check G, GB-3): a check whose signal was aborted before the call ran nothing and ended no
    // tree, and its line says so (the line for an abort while it ran says the tree was ended).
    const pre = await runCheckAsync('anything at all', tmpdir(), 1000, { signal: ac.signal })
    expect(pre).toMatchObject({ verified: null, stopped: true, spawnFailed: false, timedOut: false })
    expect(pre.harnessFault).toBe('stopped by its caller before it started: nothing was run')
    expect(pre.output).toContain('[check] HARNESS FAULT: stopped by its caller before it started: nothing was run')
    expect(pre.output).not.toContain('its process tree was ended')
  })

  it('an abort after the close changes nothing, and the listener is gone', async () => {
    const killed = []
    const ac = new AbortController()
    const r = await runAsync('x', [], { timeoutMs: 1000, signal: ac.signal }, { spawn: () => childOf(12, 5), kill: (c) => { killed.push(c.pid) } })
    ac.abort()
    expect(r).toMatchObject({ status: 0, fault: null, timedOut: false })
    expect(killed).toEqual([])
    // A long-lived signal (the driver's poll) must not collect one listener per check.
    const listeners = new Set()
    const signal = { aborted: false, addEventListener: (ev, fn) => listeners.add(fn), removeEventListener: (ev, fn) => listeners.delete(fn) }
    const p = runAsync('x', [], { timeoutMs: 1000, signal }, { spawn: () => childOf(15, 5) })
    expect(listeners.size).toBe(1)
    await p
    expect(listeners.size).toBe(0)
  })

  it('a deadline spent before the abort stays a timeout; an abort first is never a timeout', async () => {
    let t = 0
    const ac1 = new AbortController()
    const timedOut = await runAsync('x', [], { timeoutMs: 10, signal: ac1.signal }, {
      spawn: () => childOf(13), now: () => t,
      kill: (c) => { t += 10; ac1.abort(); setTimeout(() => c.emit('close', null, 'SIGKILL'), 5) },
    })
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.fault).toBeNull()
    const ac2 = new AbortController()
    const kills = []
    const p = runAsync('x', [], { timeoutMs: 60, signal: ac2.signal }, {
      spawn: () => childOf(14),
      kill: (c) => { kills.push(c.pid); setTimeout(() => c.emit('close', null, 'SIGKILL'), 120) },
    })
    setTimeout(() => ac2.abort(), 5)
    const aborted = await p
    expect(aborted.fault?.code).toBe('EABORTED')
    expect(aborted.timedOut).toBe(false)
    // Changed on purpose in wave 19c (check G, GB-2), was [14]: the abort's kill at 5 ms has not closed
    // the child by the deadline at 60 ms, so the deadline kills the tree a second time (a second try for
    // a root the first kill left running). The abort still names the end.
    expect(kills).toEqual([14, 14])
  })

  // Wave 19c (check G, GB-2): after an abort, a run still open at the deadline is killed once more: a
  // second try for a root the first kill left running (shown here with a fake kill), and the run settles
  // as EABORTED, not a timeout. A process that outlived a dead root is not reached by it (killTree finds
  // the tree from the root's pid); such a run stays open.
  it('an abort whose kill missed: the deadline kills again, and the run settles as EABORTED, never a timeout', async () => {
    const kills = []
    const ac = new AbortController()
    const p = runAsync('x', [], { timeoutMs: 50, signal: ac.signal }, {
      spawn: () => childOf(16),
      // The first kill (the abort's) misses; the second (the deadline's) ends the child.
      kill: (c) => { kills.push(c.pid); if (kills.length > 1) setTimeout(() => c.emit('close', null, 'SIGKILL'), 5) },
    })
    setTimeout(() => ac.abort(), 5)
    const r = await p
    expect(kills).toEqual([16, 16])
    expect(r.fault?.code).toBe('EABORTED')
    expect(r.timedOut).toBe(false)
    expect(r.status).toBeNull()
  })

  it('runCheckAsync forwards the signal: verified null, stopped, not a spawn failure, and the line says the check was stopped', async () => {
    // The check's shell is the engine's (PowerShell on Windows, which needs `&` before a quoted program).
    const RUNTIME = process.platform === 'win32' ? `& "${node}"` : `"${node}"`
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const r = await runCheckAsync(`${RUNTIME} -e "setTimeout(() => {}, 60000)"`, tmpdir(), 60_000, { signal: ac.signal })
    expect(r.verified).toBeNull()
    expect(r.stopped).toBe(true)
    expect(r.spawnFailed).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.harnessFault).toContain('stopped by its caller while it ran')
    expect(r.output).toContain('[check] HARNESS FAULT: stopped by its caller while it ran')
    const ok = await runCheckAsync(`${RUNTIME} -e "process.exit(0)"`, tmpdir(), 60_000, { signal: new AbortController().signal })
    expect(ok).toMatchObject({ verified: true, stopped: false, spawnFailed: false })
    // Wave 19c (check G, GB-1): an abort at 1.5 s and a second PowerShell start took 1.78 s on a quiet PC;
    // under the whole suite's load that is too near vitest's 5 s default, so this case has its own limit.
    // The abort stays at 1.5 s so PowerShell has started node and the tree kill is the real one.
  }, 20_000)
})

// F242 (01-isolation 7.1, tests 9.7): the `contained` option. A command that runs workspace
// code for an unattended run starts inside a containment, or not at all; a launcher that could
// not run it is a fault, never the command's own exit code.
describe('the contained option', () => {
  const SWITCH = 'LOCALCODE_CONTAINMENT_OFF'
  let switchBefore
  let dir
  beforeEach(() => {
    switchBefore = process.env[SWITCH]
    delete process.env[SWITCH]
    dir = mkdtempSync(join(tmpdir(), 'cynco-spawn-contained-'))
  })
  afterEach(() => {
    if (switchBefore === undefined) delete process.env[SWITCH]
    else process.env[SWITCH] = switchBefore
    rmSync(dir, { recursive: true, force: true })
  })
  const ctxOf = (o = {}) => {
    const sandbox = { root: join(dir, 'run'), home: join(dir, 'run', 'home'), tmp: join(dir, 'run', 'tmp'), scratch: join(dir, 'run', 'scratch') }
    return testContainment({ missionCwd: join(dir, 'mission'), sandbox, home: join(dir, 'realhome'), folders: { state: dir, models: dir, guard: dir, audit: null }, ...o })
  }
  /** A test context may run here: on Windows vitest's Node has no launcher, so `lowil` is switched off for it. */
  const allowTestRun = () => { if (process.platform === 'win32') process.env[SWITCH] = 'lowil' }
  const recorder = () => {
    const calls = []
    const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'ok', stderr: '' } }
    return { calls, spawn }
  }
  const asyncChild = (status, stderr = '') => (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    setTimeout(() => { if (stderr) child.stderr.emit('data', stderr); child.emit('close', status, null) }, 5)
    return child
  }
  const UNKNOWN = '[spawn] REFUSED: containment: LOCALCODE_CONTAINMENT_OFF names an unknown layer: nonsense — nothing was run'

  it('runSync and runAsync refuse a context the switch makes unrunnable, and start nothing', async () => {
    process.env[SWITCH] = 'nonsense'
    const { calls, spawn } = recorder()
    const r = runSync('python', ['gate.py'], { contained: ctxOf(), timeoutMs: 1000, retryImpossibleTimeout: true }, { spawn })
    expect(r).toEqual({ status: null, stdout: '', stderr: UNKNOWN, elapsedMs: 0, timedOut: false, fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 } })
    expect(faultSummary(r.fault)).toBe('code ECONTAINMENT, status null, after 0 ms')
    let spawned = 0
    const a = await runAsync('python', ['gate.py'], { contained: ctxOf(), timeoutMs: 1000 }, { spawn: () => { spawned++; return asyncChild(0)() } })
    expect(a.fault?.code).toBe('ECONTAINMENT')
    expect(a.stderr).toBe(UNKNOWN)
    expect(a.timedOut).toBe(false)
    expect(calls).toEqual([])
    expect(spawned).toBe(0)
  })

  it('a test context overlays the environment: the sandbox home, NO_COLOR still 1, FORCE_COLOR still absent', () => {
    allowTestRun()
    const prev = process.env.FORCE_COLOR
    process.env.FORCE_COLOR = '3'
    try {
      const ctx = ctxOf()
      const { calls, spawn } = recorder()
      const r = runSync('python', ['gate.py'], { contained: ctx, cwd: dir, env: { CYNCO_GATE_REPO: dir } }, { spawn })
      expect(r.fault).toBeNull()
      expect(calls).toHaveLength(1)
      const env = calls[0].opts.env
      expect(env.HOME).toBe(ctx.sandbox.home)
      expect(env.CYNCO_SCRATCH).toBe(ctx.sandbox.scratch)
      expect(env.NO_COLOR).toBe('1')
      expect(env.CYNCO_GATE_REPO).toBe(dir)
      expect('FORCE_COLOR' in env).toBe(false)
      expect(calls[0].cmd).toBe('python')
      expect(calls[0].args).toEqual(['gate.py'])
      expect(calls[0].opts.cwd).toBe(dir)
    } finally { if (prev === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prev }
  })

  it('a contained command cannot take an exact environment', () => {
    const { calls, spawn } = recorder()
    const r = runSync('python', ['gate.py'], { contained: ctxOf(), env: { A: '1' }, envExact: true }, { spawn })
    expect(r.fault?.code).toBe('ECONTAINMENT')
    expect(r.stderr).toBe('[spawn] REFUSED: containment: a contained command cannot take an exact environment — nothing was run')
    expect(calls).toEqual([])
  })

  it('{ own }: an establish that refuses gives the fault and starts nothing', () => {
    const { calls, spawn } = recorder()
    const released = []
    const r = runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') } }, {
      spawn, ownLevel: () => 'medium',
      establish: () => ({ ok: false, reason: 'the sandbox root X is not an absolute path to an existing folder' }),
      release: (c) => { released.push(c); return { relabelled: true, note: '' } },
    })
    expect(r.fault?.code).toBe('ECONTAINMENT')
    expect(r.stderr).toBe('[spawn] REFUSED: containment: the sandbox root X is not an absolute path to an existing folder — nothing was run')
    expect(calls).toEqual([])
    expect(released).toEqual([])
  })

  it('{ own }: a grader containment around the folder, released once after the run, and once when the spawn throws', async () => {
    allowTestRun()
    const own = join(dir, 'base')
    const asked = []
    const released = []
    const ctx = ctxOf({ kind: 'grader', missionCwd: own })
    const hooks = {
      ownLevel: () => 'medium',
      establish: (a) => { asked.push(a); return { ok: true, containment: ctx, ms: 0 } },
      release: (c) => { released.push(c); return { relabelled: true, note: '' } },
    }
    const { calls, spawn } = recorder()
    expect(runSync('python', ['gate.py'], { contained: { own } }, { ...hooks, spawn }).status).toBe(0)
    // R3-F1 (wave 12): the run id is minted before the audit start (so the grader's records can carry it) and
    // handed to establish; it used to be a label establish minted from. The same label, so the same id shape.
    expect(asked).toEqual([{ kind: 'grader', runId: expect.stringMatching(/^grade-base-\d{8}T\d{6}-[0-9a-f]{4}$/), missionCwd: own, labelCwd: true, extraRoots: undefined }])
    expect(calls[0].opts.env.HOME).toBe(ctx.sandbox.home)
    expect(released).toEqual([ctx])
    expect(() => runSync('python', ['gate.py'], { contained: { own } }, { ...hooks, spawn: () => { throw new Error('spawn blew up') } })).toThrow('spawn blew up')
    expect(released).toEqual([ctx, ctx])
    const a = await runAsync('python', ['gate.py'], { contained: { own } }, { ...hooks, spawn: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } })
    expect(a.fault?.code).toBe('ENOENT')
    expect(released).toEqual([ctx, ctx, ctx])
    const b = await runAsync('python', ['gate.py'], { contained: { own } }, { ...hooks, spawn: asyncChild(0) })
    expect(b.status).toBe(0)
    expect(released).toEqual([ctx, ctx, ctx, ctx])
  })

  it('{ own } with labelOwn false asks for no label and keeps Python from writing bytecode beside the code', () => {
    allowTestRun()
    const own = join(dir, 'archive')
    const asked = []
    const ctx = ctxOf({ kind: 'grader', missionCwd: own })
    const { calls, spawn } = recorder()
    runSync('python', ['gate.py'], { contained: { own, labelOwn: false, extraRoots: [join(dir, 'x')] } }, {
      spawn, ownLevel: () => 'medium',
      establish: (a) => { asked.push(a); return { ok: true, containment: ctx, ms: 0 } },
      release: () => ({ relabelled: true, note: '' }),
    })
    expect(asked).toEqual([{ kind: 'grader', runId: expect.stringMatching(/^grade-archive-\d{8}T\d{6}-[0-9a-f]{4}$/), missionCwd: own, labelCwd: false, extraRoots: [join(dir, 'x')] }])
    expect(calls[0].opts.env.PYTHONDONTWRITEBYTECODE).toBe('1')
  })

  it('a caller that is already low integrity runs the command directly: no establish, no release, today\'s values', () => {
    const { calls, spawn } = recorder()
    let established = 0
    let released = 0
    const prev = process.env.FORCE_COLOR
    process.env.FORCE_COLOR = '3'
    try {
      const r = runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') }, cwd: dir, env: { CYNCO_GATE_REPO: dir }, shell: undefined }, {
        spawn, ownLevel: () => 'low',
        establish: () => { established++; return { ok: false, reason: 'must not be asked' } },
        release: () => { released++; return { relabelled: true, note: '' } },
      })
      expect(r.status).toBe(0)
      expect(established).toBe(0)
      expect(released).toBe(0)
      expect(calls[0].cmd).toBe('python')
      expect(calls[0].args).toEqual(['gate.py'])
      expect(calls[0].opts.env).toEqual(instrumentEnv(process.env, { CYNCO_GATE_REPO: dir }))
    } finally { if (prev === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prev }
  })

  // Entry 1.M1. `platform` and `bun` are seams that make the plan take the launcher's form here.
  describe('through the launcher', () => {
    const launcherHooks = (spawn) => ({ spawn, platform: 'win32', bun: true })
    it('starts the launcher, not the command, with the colour-forcing keys out of its environment', () => {
      const prev = process.env.FORCE_COLOR
      process.env.FORCE_COLOR = '3'
      try {
        const { calls, spawn } = recorder()
        const ctx = ctxOf()
        runSync('python', ['gate.py'], { contained: ctx, cwd: dir, env: { CYNCO_GATE_REPO: dir }, shell: 'powershell.exe' }, launcherHooks(spawn))
        expect(calls).toHaveLength(1)
        expect(calls[0].cmd).toBe(process.execPath)
        expect(calls[0].args).toContain('--run-dir')
        expect(calls[0].args).toContain(ctx.sandbox.root)
        expect(calls[0].args).toContain(`CYNCO_GATE_REPO=${dir}`)
        expect(calls[0].args.slice(-3)).toEqual(['--shell', 'powershell.exe', 'python'])
        expect(calls[0].opts.shell).toBeUndefined()
        expect('FORCE_COLOR' in calls[0].opts.env).toBe(false)
      } finally { if (prev === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prev }
    })
    // The launcher's own lines end with its seal for this spawn, which only the starter knows: the
    // fake reads it from the environment the launcher was given (review of slice S5).
    const sealed = (status, line) => (cmd, args, opts) => ({ status, stdout: '', stderr: `${line}\n[containment] sealed ${opts.env.CYNCO_LAUNCHER_SEAL} ${status}\n` })
    it('197 with the launcher\'s sealed line is ECONTAINMENT, 198 with it ECHILDGONE, without the seal an ordinary status', async () => {
      const ctx = ctxOf()
      const refused = runSync('python', [], { contained: ctx }, launcherHooks(sealed(197, '[containment] refused: the containment record could not be read')))
      expect(refused).toMatchObject({ status: null, timedOut: false, fault: { code: 'ECONTAINMENT', status: null } })
      const gone = runSync('python', [], { contained: ctx }, launcherHooks(sealed(198, '[containment] child ended: signal SIGKILL')))
      expect(gone.fault?.code).toBe('ECHILDGONE')
      const own = runSync('python', [], { contained: ctx }, launcherHooks(() => ({ status: 197, stdout: '', stderr: 'the gate itself exits 197\n' })))
      expect(own).toMatchObject({ status: 197, fault: null, timedOut: false })
      // The gate prints the launcher's line itself and exits 197: its own status, not a fault.
      const forged = runSync('python', [], { contained: ctx }, launcherHooks(() => ({ status: 197, stdout: '', stderr: '[containment] refused: forged by the gate\n' })))
      expect(forged).toMatchObject({ status: 197, fault: null, timedOut: false })
      const a = await runAsync('python', [], { contained: ctx }, launcherHooks((cmd, args, opts) => asyncChild(197, `[containment] refused: no\n[containment] sealed ${opts.env.CYNCO_LAUNCHER_SEAL} 197\n`)(cmd, args, opts)))
      expect(a.fault?.code).toBe('ECONTAINMENT')
      const af = await runAsync('python', [], { contained: ctx }, launcherHooks(asyncChild(197, '[containment] refused: no\n')))
      expect(af.fault).toBeNull()
      // Without the launcher, 197 is the command's own code whatever it printed.
      const plain = runSync('python', [], {}, { spawn: () => ({ status: 197, stdout: '', stderr: '[containment] refused: no\n' }) })
      expect(plain).toMatchObject({ status: 197, fault: null })
    })
    // Review finding of slice S2 (06 entry A7): a Bun check script the launcher started at low
    // integrity that could not load itself did not run; it is never a failing gate (F35).
    it('exit 1 with Bun\'s EPERM reading line, through the launcher, is ECONTAINMENT; without the launcher it is exit 1', async () => {
      const ctx = ctxOf()
      const line = 'error: EPERM reading "C:\\\\checkout\\\\scripts\\\\cynco-gate-author.mjs"\n'
      const r = runSync('bun', ['x.mjs'], { contained: ctx }, launcherHooks(() => ({ status: 1, stdout: '', stderr: line })))
      expect(r).toMatchObject({ status: null, timedOut: false, fault: { code: 'ECONTAINMENT', status: null } })
      const a = await runAsync('bun', ['x.mjs'], { contained: ctx }, launcherHooks(asyncChild(1, line)))
      expect(a.fault?.code).toBe('ECONTAINMENT')
      const failed = runSync('bun', ['x.mjs'], { contained: ctx }, launcherHooks(() => ({ status: 1, stdout: '', stderr: 'A1.1: FAIL\n' })))
      expect(failed).toMatchObject({ status: 1, fault: null })
      const plain = runSync('bun', ['x.mjs'], {}, { spawn: () => ({ status: 1, stdout: '', stderr: line }) })
      expect(plain).toMatchObject({ status: 1, fault: null })
    })
  })
  // R3-F1 (wave 12): a grader's start and end records carried run null, so `cynco-audit verify --run <grader id>`
  // found none of them. With `forRun`, the handle is made for the run id the command's own containment gets,
  // which is minted before the start record is written and handed to establish.
  describe('forRun: the records of a grader carry its run id', () => {
    const ownHooks = (asked, released = []) => ({
      ownLevel: () => 'medium',
      establish: (a) => { asked.push(a); return { ok: true, containment: ctxOf({ kind: 'grader', runId: a.runId, missionCwd: a.missionCwd }), ms: 0 } },
      release: (c) => { released.push(c); return { relabelled: true, note: '' } },
    })
    const handleOf = (refuse = null) => {
      const events = []
      let n = 0
      return { events, handle: {
        start(rec) { events.push(['start', rec]); return refuse ? { ok: false, reason: refuse } : { ok: true, call: ++n } },
        end(call, rec) { events.push(['end', call, rec]) },
      } }
    }
    const forRunOf = () => {
      const made = []
      const h = handleOf()
      return { made, events: h.events, audit: { src: 'gate', forRun: (run) => { made.push(run); return h.handle } } }
    }

    it('runSync and runAsync: the handle is made for the minted id, before the start, and establish gets the same id', async () => {
      allowTestRun()
      const own = join(dir, 'base')
      const runs = [
        (o, hk) => runSync('python', ['gate.py'], o, { ...hk, spawn: recorder().spawn }),
        (o, hk) => runAsync('python', ['gate.py'], o, { ...hk, spawn: asyncChild(0) }),
      ]
      for (const run of runs) {
        const asked = []
        const released = []
        const f = forRunOf()
        const r = await run({ contained: { own }, timeoutMs: 1000, audit: f.audit }, ownHooks(asked, released))
        expect(r.status).toBe(0)
        expect(released.map(c => c.runId)).toEqual(f.made)
        expect(f.made).toHaveLength(1)
        expect(f.made[0]).toMatch(/^grade-base-\d{8}T\d{6}-[0-9a-f]{4}$/)
        expect(asked.map(a => a.runId)).toEqual(f.made)
        expect(f.events[0][0]).toBe('start')
      }
    })

    it('two attempts (the F155 retry) are two containments, each with its own id on its own records', () => {
      allowTestRun()
      const asked = []
      const f = forRunOf()
      const clock = clockOf()
      let calls = 0
      const spawn = () => { calls++; clock.t += 3; return calls === 1 ? ETIMEDOUT : { status: 0, stdout: 'ok', stderr: '' } }
      const r = runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') }, timeoutMs: 7_200_000, retryImpossibleTimeout: true, onStaleRetry: () => {}, audit: f.audit }, { ...ownHooks(asked), spawn, now: () => clock.t })
      expect(r.status).toBe(0)
      expect(f.made).toHaveLength(2)
      expect(asked.map(a => a.runId)).toEqual(f.made)
      expect(f.events.map(e => e[0])).toEqual(['start', 'end', 'start', 'end'])
    })

    it('a run context: forRun gets the context\'s own id; no containment: forRun gets null', () => {
      allowTestRun()
      const ctx = ctxOf()
      const f = forRunOf()
      runSync('python', ['gate.py'], { contained: ctx, timeoutMs: 1000, audit: f.audit }, { spawn: recorder().spawn })
      runSync('python', ['gate.py'], { timeoutMs: 1000, audit: f.audit }, { spawn: recorder().spawn })
      expect(f.made).toEqual([ctx.runId, null])
    })

    it('already low: no id is minted, forRun gets null, the command runs directly', () => {
      const f = forRunOf()
      const { calls, spawn } = recorder()
      runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') }, timeoutMs: 1000, audit: f.audit }, { spawn, ownLevel: () => 'low', establish: () => { throw new Error('must not be asked') } })
      expect(f.made).toEqual([null])
      expect(calls[0].cmd).toBe('python')
    })

    it('ECONTAINMENT and EAUDIT are unchanged under forRun', () => {
      const refusing = { src: 'gate', forRun: () => handleOf('the record of this call could not be written before it ran (audit-dir-missing)').handle }
      let established = 0
      const a = runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') }, timeoutMs: 1000, audit: refusing }, { spawn: () => { throw new Error('must not spawn') }, ownLevel: () => 'medium', establish: () => { established++; return { ok: false, reason: 'x' } } })
      expect(a).toEqual({ status: null, stdout: '', stderr: '[tool-audit] not run: the record of this call could not be written before it ran (audit-dir-missing)', elapsedMs: 0, timedOut: false, fault: { code: 'EAUDIT', status: null, signal: null, elapsedMs: 0 } })
      expect(established).toBe(0)
      const f = forRunOf()
      const b = runSync('python', ['gate.py'], { contained: { own: join(dir, 'base') }, timeoutMs: 1000, audit: f.audit }, { spawn: () => { throw new Error('must not spawn') }, ownLevel: () => 'medium', establish: () => ({ ok: false, reason: 'the sandbox root X is not an absolute path to an existing folder' }) })
      expect(b).toEqual({ status: null, stdout: '', stderr: '[spawn] REFUSED: containment: the sandbox root X is not an absolute path to an existing folder — nothing was run', elapsedMs: 0, timedOut: false, fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 } })
      expect(f.events.map(e => e[0])).toEqual(['start', 'end'])
    })

    // P5-C7 (wave 15): a contained call with an exact environment is refused before anything is made, so no
    // id is minted for it (its records would name a run with no containment record) and the integrity level is
    // not asked. The refusal itself is unchanged.
    it('a contained call with envExact: no id is minted, the level is not asked, the records carry null', async () => {
      for (const run of [
        (o, hk) => runSync('python', ['gate.py'], o, hk),
        (o, hk) => runAsync('python', ['gate.py'], o, hk),
      ]) {
        const f = forRunOf()
        let asked = 0, minted = 0
        const r = await run({ contained: { own: join(dir, 'base') }, envExact: true, env: { PATH: 'x' }, timeoutMs: 1000, audit: f.audit }, {
          spawn: () => { throw new Error('must not spawn') },
          ownLevel: () => { asked++; return 'medium' },
          mintRunId: () => { minted++; return 'grade-base-20261124T220000-ab12' },
          establish: () => { throw new Error('must not be asked') },
        })
        expect(r).toEqual({ status: null, stdout: '', stderr: '[spawn] REFUSED: containment: a contained command cannot take an exact environment — nothing was run', elapsedMs: 0, timedOut: false, fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 } })
        expect(f.made).toEqual([null])
        expect(asked).toBe(0)
        expect(minted).toBe(0)
        expect(f.events.map(e => e[0])).toEqual(['start', 'end'])
      }
    })

    // B5-1 (wave 15c): a run context's call with an exact environment is refused the same way, but it is made
    // inside a run that HAS a containment, so its records carry that run's id (`cynco-audit verify --run <id>`
    // finds the call). Only a call with no containment of its own carries null.
    it('a run context\'s call with envExact: the records carry the context\'s id, nothing is minted, the refusal is unchanged', async () => {
      for (const run of [
        (o, hk) => runSync('python', ['gate.py'], o, hk),
        (o, hk) => runAsync('python', ['gate.py'], o, hk),
      ]) {
        const f = forRunOf()
        let asked = 0, minted = 0
        const r = await run({ contained: { runId: 'mission-x' }, envExact: true, env: { PATH: 'x' }, timeoutMs: 1000, audit: f.audit }, {
          spawn: () => { throw new Error('must not spawn') },
          ownLevel: () => { asked++; return 'medium' },
          mintRunId: () => { minted++; return 'grade-base-20261124T220000-ab12' },
          establish: () => { throw new Error('must not be asked') },
        })
        expect(r).toEqual({ status: null, stdout: '', stderr: '[spawn] REFUSED: containment: a contained command cannot take an exact environment — nothing was run', elapsedMs: 0, timedOut: false, fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 } })
        expect(f.made).toEqual(['mission-x'])
        expect(asked).toBe(0)
        expect(minted).toBe(0)
        expect(f.events.map(e => e[0])).toEqual(['start', 'end'])
      }
    })
  })

})

// F242, slice S5 (03-audit-logs 2.17): the `audit` option. The command the caller asked for is
// recorded before it starts and its status after; a handle whose start refuses starts nothing and
// the result is fault EAUDIT. Absent, nothing changes (every case above runs without it).
describe('the audit option', () => {
  /** A stand-in handle that records the order of its calls. */
  const handleOf = (refuse = null) => {
    const events = []
    let n = 0
    return {
      events,
      handle: {
        start(rec) { events.push(['start', rec]); return refuse ? { ok: false, reason: refuse } : { ok: true, call: ++n } },
        end(call, rec) { events.push(['end', call, rec]) },
      },
    }
  }

  it('runSync: start before the spawn, end after it with the status', () => {
    const order = []
    const h = handleOf()
    const clock = clockOf()
    const spawn = (...args) => { order.push('spawn'); clock.t += 5; return { status: 3, stdout: 'o', stderr: 'e' } }
    const startSpy = h.handle.start
    h.handle.start = (rec) => { order.push('start'); return startSpy(rec) }
    const r = runSync('python', ['gate.py', '-q'], { cwd: '/w', timeoutMs: 1000, audit: { handle: h.handle, src: 'gate' } }, { spawn, now: () => clock.t })
    expect(r.status).toBe(3)
    expect(order).toEqual(['start', 'spawn'])
    expect(h.events[0]).toEqual(['start', { src: 'gate', command: 'python gate.py -q', cwd: '/w' }])
    expect(h.events[1]).toEqual(['end', 1, { isError: true, exitCode: 3, ms: 5, output: 'oe' }])
  })

  it('runSync with the F155 retry: two attempts give two start and end pairs', () => {
    const h = handleOf()
    const clock = clockOf()
    let calls = 0
    const spawn = () => { calls++; clock.t += 3; return calls === 1 ? ETIMEDOUT : { status: 0, stdout: 'ok', stderr: '' } }
    const r = runSync('bun', ['x.mjs'], { timeoutMs: 7_200_000, retryImpossibleTimeout: true, onStaleRetry: () => {}, audit: { handle: h.handle, src: 'gate' } }, { spawn, now: () => clock.t })
    expect(r.status).toBe(0)
    expect(h.events.map(e => e[0])).toEqual(['start', 'end', 'start', 'end'])
    expect(h.events[1][2]).toMatchObject({ isError: true, exitCode: null })
    expect(h.events[3]).toEqual(['end', 2, { isError: false, exitCode: 0, ms: 3, output: 'ok' }])
  })

  it('runAsync: start before the spawn, end in settle with the status', async () => {
    const h = handleOf()
    const order = []
    const startSpy = h.handle.start
    h.handle.start = (rec) => { order.push('start'); return startSpy(rec) }
    const spawn = () => {
      order.push('spawn')
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 7
      setTimeout(() => { child.stdout.emit('data', 'hi'); child.emit('close', 0, null) }, 5)
      return child
    }
    const r = await runAsync('python', ['gate.py'], { timeoutMs: 1000, audit: { handle: h.handle, src: 'driver-marker' } }, { spawn })
    expect(r.status).toBe(0)
    expect(order).toEqual(['start', 'spawn'])
    expect(h.events[1][0]).toBe('end')
    expect(h.events[1][2]).toMatchObject({ isError: false, exitCode: 0, output: 'hi' })
  })

  it('a handle whose start refuses: nothing is spawned, fault EAUDIT, not a timeout', async () => {
    const h = handleOf('the record of this call could not be written before it ran (audit-dir-missing)')
    let spawned = 0
    const r = runSync('python', ['gate.py'], { timeoutMs: 1000, retryImpossibleTimeout: true, audit: { handle: h.handle, src: 'gate' } }, { spawn: () => { spawned++; return { status: 0 } } })
    expect(r).toEqual({
      status: null, stdout: '', stderr: '[tool-audit] not run: the record of this call could not be written before it ran (audit-dir-missing)',
      elapsedMs: 0, timedOut: false, fault: { code: 'EAUDIT', status: null, signal: null, elapsedMs: 0 },
    })
    expect(faultSummary(r.fault)).toBe('code EAUDIT, status null, after 0 ms')
    const a = await runAsync('python', ['gate.py'], { timeoutMs: 1000, audit: { handle: h.handle, src: 'gate' } }, { spawn: () => { spawned++; return null } })
    expect(a.fault?.code).toBe('EAUDIT')
    expect(a.timedOut).toBe(false)
    expect(spawned).toBe(0)
    expect(h.events.every(e => e[0] === 'start')).toBe(true)
  })

  // Review of slice S5: a spawn that throws before any process exists (an argument it will not pass) does
  // not leave a start with no end; the throw goes on to the caller as before.
  it('runSync: a spawn that throws closes the start with an end, then throws', () => {
    const h = handleOf()
    const boom = new TypeError('The argument \'args[0]\' must be a string without null bytes')
    expect(() => runSync('python', ['a\u0000b'], { timeoutMs: 1000, audit: { handle: h.handle, src: 'gate' } }, { spawn: () => { throw boom } })).toThrow(boom)
    expect(h.events.map(e => e[0])).toEqual(['start', 'end'])
    expect(h.events[1][2]).toMatchObject({ isError: true, exitCode: null, ms: 0 })
    expect(h.events[1][2].output).toContain('null bytes')
  })

  it('a containment refusal after a written start closes the start with an end', () => {
    const SWITCH = 'LOCALCODE_CONTAINMENT_OFF'
    const before = process.env[SWITCH]
    process.env[SWITCH] = 'nonsense'
    const dir = mkdtempSync(join(tmpdir(), 'cynco-spawn-audit-'))
    try {
      const sandbox = { root: join(dir, 'run'), home: join(dir, 'run', 'home'), tmp: join(dir, 'run', 'tmp'), scratch: join(dir, 'run', 'scratch') }
      const ctx = testContainment({ missionCwd: join(dir, 'mission'), sandbox, home: join(dir, 'realhome'), folders: { state: dir, models: dir, guard: dir, audit: null } })
      const h = handleOf()
      const r = runSync('python', ['gate.py'], { contained: ctx, timeoutMs: 1000, audit: { handle: h.handle, src: 'gate' } }, { spawn: () => { throw new Error('must not spawn') } })
      expect(r.fault?.code).toBe('ECONTAINMENT')
      expect(h.events.map(e => e[0])).toEqual(['start', 'end'])
      expect(h.events[1][2]).toMatchObject({ isError: true, exitCode: null, ms: 0 })
    } finally {
      if (before === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = before
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runCheck and runCheckAsync with that fault: verified null, spawnFailed, and the harness-fault line names EAUDIT', async () => {
    const h = handleOf('the record of this call could not be written before it ran (audit-dir-missing)')
    const audit = { handle: h.handle, src: 'driver-probe' }
    const s = runCheck('echo x', tmpdir(), 30_000, { audit })
    const a = await runCheckAsync('echo x', tmpdir(), 30_000, { audit })
    for (const r of [s, a]) {
      expect(r.verified).toBeNull()
      expect(r.spawnFailed).toBe(true)
      expect(r.harnessFault).toContain('code EAUDIT')
      expect(r.output).toContain('[check] HARNESS FAULT: spawn failed: code EAUDIT')
    }
  })
})
