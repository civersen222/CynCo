import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-ignore — untyped harness module
import { runCheck } from '../../../scripts/cynco-verify.mjs'

// process.execPath is the current JS runtime (node under vitest, bun under
// Bun) — both support -e. Quoted for paths with spaces. runCheck (F146) now
// runs in the engine's real shell (PowerShell on win32), which parses a
// quoted path as a string expression rather than a command unless the call
// operator `&` precedes it — cmd.exe (the old `shell: true` default) needed
// no such thing, so this only matters now.
const RUNTIME = process.platform === 'win32' ? `& "${process.execPath}"` : `"${process.execPath}"`

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
    expect(r.harnessFault).toMatch(/timed out after/)
  })

  it('spawn failure → verified null (UNMEASURED), spawnFailed flag', () => {
    // A cwd that does not exist fails the spawn itself, so the check never
    // ran and cannot have an opinion about the delivery.
    const r = runCheck(`${RUNTIME} -e "process.exit(0)"`,
      join(process.cwd(), 'no-such-directory-a7f3c1'), 30000)
    expect(r.verified).toBeNull()
    expect(r.spawnFailed).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.harnessFault).toMatch(/spawn failed:/)
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

  // F146: liftEnvPrefix used to do this by lifting the prefix into the child's
  // env itself; now the SAME engine shell that runs the check (getShellInfo +
  // translateEnvPrefix) does the translation, so these are behaviour tests of
  // runCheck rather than of a helper it no longer has.
  it('lifts several prefixed vars and passes both through to the child', () => {
    const r = runCheck(
      `FOO=bar BAZ=two ${RUNTIME} -e "console.log('FOO=' + process.env.FOO + ' BAZ=' + process.env.BAZ); process.exit(0)"`,
      process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.harnessFault).toBeNull()
    expect(r.outputTail).toContain('FOO=bar BAZ=two')
  })

  it('leaves a command with no prefix untouched', () => {
    const r = runCheck(`${RUNTIME} -e "console.log('plain ok'); process.exit(0)"`, process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.harnessFault).toBeNull()
    expect(r.outputTail).toContain('plain ok')
  })

  // An `=` inside an argument (not at the head of the command) is not an
  // assignment prefix and must reach the child unchanged.
  it('does not mistake a flag with = for an env assignment', () => {
    const r = runCheck(
      `${RUNTIME} -e "console.log(process.argv[1]); process.exit(0)" -- --base=a4dda4c`,
      process.cwd(), 30000)
    expect(r.verified).toBe(true)
    expect(r.harnessFault).toBeNull()
    expect(r.outputTail).toContain('--base=a4dda4c')
  })

  it('runs in the given cwd', () => {
    const r = runCheck(`${RUNTIME} -e "console.log(process.cwd())"`, process.cwd(), 30000)
    // Normalize slashes — Windows spawnSync reports backslashes.
    expect(r.outputTail.replace(/\\/g, '/')).toContain(process.cwd().replace(/\\/g, '/'))
  })

  // F146: `shell: true` was cmd.exe on Windows, which does not expand
  // `test_c8_*.py` — the SAME glob the model's own shell (PowerShell/bash)
  // expands without issue, so the check answered a question the mission never
  // asked. runCheck must use the engine's own shell (getShellInfo), the same
  // one the model and the contract runner use.
  it("expands a glob the way the model's shell does", () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'))
    writeFileSync(join(dir, 'test_a.txt'), 'x')
    // PowerShell and bash both expand this; cmd.exe does not.
    const r = runCheck(
      process.platform === 'win32'
        ? 'Get-ChildItem test_*.txt | Measure-Object | ForEach-Object { if ($_.Count -eq 1) { exit 0 } else { exit 3 } }'
        : 'ls test_*.txt',
      dir, 20000)
    expect(r.harnessFault).toBeNull()
    expect(r.exitCode).toBe(0)
    expect(r.verified).toBe(true)
  })

  // A pytest usage error (exit 4) or "no tests collected" (exit 5) means the
  // CHECK ITSELF is wrong — a path did not resolve — not that the delivery
  // failed. That is a fact about the harness, so it must be `verified: null`,
  // the same as a timeout or a spawn failure, and never a plausible-looking
  // `false` that reads as a real measurement in the ledger.
  it('records a pytest usage error as a harness fault, not a delivery failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'))
    const r = runCheck('python -m pytest does_not_exist_*.py -q', dir, 60000)
    expect(r.exitCode).toBe(4)
    expect(r.verified).toBeNull()
    expect(r.harnessFault).toMatch(/pytest usage error/)
  })

  it('a real failing check is still verified:false, not a harness fault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'))
    const r = runCheck('exit 1', dir, 20000)
    expect(r.verified).toBe(false)
    expect(r.harnessFault).toBeNull()
  })
})
