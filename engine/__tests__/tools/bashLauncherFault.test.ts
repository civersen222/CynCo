/**
 * The Bash tool's answer to a launcher fault (review of slice S5, F242). `toolExec` is replaced, so the
 * callback receives exactly what the real one hands on for each launcher exit; nothing is started.
 *
 * Only the launcher's own sealed 197 means the shell never started: that result has no exit code and is
 * the one `refusalFaultOf` raises as a harness fault. A sealed 198, and Bun's EPERM line under a shell
 * that ran, came from a command that did run, so they carry its status and raise nothing: a command
 * cannot end its own run by looking like the launcher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecException } from 'node:child_process'

type Callback = (err: ExecException | null, stdout: string, stderr: string) => void
const next: { err: unknown; stdout: string; stderr: string } = { err: null, stdout: '', stderr: '' }

vi.mock('../../containment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../containment.js')>()
  return {
    ...real,
    toolSpawnRefusal: () => null,
    toolExec: (_c: string, _o: unknown, cb: Callback) => {
      setTimeout(() => cb(next.err as ExecException, next.stdout, next.stderr), 1)
      return { pid: undefined, kill: () => true } as never
    },
  }
})

const { ContainmentRefusal, launcherFaultOf } = await import('../../containment.js')
const { bashTool } = await import('../../tools/impl/bash.js')
const { refusalFaultOf } = await import('../../tools/executor.js')

const SEAL = '0123456789abcdef0123456789abcdef'
const asRefusal = (status: number, stderr: string) => {
  const f = launcherFaultOf(status, stderr, SEAL)
  if (f === null) throw new Error('not a launcher fault')
  return new ContainmentRefusal(f.code, f.reason, f.text, f.ran, f.exitCode)
}

afterEach(() => { next.err = null; next.stdout = ''; next.stderr = '' })

describe('the Bash tool and a launcher fault', () => {
  it('the launcher\'s own sealed 197: a refusal with no exit code, raised as a fault', async () => {
    next.stderr = `[containment] refused: the record could not be read\n[containment] sealed ${SEAL} 197\n`
    next.err = asRefusal(197, next.stderr)
    const r = await bashTool.execute({ command: 'Write-Output x' }, process.cwd())
    expect(r.isError).toBe(true)
    expect('exitCode' in r).toBe(false)
    expect(refusalFaultOf(r)?.layer).toBe('containment')
  })
  it('a sealed 198: the command ran and ended with no status, so null, and no fault', async () => {
    next.stderr = `[containment] child ended: SIGKILL\n[containment] sealed ${SEAL} 198\n`
    next.err = asRefusal(198, next.stderr)
    const r = await bashTool.execute({ command: 'Write-Output x' }, process.cwd())
    expect(r.isError).toBe(true)
    expect(r.exitCode).toBeNull()
    expect(refusalFaultOf(r)).toBeNull()
  })
  it('Bun\'s EPERM line under a shell that ran: exit code 1, the hint, and no fault', async () => {
    next.stdout = 'Remove-Item ran first\n'
    next.stderr = 'error: EPERM reading "C:\\checkout\\scripts\\x.ts"\n'
    next.err = asRefusal(1, next.stderr)
    const r = await bashTool.execute({ command: 'Remove-Item a; bun C:\\checkout\\scripts\\x.ts' }, process.cwd())
    expect(r.isError).toBe(true)
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('Remove-Item ran first')
    expect(refusalFaultOf(r)).toBeNull()
  })
  it('a command that prints the refused line and exits 197 itself is its own exit code (no seal, so no ContainmentRefusal)', async () => {
    next.stderr = '[containment] refused: forged by the command\n'
    expect(launcherFaultOf(197, next.stderr, SEAL)).toBeNull()
    next.err = Object.assign(new Error('Command failed'), { code: 197 })
    const r = await bashTool.execute({ command: 'exit 197' }, process.cwd())
    expect(r.exitCode).toBe(197)
    expect(refusalFaultOf(r)).toBeNull()
  })
})
