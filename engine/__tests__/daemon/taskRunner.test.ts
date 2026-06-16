// engine/__tests__/daemon/taskRunner.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskRunner, isGpuBusy } from '../../daemon/taskRunner.js'
import type { TaskFileInput } from '../../daemon/types.js'

const STUB = join(import.meta.dirname, 'fixtures', 'stubEngine.mjs')

function makeInput(dir: string, prompt: string): TaskFileInput {
  return {
    missionId: 'm1', triggerId: 't1', prompt, context: 'ctx',
    allowedTools: ['Mfl'], timeoutMs: 3000, outcomePath: join(dir, 'out.json'),
  }
}

describe('TaskRunner', () => {
  it('runs the engine and returns the outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(true)
      expect(outcome.summary).toContain('stub ran for m1')
      expect(outcome.recommendations.length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('kills a hung engine at timeoutMs and reports failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const input = { ...makeInput(dir, 'HANG please'), timeoutMs: 1500 }
      const started = Date.now()
      const outcome = await runner.run(input)
      expect(Date.now() - started).toBeLessThan(10000)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/timeout/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 15000)

  it('reports failure when the engine crashes without an outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const outcome = await runner.run(makeInput(dir, 'CRASH now'))
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toMatch(/exit|missing/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('strips CYNCO_NTFY_* env so the one-shot engine cannot act as the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    process.env.CYNCO_NTFY_TOKEN = 'tk_leak_test'
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
      })
      const outcome = await runner.run(makeInput(dir, 'ECHO_ENV'))
      expect(outcome.ok).toBe(true)
      expect(outcome.summary).not.toContain('CYNCO_NTFY_TOKEN')
    } finally {
      delete process.env.CYNCO_NTFY_TOKEN
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws GpuBusyError when the GPU is busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => true,
      })
      await expect(runner.run(makeInput(dir, 'x'))).rejects.toThrow(/gpu busy/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('isGpuBusy', () => {
  const noGpuApps = async () => ''
  it('detects llama-server in the process list', async () => {
    expect(await isGpuBusy(async () => 'bun.exe\nllama-server.exe\n', noGpuApps)).toBe(true)
  })
  it('returns false when no llama-server is running', async () => {
    expect(await isGpuBusy(async () => 'explorer.exe\ncode.exe\n', noGpuApps)).toBe(false)
  })
  it('returns false when the process list is unavailable', async () => {
    expect(await isGpuBusy(async () => { throw new Error('no tasklist') }, noGpuApps)).toBe(false)
  })
  it('nvidia-smi: a compute app holding serious VRAM means busy even when tasklist is clean (spec §2)', async () => {
    const queryGpu = async () => '12345, 21504\n' // pid, used MiB
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu)).toBe(true)
  })
  it('nvidia-smi: small compute apps (browsers etc.) do not count as busy', async () => {
    const queryGpu = async () => '901, 350\n1402, 512\n'
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu)).toBe(false)
  })
  it('nvidia-smi unavailable falls back to the tasklist heuristic alone', async () => {
    const queryGpu = async () => { throw new Error('nvidia-smi not found') }
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu)).toBe(false)
    expect(await isGpuBusy(async () => 'llama-server\n', queryGpu)).toBe(true)
  })
})
