// F155. The two readings that must never be confused: a run that spent the cap,
// and a run the harness failed to make. `spawnSync` reports both as
// `error.code === 'ETIMEDOUT'` under bun on Windows, because its timeout
// deadline is measured from the PREVIOUS spawn in the same process — the
// reviewer's reproduction, one process: warmup 36 ms normal, then after a 12 s
// gap a spawn killed in 7 ms with ETIMEDOUT and empty output, then the two
// spawns behind it normal. The live C9 authoring runner's previous spawn was
// four hours earlier, so its gate at BASE died in milliseconds and eleven
// problems were recorded against a triple that had two.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSync, faultSummary, TIMEOUT_ELAPSED_FRACTION, bashBin, gitExeOnPath, bashExe } from '../cynco-spawn.mjs'

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
    expect(grade.match(/retryImpossibleTimeout: true/g) ?? []).toHaveLength(2)
    expect(/\[spec\.gate\][\s\S]{0,200}retryImpossibleTimeout: true/.test(grade)).toBe(true)
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
    expect(campaign).toMatch(/dispatchEnv\(waveEnvBase\(spec\)/)
    // I3: both dispatches (wave and authoring) go through the one runDispatch,
    // whose spawn is runSync WITHOUT retryImpossibleTimeout.
    expect(campaign.match(/\['scripts\/dispatch-mission\.sh'/g)?.length).toBe(1)
    const dispatchCall = campaign.split('\n').find(l => l.includes("['scripts/dispatch-mission.sh'"))
    expect(dispatchCall).toMatch(/runSync\(bash \?\? bashExe\(\), \['scripts\/dispatch-mission\.sh'/)
    expect(dispatchCall).not.toMatch(/retryImpossibleTimeout/)
    expect(campaign.match(/\brunDispatch\(\[/g)?.length).toBe(2)
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
