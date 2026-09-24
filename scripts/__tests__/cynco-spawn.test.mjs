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
import { runSync, faultSummary, TIMEOUT_ELAPSED_FRACTION } from '../cynco-spawn.mjs'

/** A spawnSync stand-in: returns `result`, and advances the injected clock by `ms`. */
const fakeSpawn = (result, ms, clock) => (...args) => { clock.t += ms; return { ...result, _args: args } }

const clockOf = () => ({ t: 1_000_000 })

describe('runSync: a timeout is an elapsed measurement', () => {
  it('calls an early ETIMEDOUT a harness fault, not a timeout', () => {
    const clock = clockOf()
    const r = runSync('python', ['gate.py'], { timeoutMs: 7_200_000 }, {
      spawn: fakeSpawn({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, 7, clock),
      now: () => clock.t,
    })
    expect(r.timedOut).toBe(false)
    expect(r.elapsedMs).toBe(7)
    expect(r.fault).toEqual({ code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 7 })
    expect(faultSummary(r.fault)).toBe('code ETIMEDOUT, status null, after 7 ms')
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
