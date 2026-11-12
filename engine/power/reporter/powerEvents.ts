/**
 * engine/power/reporter/powerEvents.ts — when this box slept, woke, shut down and started.
 *
 * Read from the Windows System log, which is the box's own record and survives
 * the sleep it describes. `Microsoft-Windows-Power-Troubleshooter` 1 is written
 * after each wake and carries the sleep time, the wake time and what Windows
 * believes woke the box; `Kernel-Power` 42 carries why it went to sleep;
 * `Kernel-General` 12 and 13 are start and shutdown. A box cannot report while
 * it is asleep, so these are read back afterwards and stamped with the time
 * they happened.
 *
 * The wake source is reported as Windows words it and is not evidence of who
 * woke the box: on 2026-11-11 eight wakes by network traffic all read
 * "Power Button" (F221). The watcher decides, from the doorman's bursts.
 */
import { execFile } from 'child_process'
import { toSecond, type WatchEvent } from './types.js'

export type SystemLogRow = { record?: number; id: number; provider: string; at: string; data: Record<string, string> }

const TROUBLESHOOTER = 'Microsoft-Windows-Power-Troubleshooter'
const KERNEL_POWER = 'Microsoft-Windows-Kernel-Power'
const KERNEL_GENERAL = 'Microsoft-Windows-Kernel-General'

/** How close a Kernel-Power 42 must be to a Troubleshooter sleep time to be the same sleep. */
const SAME_SLEEP_MS = 10_000

const ms = (iso: string | undefined): number => Date.parse(iso ?? '')

/** Kernel-Power 42 `Reason`, in words where the value is known. */
export function sleepReason(code: string | undefined): string | null {
  if (code === undefined || code === '') return null
  if (code === '7') return 'idle'
  if (code === '4') return 'application'
  return `reason ${code}`
}

/** The wake source as Windows' own message words it (`WakeSourceType` + `WakeSourceText`). */
export function wakeSource(data: Record<string, string>): string {
  const type = data.WakeSourceType
  const text = (data.WakeSourceText ?? '').trim()
  if (type === '1') return 'Power Button'
  if (type === '5') return `Device -${text}`
  if (type === '6') return `Timer - ${text || (data.WakeTimerOwner ?? '').trim() || 'unnamed'}`
  if (type === '0') return 'Unknown'
  return `type ${type ?? '?'}${text ? ` ${text}` : ''}`
}

export function powerEventsFromRows(rows: SystemLogRow[]): WatchEvent[] {
  const out: WatchEvent[] = []
  const entering = rows.filter(r => r.provider === KERNEL_POWER && r.id === 42 && Number.isFinite(ms(r.at)))
  const reasonNear = (sleepAt: number): string | null => {
    const near = entering.find(r => Math.abs(ms(r.at) - sleepAt) <= SAME_SLEEP_MS)
    return near ? sleepReason(near.data.Reason) : null
  }
  const reported: number[] = []
  for (const r of rows) {
    if (r.provider !== TROUBLESHOOTER || r.id !== 1) continue
    const sleepAt = ms(r.data.SleepTime)
    const wakeAt = ms(r.data.WakeTime)
    if (!Number.isFinite(sleepAt) || !Number.isFinite(wakeAt)) continue
    reported.push(sleepAt)
    const sleepIso = new Date(sleepAt).toISOString()
    const wakeIso = new Date(wakeAt).toISOString()
    out.push({ t: 'event', at: sleepIso, kind: 'power.sleep', key: `sleep:${toSecond(sleepIso)}`, data: { reason: reasonNear(sleepAt) } })
    out.push({ t: 'event', at: wakeIso, kind: 'power.wake', key: `wake:${toSecond(wakeIso)}`, data: { sleepAt: sleepIso, source: wakeSource(r.data) } })
  }
  // A sleep whose wake has not been written up yet (read moments after resuming).
  for (const r of entering) {
    const at = ms(r.at)
    if (reported.some(s => Math.abs(s - at) <= SAME_SLEEP_MS)) continue
    const iso = new Date(at).toISOString()
    out.push({ t: 'event', at: iso, kind: 'power.sleep', key: `sleep:${toSecond(iso)}`, data: { reason: sleepReason(r.data.Reason) } })
  }
  for (const r of rows) {
    if (r.provider !== KERNEL_GENERAL) continue
    const at = ms(r.id === 12 ? r.data.StartTime ?? r.at : r.id === 13 ? r.data.StopTime ?? r.at : '')
    if (!Number.isFinite(at)) continue
    const iso = new Date(at).toISOString()
    if (r.id === 12) out.push({ t: 'event', at: iso, kind: 'power.boot', key: `boot:${toSecond(iso)}`, data: {} })
    if (r.id === 13) out.push({ t: 'event', at: iso, kind: 'power.shutdown', key: `shutdown:${toSecond(iso)}`, data: {} })
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind))
}

/**
 * The PowerShell that reads the rows since `sinceIso`. No double quotes anywhere: the script
 * travels as one argv element and Windows argument quoting would mangle them (as in
 * `engine/llama/portOwner.ts`). Read-only: `Get-WinEvent` on the System log.
 */
export function systemLogScript(sinceIso: string): string {
  if (!/^[0-9T:.Z+-]+$/.test(sinceIso)) throw new Error(`not an ISO time: ${sinceIso}`)
  return [
    `$f = @{ LogName = 'System'; StartTime = [datetime]::Parse('${sinceIso}').ToUniversalTime(); Id = 1,42,12,13 }`,
    `$rows = @(Get-WinEvent -FilterHashtable $f -ErrorAction SilentlyContinue | Where-Object {`
      + ` ($_.ProviderName -eq '${TROUBLESHOOTER}' -and $_.Id -eq 1)`
      + ` -or ($_.ProviderName -eq '${KERNEL_POWER}' -and $_.Id -eq 42)`
      + ` -or ($_.ProviderName -eq '${KERNEL_GENERAL}' -and ($_.Id -eq 12 -or $_.Id -eq 13)) }`
      + ` | Sort-Object TimeCreated | ForEach-Object {`
      + ` $d = @{}; foreach ($n in ([xml]$_.ToXml()).Event.EventData.Data) { if ($n.Name) { $d[$n.Name] = [string]$n.'#text' } };`
      + ` @{ record = $_.RecordId; id = $_.Id; provider = $_.ProviderName; at = $_.TimeCreated.ToUniversalTime().ToString('o'); data = $d } })`,
    `ConvertTo-Json -InputObject $rows -Depth 4 -Compress`,
    // No matching event is an empty list, not a failed command.
    `exit 0`,
  ].join('; ')
}

export type RunPowerShell = (script: string) => Promise<string>

/** Async and bounded (F155 is why this is not spawnSync). */
const runPowerShell: RunPowerShell = script => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') { reject(new Error('the System log is read on Windows only')); return }
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

/** The System log's power rows since `sinceIso`, or null when they cannot be read. */
export async function readSystemLog(sinceIso: string, run: RunPowerShell = runPowerShell, log: (line: string) => void = console.log): Promise<SystemLogRow[] | null> {
  try {
    const out = (await run(systemLogScript(sinceIso))).trim()
    if (!out) return []
    const parsed: unknown = JSON.parse(out)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const rows: SystemLogRow[] = []
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      if (typeof o.id !== 'number' || typeof o.provider !== 'string' || typeof o.at !== 'string') continue
      const data: Record<string, string> = {}
      if (o.data && typeof o.data === 'object') for (const [k, v] of Object.entries(o.data as Record<string, unknown>)) data[k] = v == null ? '' : String(v)
      rows.push({ record: typeof o.record === 'number' ? o.record : undefined, id: o.id, provider: o.provider, at: o.at, data })
    }
    return rows
  } catch (err) {
    log(`[watch] could not read the System log: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
