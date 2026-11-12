/**
 * engine/power/reporter/gpu.ts — each card's temperature, memory and load, and which processes are on it.
 *
 * Two `nvidia-smi` queries, read directly (the audit channel: measured, not
 * asked of an app). On Windows the per-process memory is `[N/A]`, so a process
 * is reported as being on the card, not by how much it holds; whose GPU it is by
 * CynCo's own reckoning is `engineFacts.ts` `readHolder`.
 */
import { execFile } from 'child_process'
import type { GpuRow } from './types.js'

export const GPU_QUERY = ['--query-gpu=uuid,index,name,temperature.gpu,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits']
export const APPS_QUERY = ['--query-compute-apps=gpu_uuid,pid,process_name', '--format=csv,noheader,nounits']

/** Image names kept per card; a desktop has dozens of windowed processes with a context. */
const MAX_PROCS = 40

const num = (s: string | undefined): number | null => {
  const v = Number((s ?? '').trim())
  return (s ?? '').trim() !== '' && Number.isFinite(v) ? v : null
}

const baseName = (path: string): string => path.trim().split(/[\\/]/).pop() ?? ''

/** The two CSV answers as rows, or null when the GPU answer has no card in it. */
export function parseGpuQuery(gpuCsv: string, appsCsv: string): GpuRow[] | null {
  const cards: Array<GpuRow & { uuid: string }> = []
  for (const line of gpuCsv.split(/\r?\n/)) {
    const f = line.split(',').map(s => s.trim())
    if (f.length < 7 || !/^\d+$/.test(f[1] ?? '')) continue
    cards.push({ uuid: f[0]!, i: Number(f[1]), name: f[2]!, tempC: num(f[3]), memUsedMib: num(f[4]), memTotalMib: num(f[5]), utilPct: num(f[6]), procs: [] })
  }
  if (cards.length === 0) return null
  for (const line of appsCsv.split(/\r?\n/)) {
    const first = line.indexOf(',')
    const second = line.indexOf(',', first + 1)
    if (first < 0 || second < 0) continue
    const card = cards.find(c => c.uuid === line.slice(0, first).trim())
    const name = baseName(line.slice(second + 1))
    // "[Insufficient Permissions]" is a process this user may not read: not a name.
    if (!card || !name || name.startsWith('[')) continue
    if (!card.procs.includes(name)) card.procs.push(name)
  }
  return cards.map(({ uuid: _uuid, ...row }) => ({ ...row, procs: row.procs.sort().slice(0, MAX_PROCS) }))
}

export type RunSmi = (args: string[]) => Promise<string>

const runSmi: RunSmi = args => new Promise((resolve, reject) => {
  execFile('nvidia-smi', args, { timeout: 5000, encoding: 'utf-8', windowsHide: true }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

/** Every card on this box, or null when `nvidia-smi` cannot be run or answers nothing. */
export async function readGpus(run: RunSmi = runSmi): Promise<GpuRow[] | null> {
  try {
    const gpu = await run(GPU_QUERY)
    // The process list is the lesser half: a card is still reported when it cannot be read.
    const apps = await run(APPS_QUERY).catch(() => '')
    return parseGpuQuery(gpu, apps)
  } catch {
    return null
  }
}
