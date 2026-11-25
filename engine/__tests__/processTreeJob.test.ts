/**
 * The Job Object path of `ownProcessTree`, run the way the engine runs: under
 * Bun, inside the engine's own kill-on-close job (F210).
 *
 * `fixtures/ownedTreeBurst.ts` starts a shell that starts children as fast as
 * it can and kills the tree while it is still doing so. That is the case a
 * kill that finds the tree when it happens cannot win: measured 2026-11-11
 * with a burst of node children, `taskkill /F /T` left 32, 34 and 50 of the
 * started children running in three runs; the job left none and took 4 ms.
 *
 * Windows only (the Job Object is a Windows thing), and only where `bun` is
 * on the PATH, as the other tests that start an engine assume.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Bun is found through the shell once (on this PC `bun` on PATH is npm's bun.cmd shim) and asked for
// its own executable, which the fixture is then started with directly, as hostResources.test.ts does.
// Started through the shell, the timeout below killed cmd.exe alone and left bun.exe and what it had
// started running (F210; NOW.md, 2026-11-24). The lookup has a timeout of its own.
function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: process.platform === 'win32', windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}
const bunExe = process.platform === 'win32' ? findBunExe() : null
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

describe.skipIf(process.platform !== 'win32' || bunExe === null)('ownProcessTree under Bun on Windows', () => {
  it('a tree that is still starting children when it is killed leaves no survivor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tree-burst-'))
    dirs.push(dir)
    const run = spawnSync(bunExe!, ['engine/__tests__/fixtures/ownedTreeBurst.ts', dir, 'own'], { encoding: 'utf-8', windowsHide: true, timeout: 50_000 })
    expect(run.status, `the fixture failed:\n${run.stdout}\n${run.stderr}`).toBe(0)
    const report = JSON.parse(run.stdout.trim().split('\n').pop()!)

    expect(report.kind, 'the handle fell back instead of taking a Job Object').toBe('job')
    expect(report.engineJob, 'the engine\'s own job must be installed, as in main.ts: the command\'s job nests inside it').toBe(true)
    expect(report.startedAtKill, 'the shell had not started any child when it was killed').toBeGreaterThan(3)
    expect(report.startedAtKill, 'the shell had finished starting children: nothing was mid-start at the kill').toBeLessThan(report.children)
    expect(report.survivors, 'a child outlived the kill').toBe(0)
  }, 60_000)
})
