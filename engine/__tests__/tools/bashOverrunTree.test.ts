/**
 * The Bash tool's output overrun ends the process tree it owns (wave 19, from the harness-children builder: on
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` exec ends the shell alone, and the tool released its handle, so what the shell
 * had started ran on).
 *
 * Two cases. Under vitest's Node, with `ownProcessTree` wrapped: an overrun calls the owned tree's `kill`, never its
 * `release`, on every platform (Node has no Job Object, and a kill that walks the tree after exec has ended its root
 * finds nothing, so the real kill is shown under Bun). Under Bun on Windows (`fixtures/bashOverrunTree.ts`): a child
 * the shell started before printing 3 MiB is gone a second after the answer.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const trees: Array<{ killed: number; released: number }> = []
// 19b, C19-8: the kind the wrapped tree reports. Under vitest's Node the real kind is 'walk' everywhere (no Job
// Object); a case sets 'job' to show the Job Object branch, and then the real tree is only released (a kill that walks
// from a reaped root could signal a pid that was reused meanwhile).
let fakeKind: 'job' | 'walk' | null = null
vi.mock('../../processTree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../processTree.js')>()
  return {
    ...real,
    // Wave 24: the Bash tool hands the started process (a `TreeRoot`), no longer its pid; either is passed on as given.
    ownProcessTree: (root: Parameters<typeof real.ownProcessTree>[0]) => {
      const inner = real.ownProcessTree(root)
      const seen = { killed: 0, released: 0 }
      trees.push(seen)
      const kind = fakeKind ?? inner.kind
      return {
        kind,
        kill: async () => { seen.killed++; if (kind === inner.kind) await inner.kill(); else inner.release() },
        release: () => { seen.released++; inner.release() },
      }
    },
  }
})
// A spawn that fails before any process exists throws inside `toolExec` (spawn: ENAMETOOLONG, measured on Windows for
// a command over 32,700 characters). The marker makes the wrapped `toolExec` throw as the real one does.
const THROW_MARKER = 'CYNCO-TEST-SPAWN-THROWS-'
vi.mock('../../containment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../containment.js')>()
  return {
    ...real,
    toolExec: (...args: Parameters<typeof real.toolExec>) => {
      // 19b, C19-4: the containment's own refusal thrown before anything starts (`refuseBeforeSpawn`).
      if (String(args[0]).includes('CYNCO-TEST-SPAWN-REFUSED')) {
        throw new real.ContainmentRefusal('ECONTAINMENT', 'the test refuses this start', real.refusalText('containment', 'the test refuses this start'))
      }
      const m = String(args[0]).match(/CYNCO-TEST-SPAWN-THROWS-(\w+)/)
      if (m) throw Object.assign(new Error(`spawn ${m[1]}`), { code: m[1], syscall: 'spawn' })
      return real.toolExec(...args)
    },
  }
})
const { bashTool } = await import('../../tools/impl/bash.js')
const { getShellInfo } = await import('../../tools/shellInfo.js')
const { refusalFaultOf } = await import('../../tools/executor.js')
const { refusalPrefix } = await import('../../containment.js')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

describe('the Bash tool on an output overrun', () => {
  const big = () => getShellInfo().isPowerShell ? "'y' * 3145728" : "head -c 3145728 /dev/zero | tr '\\0' y"

  // Wave 19 pinned a kill on every platform. 19b, C19-8, on purpose: the kill is right only for a Job Object, which
  // ends what is in the job whatever happened to its root; a walked tree is found from its root, which exec has already
  // ended and reaped, so the walk finds nothing and its signal could reach a pid that was reused. So: job, kill.
  it('kills the tree it owns instead of releasing it, when the tree is a Job Object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bash-overrun-'))
    dirs.push(dir)
    fakeKind = 'job'
    try {
      trees.length = 0
      const r = await bashTool.execute({ command: big(), timeout: 60_000 }, dir)
      expect(r.isError).toBe(true)
      expect(trees.length).toBe(1)
      expect(trees[0]).toEqual({ killed: 1, released: 0 })
      // A command that ends on its own still gives the handle back and kills nothing.
      trees.length = 0
      await bashTool.execute({ command: 'echo small', timeout: 60_000 }, dir)
      expect(trees[0]).toEqual({ killed: 0, released: 1 })
    } finally {
      fakeKind = null
    }
  }, 60_000)

  it('releases a walked tree on an overrun instead of signalling from its reaped root (19b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bash-overrun-walk-'))
    dirs.push(dir)
    fakeKind = 'walk'
    try {
      trees.length = 0
      const r = await bashTool.execute({ command: big(), timeout: 60_000 }, dir)
      expect(r.isError).toBe(true)
      expect(trees.length).toBe(1)
      expect(trees[0]).toEqual({ killed: 0, released: 1 })
    } finally {
      fakeKind = null
    }
  }, 60_000)
})

describe('the Bash tool when its shell cannot be started', () => {
  it('answers by name, with no exit code, instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bash-nospawn-'))
    dirs.push(dir)
    const long = await bashTool.execute({ command: `echo ${THROW_MARKER}ENAMETOOLONG`, timeout: 60_000 }, dir)
    expect(long.isError).toBe(true)
    expect(long.output).toContain('longer than one command line carries (ENAMETOOLONG)')
    expect('exitCode' in long).toBe(false)
    const other = await bashTool.execute({ command: `echo ${THROW_MARKER}EACCES`, timeout: 60_000 }, dir)
    expect(other.isError).toBe(true)
    expect(other.output).toContain('the shell could not be started (spawn EACCES)')
    expect('exitCode' in other).toBe(false)
  }, 60_000)

  // 19b, C19-4: a containment refusal thrown at the start is answered with its own text, so the executor raises it
  // as the containment fault it is (it used to read 'the shell could not be started (Refused [containment]: ...)').
  // Linux: the wrapped toolExec throws the same object there; nothing here depends on the shell.
  it('answers a containment refusal thrown at the start with its own text, which the executor raises', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bash-refused-'))
    dirs.push(dir)
    const r = await bashTool.execute({ command: 'echo CYNCO-TEST-SPAWN-REFUSED', timeout: 60_000 }, dir)
    expect(r.isError).toBe(true)
    expect(r.output.startsWith(refusalPrefix('containment')), r.output).toBe(true)
    expect('exitCode' in r).toBe(false)
    const fault = refusalFaultOf(r)
    expect(fault?.layer).toBe('containment')
    expect(fault?.reason.startsWith('the test refuses this start')).toBe(true)
  }, 60_000)
})

// Bun's own executable, found once through the shell (on this PC `bun` on PATH is npm's shim), as processTreeJob.test.ts does.
function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: process.platform === 'win32', windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}
const bunExe = process.platform === 'win32' ? findBunExe() : null

describe.skipIf(process.platform !== 'win32' || bunExe === null)('the Bash tool on an output overrun, under Bun on Windows', () => {
  it('a child the shell started is gone after 3 MiB of output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bash-overrun-tree-'))
    dirs.push(dir)
    const run = spawnSync(bunExe!, ['--no-install', 'engine/__tests__/fixtures/bashOverrunTree.ts', dir], { encoding: 'utf-8', windowsHide: true, timeout: 90_000 })
    expect(run.status, `the fixture failed:\n${run.stdout}\n${run.stderr}`).toBe(0)
    const report = JSON.parse(run.stdout.trim().split('\n').pop()!)
    expect(report.engineJob?.installed, `the engine's own job must be installed, as in main.ts: ${JSON.stringify(report)}`).toBe(true)
    // Wave 24 (F255): the child is asked about by a mark in its command line. The control is the same command
    // without the overrun: its child runs on and the mark finds it, so a "gone" below is not a mark that finds nothing.
    expect(report.control?.isError, JSON.stringify(report)).toBe(false)
    expect(report.control?.pid, JSON.stringify(report)).toBeGreaterThan(0)
    expect(report.control?.aliveAfter, `the control's child ${report.control?.pid} was not found running by its mark: ${JSON.stringify(report)}`).toBe(true)
    expect(report.isError).toBe(true)
    expect(report.pid).toBeGreaterThan(0)
    expect(report.aliveAfter, `the child ${report.pid} outlived the overrun`).toBe(false)
  }, 120_000)
})
