// engine/__tests__/daemon/taskRunner.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskRunner, isGpuBusy } from '../../daemon/taskRunner.js'
import type { TaskFileInput } from '../../daemon/types.js'
import { ActivityRegistry } from '../../power/activity.js'

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
  // Every probe is injected: the real port probe would see whatever model server this machine is running.
  const noServer = async () => false
  it('a model server answering on the engine port means busy even when tasklist and nvidia-smi miss it (2026-10-28: the daemon killed a live hand-started run)', async () => {
    expect(await isGpuBusy(async () => 'explorer.exe\n', noGpuApps, async () => true)).toBe(true)
    expect(await isGpuBusy(async () => { throw new Error('tasklist timed out') }, async () => { throw new Error('no nvidia-smi') }, async () => true)).toBe(true)
  })
  it("an embedding-only llama-server (Ollama's nomic-embed, under 1 GB) does not make the GPU busy", async () => {
    const ollamaEmbed = 'C:/Users/x/AppData/Local/Programs/Ollama/lib/ollama/llama-server.exe --model blob --port 55770 --embedding -b 2048\n'
    expect(await isGpuBusy(async () => ollamaEmbed, noGpuApps, noServer)).toBe(false)
    const cyncoChat = 'C:/Users/x/.cynco/bin-brain/llama-server.exe --model qwen.gguf --port 8081 --ctx-size 131072\n'
    expect(await isGpuBusy(async () => ollamaEmbed + cyncoChat, noGpuApps, noServer)).toBe(true)
  })
  it('a port probe that throws counts as no server', async () => {
    expect(await isGpuBusy(async () => 'explorer.exe\n', noGpuApps, async () => { throw new Error('ECONNREFUSED') })).toBe(false)
  })
  it('detects llama-server in the process list', async () => {
    expect(await isGpuBusy(async () => 'bun.exe\nllama-server.exe\n', noGpuApps, noServer)).toBe(true)
  })
  it('returns false when no llama-server is running', async () => {
    expect(await isGpuBusy(async () => 'explorer.exe\ncode.exe\n', noGpuApps, noServer)).toBe(false)
  })
  it('returns false when the process list is unavailable', async () => {
    expect(await isGpuBusy(async () => { throw new Error('no tasklist') }, noGpuApps, noServer)).toBe(false)
  })
  it('nvidia-smi: a compute app holding serious VRAM means busy even when tasklist is clean (spec §2)', async () => {
    const queryGpu = async () => '12345, 21504\n' // pid, used MiB
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu, noServer)).toBe(true)
  })
  it('nvidia-smi: small compute apps (browsers etc.) do not count as busy', async () => {
    const queryGpu = async () => '901, 350\n1402, 512\n'
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu, noServer)).toBe(false)
  })
  it('nvidia-smi unavailable falls back to the tasklist heuristic alone', async () => {
    const queryGpu = async () => { throw new Error('nvidia-smi not found') }
    expect(await isGpuBusy(async () => 'explorer.exe\n', queryGpu, noServer)).toBe(false)
    expect(await isGpuBusy(async () => 'llama-server\n', queryGpu, noServer)).toBe(true)
  })
})

describe('TaskRunner gpu-busy.json', () => {
  const { existsSync, readFileSync } = require('fs') as typeof import('fs')

  it('names the running one-shot while the child runs and clears it after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    const busyPath = join(dir, 'gpu-busy.json')
    try {
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], isGpuBusyImpl: async () => false, gpuBusyPath: busyPath })
      const input = { ...makeInput(dir, 'HANG please'), timeoutMs: 1500 }
      const running = runner.run(input)
      await new Promise((r) => setTimeout(r, 400))
      expect(existsSync(busyPath)).toBe(true)
      const info = JSON.parse(readFileSync(busyPath, 'utf-8'))
      expect(info.task).toBe('m1')
      expect(info.triggerId).toBe('t1')
      expect(info.timeoutMs).toBe(1500)
      expect(typeof info.pid).toBe('number')
      await running
      expect(existsSync(busyPath)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('clears the file after a normal run too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    const busyPath = join(dir, 'gpu-busy.json')
    try {
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], isGpuBusyImpl: async () => false, gpuBusyPath: busyPath })
      await runner.run(makeInput(dir, 'do the thing'))
      expect(existsSync(busyPath)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('TaskRunner activity (hold-awake)', () => {
  it('keeps a oneshot activity open for the child\'s lifetime and closes it after, including on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const registry = new ActivityRegistry()
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], isGpuBusyImpl: async () => false, gpuBusyPath: join(dir, 'b.json'), activity: registry })
      const running = runner.run({ ...makeInput(dir, 'HANG please'), timeoutMs: 1500 })
      await new Promise((r) => setTimeout(r, 400))
      expect(registry.count()).toBe(1)
      expect(registry.snapshot()[0]).toMatchObject({ kind: 'oneshot', label: 't1' })
      await running
      expect(registry.count()).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
