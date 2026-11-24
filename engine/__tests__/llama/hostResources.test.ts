import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSpawn, evaluateSpawn, parseNvidiaSmiGpuLine, readHostMemory, spawnRequirementFor, type HostMemory, type GpuMemory } from '../../llama/hostResources.js'
import { MEASURED_DEFAULT_COST } from '../../llama/checkpointCost.js'

const host = (commitFreeMib: number): HostMemory => ({ totalPhysMib: 65126, availPhysMib: 15872, commitLimitMib: 154829, commitFreeMib, source: 'win32-ffi' })
const gpu = (freeMib: number): GpuMemory => ({ totalMib: 32607, usedMib: 32607 - freeMib, freeMib, source: 'nvidia-smi' })
const unavailableHost: HostMemory = { totalPhysMib: 0, availPhysMib: 0, commitLimitMib: 0, commitFreeMib: 0, source: 'unavailable' }
const unavailableGpu: GpuMemory = { totalMib: 0, usedMib: 0, freeMib: 0, source: 'unavailable' }

describe('spawnRequirementFor', () => {
  it('asks for two worst-case checkpoint states plus a margin of host commit, and the model file plus a margin of VRAM', () => {
    const req = spawnRequirementFor({ ctxSize: 131072, modelFileBytes: 19694390752, cost: MEASURED_DEFAULT_COST })
    // worst checkpoint at 131072 = 149.65 + 131072*4.02/1024 = 664.3 MiB; x2 + 4096 margin.
    expect(req.commitFreeMibNeeded).toBeCloseTo(2 * 664.3 + 4096, 0)
    expect(req.vramFreeMibNeeded).toBeCloseTo(19694390752 / 2 ** 20 + 2048, 0)
  })
})

describe('evaluateSpawn', () => {
  const req = { commitFreeMibNeeded: 5425, vramFreeMibNeeded: 20831 }
  it('passes when both are ample', () => {
    expect(evaluateSpawn(host(90000), gpu(30000), req)).toEqual({ ok: true })
  })
  it('refuses on exhausted commit charge and names the numbers (F140)', () => {
    const r = evaluateSpawn(host(1200), gpu(30000), req, 'firefox.exe 209.1 GB, llama-server.exe 38.8 GB, python.exe 6.9 GB')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/commit/i)
      expect(r.reason).toContain('1200')
      expect(r.reason).toContain('5425')
      expect(r.reason).toContain('firefox.exe')
    }
  })
  it('refuses when foreign VRAM leaves less than the model needs', () => {
    const r = evaluateSpawn(host(90000), gpu(12000), req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/VRAM/)
  })
  it('never refuses on a reading it does not have', () => {
    expect(evaluateSpawn(unavailableHost, unavailableGpu, req)).toEqual({ ok: true })
    expect(evaluateSpawn(host(90000), unavailableGpu, req)).toEqual({ ok: true })
  })
})

describe('parseNvidiaSmiGpuLine', () => {
  it('parses the csv,noheader,nounits line', () => {
    expect(parseNvidiaSmiGpuLine('32607, 10248, 21940')).toEqual({ totalMib: 32607, usedMib: 10248, freeMib: 21940, source: 'nvidia-smi' })
  })
  it('returns unavailable on garbage', () => {
    expect(parseNvidiaSmiGpuLine('No devices were found').source).toBe('unavailable')
  })
})

// The kernel32 path needs bun:ffi, which vitest's Node does not have, so it is run the way the engine
// runs it: in a `bun` child, as processTreeJob.test.ts and containmentLauncher.test.ts run theirs.
// Until 2026-11-24 this test asked whether vitest itself was Bun, which it never is, and so never ran.
// Bun is found through the shell once, because on this PC `bun` on PATH is npm's bun.cmd shim, and asked
// for its own executable; the probe below then starts that executable directly. Through the shell a
// timeout would kill only cmd.exe and leave bun.exe running (F210); started directly, the timeout ends
// the one process the probe is. The lookup has a timeout of its own so a hung bun cannot hang collection.
const onWindows = process.platform === 'win32'
function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? r.stdout.trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}
const bunExe = onWindows ? findBunExe() : null
const kernel32Skip = !onWindows
  ? 'not Windows: there is no kernel32 to read through'
  : bunExe === null ? 'bun is not on PATH (or did not name its executable within 15 s), so the bun:ffi path the engine uses could not be run' : null
if (kernel32Skip) console.log(`[hostResources] SKIPPED the kernel32 reading: ${kernel32Skip}`)
const probeDirs: string[] = []
afterAll(() => { for (const d of probeDirs) rmSync(d, { recursive: true, force: true }) })

describe('readHostMemory', () => {
  const underBun = typeof (globalThis as any).Bun !== 'undefined' && typeof (globalThis as any).Bun.version === 'string'
  it.skipIf(kernel32Skip !== null)('reads real numbers through kernel32 under Bun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-hostmem-'))
    probeDirs.push(dir)
    const script = join(dir, 'probe.ts')
    // The module under test by its absolute path, found from this file rather than the working directory
    // (vitest may be started elsewhere with --root), forward slashes, so the child imports this checkout's copy.
    const target = fileURLToPath(new URL('../../llama/hostResources.ts', import.meta.url)).replace(/\\/g, '/')
    writeFileSync(script, `import { readHostMemory } from ${JSON.stringify(target)}\nconsole.log(JSON.stringify(await readHostMemory()))\n`)
    const run = spawnSync(bunExe!, [script], { encoding: 'utf-8', windowsHide: true, timeout: 50_000 })
    expect(run.status, `bun did not run the probe:\n${run.stdout}\n${run.stderr}`).toBe(0)
    const m = JSON.parse(run.stdout.trim().split('\n').pop()!) as HostMemory
    expect(m.source, JSON.stringify(m)).toBe('win32-ffi')
    expect(m.totalPhysMib).toBeGreaterThan(0)
    expect(m.availPhysMib).toBeGreaterThan(0)
    expect(m.availPhysMib).toBeLessThanOrEqual(m.totalPhysMib)
    expect(m.commitLimitMib).toBeGreaterThan(m.totalPhysMib)
    expect(m.commitFreeMib).toBeGreaterThan(0)
    expect(m.commitFreeMib).toBeLessThanOrEqual(m.commitLimitMib)
  }, 60_000)
  it.skipIf(underBun)('reports unavailable off the Bun runtime rather than guessing', async () => {
    const m = await readHostMemory()
    expect(['unavailable', 'proc-meminfo']).toContain(m.source)
  })
})

// Local-LLM apps, slice 4: a card that is short because Ollama holds one of the owner's apps' models is
// first asked to let go (engine/apps/ollama.ts), then measured again; only then is the spawn refused.
describe('checkSpawn: relief before a VRAM refusal', () => {
  const req = { commitFreeMibNeeded: 5000, vramFreeMibNeeded: 20000 }
  const rig = (gpus: number[], relieved: number, hostFree = 90000) => {
    const calls = { relieve: 0, sleeps: [] as number[], gpuReads: 0, top: 0 }
    const deps = {
      readHost: async () => host(hostFree),
      readGpu: async () => gpu(gpus[Math.min(calls.gpuReads++, gpus.length - 1)]),
      relieve: async () => { calls.relieve++; return relieved },
      sleep: async (ms: number) => { calls.sleeps.push(ms) },
      topConsumers: async () => { calls.top++; return 'ollama.exe 17.0 GB' },
      recheckDelayMs: 3000,
    }
    return { deps, calls }
  }

  it('enough VRAM: nobody is asked for anything', async () => {
    const r = rig([30000], 1)
    expect(await checkSpawn(req, r.deps)).toEqual({ ok: true })
    expect(r.calls).toMatchObject({ relieve: 0, top: 0, sleeps: [] })
  })

  it('short of VRAM, relief unloads something, the card is measured again and the spawn goes ahead', async () => {
    const r = rig([12000, 30000], 1)
    expect(await checkSpawn(req, r.deps)).toEqual({ ok: true })
    expect(r.calls.relieve).toBe(1)
    expect(r.calls.gpuReads).toBe(2)
  })

  it('short of VRAM and nothing to relieve: the one re-read after the usual delay, then the refusal', async () => {
    const r = rig([12000, 12000], 0)
    const c = await checkSpawn(req, r.deps)
    expect(c.ok).toBe(false)
    expect(r.calls.relieve).toBe(1)
    expect(r.calls.sleeps).toEqual([3000])
    if (!c.ok) expect(c.reason).toMatch(/VRAM held by other processes: 12000 MiB free/)
  })

  it('a relief that throws is not a reason to crash a model load: the refusal stands', async () => {
    const r = rig([12000, 12000], 0)
    const c = await checkSpawn(req, { ...r.deps, relieve: async () => { throw new Error('ollama exploded') } })
    expect(c.ok).toBe(false)
  })

  it('short of commit charge, not VRAM: relief is not asked (Ollama cannot help with that)', async () => {
    const r = rig([30000], 1, 1200)
    const c = await checkSpawn(req, r.deps)
    expect(c.ok).toBe(false)
    expect(r.calls.relieve).toBe(0)
    if (!c.ok) expect(c.reason).toMatch(/top consumers: ollama\.exe/)
  })

  it('no relief wired: exactly the old behaviour', async () => {
    const r = rig([12000, 30000], 0)
    const { relieve: _unused, ...withoutRelief } = r.deps
    expect(await checkSpawn(req, withoutRelief)).toEqual({ ok: true })
    expect(r.calls.sleeps).toEqual([3000])
  })
})
