import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearGpuBusy, estimateRemainingMs, gpuBusyPath, readGpuBusy, writeGpuBusy, type GpuBusy } from '../../daemon/gpuBusyFile.js'

let dir: string
let path: string
const info: GpuBusy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: '2026-11-08T19:00:00.000Z', timeoutMs: 2_700_000, pid: 4242 }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-gpubusy-')); path = join(dir, 'gpu-busy.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('gpu-busy.json', () => {
  it('lives at <home>/gpu-busy.json', () => {
    expect(gpuBusyPath('C:/x/.cynco')).toBe(join('C:/x/.cynco', 'gpu-busy.json'))
  })

  it('round-trips a write when the owner pid is alive', () => {
    writeGpuBusy(info, path)
    expect(readGpuBusy(path, () => true)).toEqual(info)
  })

  it('reads null and deletes the file when the owner pid is gone', () => {
    writeGpuBusy(info, path)
    expect(readGpuBusy(path, () => false)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  it('reads null for an absent or unparsable file', () => {
    expect(readGpuBusy(path, () => true)).toBeNull()
    writeFileSync(path, '{not json', 'utf-8')
    expect(readGpuBusy(path, () => true)).toBeNull()
  })

  it('clear removes the file and tolerates its absence', () => {
    writeGpuBusy(info, path)
    clearGpuBusy(path)
    expect(existsSync(path)).toBe(false)
    clearGpuBusy(path)
  })

  it('estimateRemainingMs is startedAt + timeoutMs − now, clamped at 0', () => {
    const start = Date.parse(info.startedAt)
    expect(estimateRemainingMs(info, start + 700_000)).toBe(2_000_000)
    expect(estimateRemainingMs(info, start + 9_000_000)).toBe(0)
  })
})
