// benchmark/true/polyglot/container.test.ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureImage, startContainer, stopContainer, execInContainer, isEnvFailure, type ExecResult } from './container.js'

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

// Live integration test — same gating style as other docker/live suites.
describe.skipIf(!dockerPresent)('container lifecycle', () => {
  it('builds image, starts, execs a test command in a mounted workdir, stops', () => {
    ensureImage(import.meta.dirname)
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
