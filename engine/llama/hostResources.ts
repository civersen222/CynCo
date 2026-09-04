/**
 * What the machine can give a llama-server BEFORE we spawn it.
 *
 * F140: llama-server died six times on `failed to allocate memory for prompt
 * cache state: bad allocation` because a browser had taken the whole Windows
 * commit charge; each restart re-hit the wall, the restart budget was spent in
 * 14 minutes, and the run ended as a fault 55 minutes early. Quartermaster
 * re-derives placement from live free memory at every spawn and REFUSES rather
 * than crashing. This module is that refusal: measure, compare to what this
 * launch needs, and say exactly why when the answer is no.
 *
 * Readings come with a `source`; 'unavailable' means "could not measure", and
 * evaluateSpawn never refuses on a number it does not have.
 */
import { readFileSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { worstCheckpointMib, type CheckpointCostModel } from './checkpointCost.js'

export type HostMemory = {
  totalPhysMib: number
  availPhysMib: number
  /** Commit limit = physical + pagefile; what every allocation on the box draws from. */
  commitLimitMib: number
  commitFreeMib: number
  source: 'win32-ffi' | 'proc-meminfo' | 'unavailable'
}

export type GpuMemory = { totalMib: number; usedMib: number; freeMib: number; source: 'nvidia-smi' | 'unavailable' }

export type SpawnRequirement = { commitFreeMibNeeded: number; vramFreeMibNeeded: number }
export type SpawnCheck = { ok: true } | { ok: false; reason: string }

const MIB = 2 ** 20

function unavailableHost(): HostMemory {
  return { totalPhysMib: 0, availPhysMib: 0, commitLimitMib: 0, commitFreeMib: 0, source: 'unavailable' }
}

function unavailableGpu(): GpuMemory {
  return { totalMib: 0, usedMib: 0, freeMib: 0, source: 'unavailable' }
}

export async function readHostMemory(): Promise<HostMemory> {
  const bun = (globalThis as any).Bun
  if (process.platform === 'win32' && typeof bun !== 'undefined' && typeof bun.version === 'string') {
    try {
      // Computed specifier: vitest's Node-side graph must not try to resolve bun:ffi.
      const ffiModule = 'bun:ffi'
      const { dlopen, FFIType, ptr } = await import(ffiModule)
      const k = dlopen('kernel32.dll', { GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 } })
      // MEMORYSTATUSEX: dwLength, dwMemoryLoad, ullTotalPhys, ullAvailPhys, ullTotalPageFile,
      // ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual = 64 bytes.
      const buf = new ArrayBuffer(64)
      const dv = new DataView(buf)
      dv.setUint32(0, 64, true)
      if (!k.symbols.GlobalMemoryStatusEx(ptr(buf))) return unavailableHost()
      const q = (o: number) => Number(dv.getBigUint64(o, true)) / MIB
      return { totalPhysMib: q(8), availPhysMib: q(16), commitLimitMib: q(24), commitFreeMib: q(32), source: 'win32-ffi' }
    } catch { return unavailableHost() }
  }
  if (existsSync('/proc/meminfo')) {
    try {
      const text = readFileSync('/proc/meminfo', 'utf-8')
      const kb = (name: string) => { const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) / 1024 : 0 }
      const limit = kb('CommitLimit'), committed = kb('Committed_AS')
      return { totalPhysMib: kb('MemTotal'), availPhysMib: kb('MemAvailable'), commitLimitMib: limit, commitFreeMib: Math.max(0, limit - committed), source: 'proc-meminfo' }
    } catch { return unavailableHost() }
  }
  return unavailableHost()
}

export function parseNvidiaSmiGpuLine(line: string): GpuMemory {
  const m = /^\s*(\d+),\s*(\d+),\s*(\d+)\s*$/.exec(line.split('\n')[0] ?? '')
  if (!m) return unavailableGpu()
  return { totalMib: Number(m[1]), usedMib: Number(m[2]), freeMib: Number(m[3]), source: 'nvidia-smi' }
}

/**
 * Free VRAM as nvidia-smi reports it. llama.cpp's OWN VMM allocations are
 * invisible to this query (reference_env_hazards #3), so it is only meaningful
 * BEFORE our server is up — which is exactly when a pre-spawn check runs.
 */
export function readGpuMemory(): Promise<GpuMemory> {
  return new Promise(resolve => {
    try {
      execFile('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
        { timeout: 5000, encoding: 'utf-8', windowsHide: true },
        (err, stdout) => resolve(err ? unavailableGpu() : parseNvidiaSmiGpuLine(String(stdout))))
    } catch { resolve(unavailableGpu()) }
  })
}

/** The top committers by paged memory, for the refusal message. Windows only; '' elsewhere or on error. */
export function topCommitConsumers(n = 3): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('')
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-Command',
      `Get-Process | Sort-Object PagedMemorySize64 -Descending | Select-Object -First ${n} | ForEach-Object { "$($_.ProcessName).exe $([math]::Round($_.PagedMemorySize64/1GB,1)) GB" }`],
      { timeout: 8000, encoding: 'utf-8', windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).trim().split(/\r?\n/).filter(Boolean).join(', ')))
  })
}

/**
 * What this launch needs free. Commit: two worst-case checkpoint states (the
 * prompt-cache save that failed in F140 was one such state) plus a 4 GiB margin
 * for the server's own heap. VRAM: the whole model file (gpuLayers=999 in this
 * stack) plus 2 GiB for compute buffer and draft. LOCALCODE_LLAMA_MIN_COMMIT_FREE_MIB
 * raises the commit floor — an operator lever, and the way a refusal is forced
 * on purpose to test the path end to end.
 */
export function spawnRequirementFor(input: { ctxSize: number; modelFileBytes: number; cost: CheckpointCostModel }): SpawnRequirement {
  const envFloor = Number(process.env.LOCALCODE_LLAMA_MIN_COMMIT_FREE_MIB)
  const commit = 2 * worstCheckpointMib(input.ctxSize, input.cost) + 4096
  return {
    commitFreeMibNeeded: Number.isFinite(envFloor) && envFloor > 0 ? Math.max(commit, envFloor) : commit,
    vramFreeMibNeeded: input.modelFileBytes / MIB + 2048,
  }
}

export function evaluateSpawn(host: HostMemory, gpu: GpuMemory, req: SpawnRequirement, topConsumers = ''): SpawnCheck {
  if (host.source !== 'unavailable' && host.commitFreeMib < req.commitFreeMibNeeded) {
    return { ok: false, reason:
      `host commit charge exhausted: ${Math.round(host.commitFreeMib)} MiB free of a ${Math.round(host.commitLimitMib)} MiB limit, ` +
      `this launch needs ${Math.round(req.commitFreeMibNeeded)} MiB (two checkpoint states + margin)` +
      (topConsumers ? `; top consumers: ${topConsumers}` : '') }
  }
  if (gpu.source !== 'unavailable' && gpu.freeMib < req.vramFreeMibNeeded) {
    return { ok: false, reason:
      `VRAM held by other processes: ${gpu.freeMib} MiB free of ${gpu.totalMib}, this model needs ${Math.round(req.vramFreeMibNeeded)} MiB ` +
      `(nvidia-smi; our own server is not running, so this is foreign usage)` }
  }
  return { ok: true }
}
