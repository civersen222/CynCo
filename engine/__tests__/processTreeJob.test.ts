/**
 * The Job Object path of `ownProcessTree`, run the way the engine runs: under
 * Bun, inside the engine's own kill-on-close job (F209).
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bunPresent = spawnSync('bun', ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' }).status === 0
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

describe.skipIf(process.platform !== 'win32' || !bunPresent)('ownProcessTree under Bun on Windows', () => {
  it('a tree that is still starting children when it is killed leaves no survivor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tree-burst-'))
    dirs.push(dir)
    const run = spawnSync('bun', ['engine/__tests__/fixtures/ownedTreeBurst.ts', dir, 'own'], { encoding: 'utf-8', shell: true, timeout: 50_000 })
    expect(run.status, `the fixture failed:\n${run.stdout}\n${run.stderr}`).toBe(0)
    const report = JSON.parse(run.stdout.trim().split('\n').pop()!)

    expect(report.kind, 'the handle fell back instead of taking a Job Object').toBe('job')
    expect(report.engineJob, 'the engine\'s own job must be installed, as in main.ts: the command\'s job nests inside it').toBe(true)
    expect(report.startedAtKill, 'the shell had not started any child when it was killed').toBeGreaterThan(3)
    expect(report.startedAtKill, 'the shell had finished starting children: nothing was mid-start at the kill').toBeLessThan(report.children)
    expect(report.survivors, 'a child outlived the kill').toBe(0)
  }, 60_000)
})
