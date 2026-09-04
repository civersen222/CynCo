import { describe, it, expect } from 'vitest'
import { evaluateSpawn, parseNvidiaSmiGpuLine, readHostMemory, spawnRequirementFor, type HostMemory, type GpuMemory } from '../../llama/hostResources.js'
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

describe('readHostMemory', () => {
  const underBun = typeof (globalThis as any).Bun !== 'undefined' && typeof (globalThis as any).Bun.version === 'string'
  it.skipIf(process.platform !== 'win32' || !underBun)('reads real numbers through kernel32 under Bun', async () => {
    const m = await readHostMemory()
    expect(m.source).toBe('win32-ffi')
    expect(m.commitLimitMib).toBeGreaterThan(m.totalPhysMib)
    expect(m.commitFreeMib).toBeGreaterThan(0)
  })
  it.skipIf(underBun)('reports unavailable off the Bun runtime rather than guessing', async () => {
    const m = await readHostMemory()
    expect(['unavailable', 'proc-meminfo']).toContain(m.source)
  })
})
