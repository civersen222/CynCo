import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-ignore — untyped harness module
import { runCheck, liftEnvPrefix } from '../../../scripts/cynco-verify.mjs'

// process.execPath is the current JS runtime (node under vitest, bun under
// Bun) — both support -e. Quoted for paths with spaces.
const RUNTIME = `"${process.execPath}"`

describe('cynco mission check runner (Phase 2b)', () => {
  it('exit code 0 → verified true, exitCode 0, output captured', () => {
    const r = runCheck(`${RUNTIME} -e "console.log('smoke ok'); process.exit(0)"`, process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.outputTail).toContain('smoke ok')
    expect(typeof r.durationMs).toBe('number')
  })

  it('nonzero exit → verified false with the real exit code', () => {
    const r = runCheck(`${RUNTIME} -e "console.error('3 tests failed'); process.exit(3)"`, process.cwd(), 30000)
    expect(r.verified).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.outputTail).toContain('3 tests failed')
  })

  // A timeout is a fact about the harness, not about the delivery. Recording
  // it as `false` puts a measurement in the ledger that was never taken.
  it('timeout → verified null (UNMEASURED), exitCode null, timedOut flag', () => {
    const r = runCheck(`${RUNTIME} -e "setTimeout(() => {}, 60000)"`, process.cwd(), 1500)
    expect(r.verified).toBeNull()
    expect(r.verified).not.toBe(false)
    expect(r.exitCode).toBeNull()
    expect(r.timedOut).toBe(true)
  })

  it('spawn failure → verified null (UNMEASURED), spawnFailed flag', () => {
    // A cwd that does not exist fails the spawn itself, so the check never
    // ran and cannot have an opinion about the delivery.
    const r = runCheck(`${RUNTIME} -e "process.exit(0)"`,
      join(process.cwd(), 'no-such-directory-a7f3c1'), 30000)
    expect(r.verified).toBeNull()
    expect(r.spawnFailed).toBe(true)
    expect(r.timedOut).toBe(false)
  })

  it('a check that answered "no" is still false, not null', () => {
    const r = runCheck(`${RUNTIME} -e "process.exit(1)"`, process.cwd(), 30000)
    expect(r.verified).toBe(false)
    expect(r.verified).not.toBeNull()
    expect(r.timedOut).toBe(false)
    expect(r.spawnFailed).toBe(false)
  })

  it('output tail is bounded to 2000 chars', () => {
    const r = runCheck(`${RUNTIME} -e "process.stdout.write('x'.repeat(10000))"`, process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.outputTail.length).toBeLessThanOrEqual(2000)
  })

  // The engine's contract runner accepts a POSIX env prefix, so a check that
  // carries one must not be refused by the driver for how it reads. cmd.exe
  // answers `'CHK10_BASE' is not recognized` in ~20ms, which the ledger then
  // records as verified:false for a gate that never ran.
  it('a POSIX env prefix reaches the child as an env var, not as a command', () => {
    const r = runCheck(
      `CHK_PROBE=a4dda4c ${RUNTIME} -e "console.log('base=' + process.env.CHK_PROBE); process.exit(process.env.CHK_PROBE === 'a4dda4c' ? 0 : 9)"`,
      process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.outputTail).toContain('base=a4dda4c')
    expect(r.outputTail).not.toContain('not recognized')
  })

  it('lifts several prefixed vars and leaves the rest of the command alone', () => {
    const { command, env } = liftEnvPrefix('A=1 B="two words" python gate.py --x', { PATH: 'p' })
    expect(command).toBe('python gate.py --x')
    expect(env.A).toBe('1')
    expect(env.B).toBe('two words')
    expect(env.PATH).toBe('p')
  })

  it('leaves a command with no prefix untouched and inherits env', () => {
    const { command, env } = liftEnvPrefix('python gate.py', { PATH: 'p' })
    expect(command).toBe('python gate.py')
    expect(env).toBeNull()
  })

  // An `=` inside an argument is not an assignment prefix.
  it('does not mistake a flag with = for an env assignment', () => {
    const { command, env } = liftEnvPrefix('python gate.py --base=a4dda4c', {})
    expect(command).toBe('python gate.py --base=a4dda4c')
    expect(env).toBeNull()
  })

  it('runs in the given cwd', () => {
    const r = runCheck(`${RUNTIME} -e "console.log(process.cwd())"`, process.cwd(), 30000)
    // Normalize slashes — Windows spawnSync reports backslashes.
    expect(r.outputTail.replace(/\\/g, '/')).toContain(process.cwd().replace(/\\/g, '/'))
  })
})
