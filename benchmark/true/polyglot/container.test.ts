// benchmark/true/polyglot/container.test.ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureImage, startContainer, stopContainer, execInContainer, isEnvFailure, ImageBuildTimeout, type ExecResult } from './container.js'

const dockerPresent = spawnSync('docker', ['version'], { encoding: 'utf-8' }).status === 0

const res = (over: Partial<ExecResult>): ExecResult => ({
  code: 1, output: 'FAILED test_x', timedOut: false, durationMs: 1000, ...over,
})

// Pure taxonomy tests — no docker needed.
describe('isEnvFailure', () => {
  it('a normal test failure is a model failure, not env', () => {
    expect(isEnvFailure(res({}))).toBe(false)
  })

  it('flags timeouts', () => {
    expect(isEnvFailure(res({ timedOut: true }))).toBe(true)
  })

  it('flags docker exit codes 125/126/127', () => {
    for (const code of [125, 126, 127]) expect(isEnvFailure(res({ code }))).toBe(true)
  })

  it('flags a docker CLI that produced no exit code (signal-kill / spawn failure)', () => {
    // Observed live: signal-killed docker exec -> status null -> code -1,
    // 8ms verdict recorded as a clean model failure. Must be env.
    expect(isEnvFailure(res({ code: -1, output: '', durationMs: 4 }))).toBe(true)
  })

  it('flags infra markers in output', () => {
    expect(isEnvFailure(res({ output: 'bash: go: command not found' }))).toBe(true)
    expect(isEnvFailure(res({ output: 'Error: No such container: polyglot-bench-run' }))).toBe(true)
    expect(isEnvFailure(res({ output: 'error during connect: daemon not running' }))).toBe(true)
  })
})

// The build is the one step here that waits on the network (apt, NodeSource,
// rustup) and it ran with no bound: on 2026-11-10 `apt` stalled 1,902 s and the
// build took 2,469 s, which this test's own deadline could not interrupt
// because `spawnSync` blocks the thread the deadline runs on. No docker needed.
describe('ensureImage bounds the build', () => {
  type Call = { args: string[]; timeout: number | undefined }
  const fakeDocker = (inspectStatus: number, build: { status: number | null; error?: Error }) => {
    const calls: Call[] = []
    const run = ((_cmd: string, args: string[], opts: { timeout?: number }) => {
      calls.push({ args, timeout: opts?.timeout })
      if (args[0] === 'image') return { status: inspectStatus }
      return build
    }) as any
    return { calls, run }
  }
  const timedOut = { status: null, error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }) }

  it('an image that exists is not built', () => {
    const d = fakeDocker(0, { status: 0 })
    ensureImage('dir', { buildTimeoutMs: 1000, run: d.run })
    expect(d.calls.map(c => c.args[0])).toEqual(['image'])
  })

  it('the build gets the bound it was given, and a build with no bound asked for has none', () => {
    const bounded = fakeDocker(1, { status: 0 })
    ensureImage('dir', { buildTimeoutMs: 480_000, run: bounded.run })
    expect(bounded.calls.find(c => c.args[0] === 'build')?.timeout).toBe(480_000)
    const unbounded = fakeDocker(1, { status: 0 })
    ensureImage('dir', { run: unbounded.run })
    expect(unbounded.calls.find(c => c.args[0] === 'build')?.timeout).toBeUndefined()
  })

  it('a build that outlives its bound is an ImageBuildTimeout that says how long it was given', () => {
    const d = fakeDocker(1, timedOut)
    expect(() => ensureImage('dir', { buildTimeoutMs: 480_000, run: d.run })).toThrow(ImageBuildTimeout)
    expect(() => ensureImage('dir', { buildTimeoutMs: 480_000, run: d.run })).toThrow(/480 s/)
  })

  it('a build that fails is not a timeout: a broken Dockerfile stays an error', () => {
    const d = fakeDocker(1, { status: 1 })
    let err: unknown
    try { ensureImage('dir', { buildTimeoutMs: 480_000, run: d.run }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ImageBuildTimeout)
    expect(String((err as Error).message)).toMatch(/docker build failed \(exit 1\)/)
  })
})

/** What the lifecycle test gives the build. A cold build on the CI runner takes two to three minutes. */
const BUILD_BOUND_MS = 480_000

// Live integration test — same gating style as other docker/live suites.
describe.skipIf(!dockerPresent)('container lifecycle', () => {
  it('builds image, starts, execs a test command in a mounted workdir, stops', (ctx) => {
    try {
      ensureImage(import.meta.dirname, { buildTimeoutMs: BUILD_BOUND_MS })
    } catch (e) {
      // A stalled package mirror is not a defect in this repository. A build
      // that FAILS (a broken Dockerfile) is rethrown and stays red.
      if (!(e instanceof ImageBuildTimeout)) throw e
      console.warn(`[polyglot] SKIPPED, not passed: ${e.message}`)
      ctx.skip()
      return
    }
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-ct-'))
    const work = join(scratch, 'python-demo')
    mkdirSync(work)
    writeFileSync(join(work, 'demo_test.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
    startContainer(scratch)
    try {
      const ok = execInContainer('python-demo', 'python3 -m pytest -x -q', 60_000)
      expect(ok.code).toBe(0)
      expect(ok.timedOut).toBe(false)
      const fail = execInContainer('python-demo', 'python3 -m pytest -x -q --nonexistent-flag', 60_000)
      expect(fail.code).not.toBe(0)
      expect(fail.output.length).toBeGreaterThan(0)
    } finally {
      stopContainer()
    }
  }, 900_000) // first image build can take many minutes
})
