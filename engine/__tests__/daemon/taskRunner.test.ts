// engine/__tests__/daemon/taskRunner.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskRunner, isGpuBusy } from '../../daemon/taskRunner.js'
import type { TaskFileInput } from '../../daemon/types.js'
import { ActivityRegistry } from '../../power/activity.js'
import { testContainment } from '../../containment.js'

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

describe('TaskRunner pause', () => {
  it('kills the engine when shouldPause flips, reporting the journal id and the time spent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      let paused = false
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: [process.execPath, STUB],
        isGpuBusyImpl: async () => false,
        shouldPause: () => paused,
        pausePollMs: 100,
      })
      setTimeout(() => { paused = true }, 700)
      const started = Date.now()
      const outcome = await runner.run({ ...makeInput(dir, 'PAUSEME now'), timeoutMs: 20000 })
      expect(Date.now() - started).toBeLessThan(10000)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toBe('PAUSED')
      expect(outcome.paused?.sessionId).toBe('session-424242')
      expect(outcome.paused?.elapsedMs).toBeGreaterThanOrEqual(600)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 15000)

  it('a task that finishes normally is not paused even when asked late', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      // Not paused at start (that path never spawns); the pause request arrives only after launch.
      let asks = 0
      const runner = new TaskRunner({
        workDir: dir, spawnCmd: [process.execPath, STUB], isGpuBusyImpl: async () => false,
        shouldPause: () => asks++ > 0, pausePollMs: 60000,
      })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(true)
      expect(outcome.paused).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('TaskRunner already paused', () => {
  it('shouldPause true before run spawns nothing and reports the PAUSED outcome the poll path produces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      let gpuProbed = false
      const runner = new TaskRunner({
        workDir: dir,
        spawnCmd: ['definitely-not-a-real-binary-cynco'],
        isGpuBusyImpl: async () => { gpuProbed = true; return false },
        gpuBusyPath: join(dir, 'gpu-busy.json'),
        shouldPause: () => true,
      })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome).toEqual({ ok: false, summary: '', recommendations: [], error: 'PAUSED', paused: { elapsedMs: 0 } })
      expect(gpuProbed).toBe(false)
      expect(require('fs').readdirSync(dir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
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

// F242 (01-isolation 6.2, tests 9.6): a daemon one-shot is a contained run. `refuse` is asked before the
// GPU is taken, `contain` after the busy check, and `release` once the child is gone, on every exit path.
describe('TaskRunner containment (refuse, contain, release)', () => {
  const { existsSync, readFileSync, readdirSync } = require('fs') as typeof import('fs')

  function fakeContainment(dir: string, runId: string) {
    const sb = join(dir, 'sb')
    return testContainment({
      runId, kind: 'daemon-task', missionCwd: join(dir, 'mission'),
      sandbox: { root: sb, home: join(sb, 'home'), tmp: join(sb, 'tmp'), scratch: join(sb, 'scratch') },
      home: join(dir, 'home'), folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
    })
  }
  /** Each call is recorded in `calls`, in order; `release` answers `relabelled`. */
  function wired(dir: string, o: { refusal?: string | null; containRefusal?: string; busy?: boolean; relabelled?: boolean; note?: string } = {}) {
    const calls: string[] = []
    const released: string[] = []
    const opts = {
      takeGpu: async () => { calls.push('take') },
      giveGpuBack: async () => { calls.push('give back') },
      isGpuBusyImpl: async () => { calls.push('busy?'); return o.busy === true },
      refuse: () => { calls.push('refuse?'); return o.refusal ?? null },
      contain: () => {
        calls.push('contain')
        return o.containRefusal !== undefined
          ? { ok: false as const, reason: o.containRefusal }
          : { ok: true as const, containment: fakeContainment(dir, 'daemon-m1-t1-20261123T120000-abcd') }
      },
      release: (c: { runId: string }) => {
        calls.push('release'); released.push(c.runId)
        return { relabelled: o.relabelled ?? true, note: o.note ?? '' }
      },
    }
    return { calls, released, opts }
  }
  const taskFiles = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('task-'))

  it('a refusal from `refuse` reports REFUSED and takes nothing, spawns nothing, writes no task file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir, { refusal: 'containment: the sandbox root X:/nowhere is not an existing folder' })
      const runner = new TaskRunner({ workDir: dir, spawnCmd: ['definitely-not-a-real-binary-cynco'], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome).toEqual({ ok: false, summary: '', recommendations: [], error: 'REFUSED: containment: the sandbox root X:/nowhere is not an existing folder' })
      expect(w.calls).toEqual(['refuse?'])
      expect(readdirSync(dir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a containment refusal is a failed run: nothing spawned, the GPU given back once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir, { containRefusal: 'this task names no cwd' })
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome).toEqual({ ok: false, summary: '', recommendations: [], error: 'REFUSED: containment: this task names no cwd' })
      expect(w.calls).toEqual(['refuse?', 'take', 'busy?', 'contain', 'give back'])
      expect(taskFiles(dir)).toEqual([])
      expect(existsSync(join(dir, 'out.json'))).toBe(false)
      expect(existsSync(join(dir, 'gpu-busy.json'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a deferral (GPU busy) builds no sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir, { busy: true })
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      await expect(runner.run(makeInput(dir, 'x'))).rejects.toThrow(/gpu busy/i)
      expect(w.calls).toEqual(['refuse?', 'take', 'busy?', 'give back'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the child gets the run id in its task file, and the sandbox is released once after a normal exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir)
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(true)
      const files = taskFiles(dir)
      expect(files.length).toBe(1)
      expect(JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')).runId).toBe('daemon-m1-t1-20261123T120000-abcd')
      expect(w.released).toEqual(['daemon-m1-t1-20261123T120000-abcd'])
      // Released after the child had gone, and before the GPU was given back.
      expect(w.calls).toEqual(['refuse?', 'take', 'busy?', 'contain', 'release', 'give back'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('released once after a timeout kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir)
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      const outcome = await runner.run({ ...makeInput(dir, 'HANG please'), timeoutMs: 1500 })
      expect(outcome.error).toMatch(/timeout/i)
      expect(w.released.length).toBe(1)
      expect(w.calls.slice(-2)).toEqual(['release', 'give back'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 15000)

  it('released once after a pause kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      let paused = false
      const w = wired(dir)
      const runner = new TaskRunner({
        workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'),
        shouldPause: () => paused, pausePollMs: 100, ...w.opts,
      })
      setTimeout(() => { paused = true }, 700)
      const outcome = await runner.run({ ...makeInput(dir, 'PAUSEME now'), timeoutMs: 20000 })
      expect(outcome.error).toBe('PAUSED')
      expect(w.released.length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 15000)

  it('released once when the spawn throws, and the throw still reaches the caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir)
      // An empty program name makes spawn throw synchronously (ERR_INVALID_ARG_VALUE).
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [''], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      await expect(runner.run(makeInput(dir, 'do the thing'))).rejects.toThrow()
      expect(w.released.length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // Review finding of slice S2: a throw after the spawn (here the activity registry) used to give
  // the sandbox back with the one-shot still running in the folder.
  it('a throw after the child started ends the child before the sandbox is released, and still reaches the caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir)
      const marker = join(dir, 'outlived.txt').replace(/\\/g, '/')
      const late = `setTimeout(() => require('fs').writeFileSync('${marker}', 'x'), 2500)`
      const runner = new TaskRunner({
        workDir: dir, spawnCmd: [process.execPath, '-e', late], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts,
        activity: { begin: () => { throw new Error('activity registry broken') } } as unknown as ActivityRegistry,
      })
      await expect(runner.run(makeInput(dir, 'do the thing'))).rejects.toThrow('activity registry broken')
      expect(w.calls.slice(-2)).toEqual(['give back', 'release'])
      expect(w.released.length).toBe(1)
      await new Promise(r => setTimeout(r, 4000))
      expect(existsSync(join(dir, 'outlived.txt')), 'the one-shot outlived the failed setup').toBe(false)
      expect(existsSync(join(dir, 'gpu-busy.json'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20000)

  it('released once when the program cannot be found (the spawn reports an error instead of throwing)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const w = wired(dir)
      const runner = new TaskRunner({ workDir: dir, spawnCmd: ['definitely-not-a-real-binary-cynco'], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(false)
      expect(w.released.length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a release that did not set the folder back has its note logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    const said: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')) }
    try {
      const w = wired(dir, { relabelled: false, note: 'C:/m stays labelled low: run other-1 still holds it' })
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], gpuBusyPath: join(dir, 'gpu-busy.json'), ...w.opts })
      await runner.run(makeInput(dir, 'do the thing'))
      expect(said).toContain('[task:t1] C:/m stays labelled low: run other-1 still holds it')
    } finally {
      console.log = log
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with none of the three options the run is as before: no run id in the task file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tr-'))
    try {
      const runner = new TaskRunner({ workDir: dir, spawnCmd: [process.execPath, STUB], isGpuBusyImpl: async () => false, gpuBusyPath: join(dir, 'gpu-busy.json') })
      const outcome = await runner.run(makeInput(dir, 'do the thing'))
      expect(outcome.ok).toBe(true)
      const files = taskFiles(dir)
      expect(files.length).toBe(1)
      expect('runId' in JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
