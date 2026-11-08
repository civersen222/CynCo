/**
 * engine/daemon/gpuBusyFile.ts — the daemon's claim on the GPU, as one small file.
 *
 * `TaskRunner` writes `<cyncoHome>/gpu-busy.json` for the life of a one-shot
 * child and removes it after. Readers (the engine's lazy model path, the
 * dashboard's /api/session, the desk widget) learn which trigger owns the
 * GPU and roughly how long it may still run, so they can wait and say why
 * instead of killing the one-shot's llama-server (the F182 class). A file
 * whose pid is gone is stale: `readGpuBusy` deletes it and reports null.
 * Design: docs/decisions/2026-11-08-wakefulness-design.md ("Decisions after the builder check").
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cyncoHome } from '../paths.js'

export type GpuBusy = {
  task: string
  triggerId: string
  startedAt: string
  timeoutMs: number
  pid: number
}

export function gpuBusyPath(home: string = cyncoHome()): string {
  return join(home, 'gpu-busy.json')
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Atomic: a crash mid-write never leaves a truncated claim. */
export function writeGpuBusy(info: GpuBusy, path: string = gpuBusyPath()): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info), 'utf-8')
  renameSync(tmp, path)
}

export function clearGpuBusy(path: string = gpuBusyPath()): void {
  rmSync(path, { force: true })
}

export function readGpuBusy(path: string = gpuBusyPath(), isPidAlive: (pid: number) => boolean = defaultIsPidAlive): GpuBusy | null {
  if (!existsSync(path)) return null
  let info: GpuBusy
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed?.pid !== 'number' || typeof parsed?.triggerId !== 'string') return null
    info = parsed
  } catch {
    return null
  }
  if (!isPidAlive(info.pid)) { clearGpuBusy(path); return null }
  return info
}

export function estimateRemainingMs(info: GpuBusy, now: number = Date.now()): number {
  return Math.max(0, Date.parse(info.startedAt) + info.timeoutMs - now)
}
