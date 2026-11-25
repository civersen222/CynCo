// engine/llama/portOwner.ts
// Whose server is on the model port. The lazy path (ProcessManager.ensureRunningLazy)
// waits behind a healthy server that belongs to another CynCo engine and stops one
// that does not (F202: the owner's game left a llama-server on 8081 and a chat turn
// waited 30 minutes behind it).
//
// Ownership is read from process ancestry, not from the executable: another project
// on this machine launches CynCo's own ~/.cynco/bin/llama-server.exe from a shell
// script, so the path cannot tell the two apart. Every CynCo server is spawned
// directly by a bun process (the interactive or headless engine, a mission engine,
// a daemon one-shot, the benchmark runner), and the Job Object takes the server
// down with that process (F131). So: the listener is an engine's when its parent is
// a running bun that is older than it. Anything else is foreign.
//
// What cannot be read is `unknown`, and `unknown` is waited on, never stopped.

import { execFile } from 'child_process'

export type PortListener = {
  pid: number
  name: string
  /** The image name of the process that started the listener, or null when that process is gone. */
  parentName: string | null
  /** False when the parent pid now belongs to a process created after the listener (Windows reuses pids). */
  parentIsOlder: boolean
}

/**
 * `app`: a server that belongs to one of the owner's local-LLM apps. This file never answers it; `engine/apps/identify.ts`
 * does, through the `portOwner` the lazy wait is given (docs/decisions/2026-11-11-local-llm-apps.md).
 */
export type PortOwner = { owner: 'engine' | 'app' | 'foreign' | 'unknown'; detail: string }

const isBun = (name: string | null): boolean => !!name && /^bun(\.exe)?$/i.test(name)

export function classifyPortOwner(l: PortListener | null): PortOwner {
  if (!l) return { owner: 'unknown', detail: 'the process listening on the port could not be read' }
  const who = `pid ${l.pid} (${l.name})`
  if (isBun(l.parentName) && l.parentIsOlder) return { owner: 'engine', detail: `${who}, the child of a running ${l.parentName}` }
  if (!l.parentName) return { owner: 'foreign', detail: `${who}, whose parent process is gone` }
  if (!l.parentIsOlder) return { owner: 'foreign', detail: `${who}, whose parent pid now belongs to a later ${l.parentName}` }
  return { owner: 'foreign', detail: `${who}, started by ${l.parentName}` }
}

// No double quotes anywhere: the script travels as one argv element and Windows
// argument quoting would mangle them.
function listenerScript(port: number): string {
  return [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess)`,
    `if ($p) { $pp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId)`,
    `$o = [ordered]@{ pid = [int]$p.ProcessId; name = $p.Name; parentName = $null; parentIsOlder = $false }`,
    `if ($pp) { $o.parentName = $pp.Name; $o.parentIsOlder = ($pp.CreationDate -le $p.CreationDate) }`,
    `$o | ConvertTo-Json -Compress } }`,
    // Nothing listening is an empty answer, not a failed command.
    `exit 0`,
  ].join('; ')
}

/** Async and bounded: a hung PowerShell must not hang the model load (F155 is why this is not spawnSync). */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('port ownership is read on Windows only')); return }
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true },
      (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
  })
}

/** The process listening on `port` and what started it, or null when that cannot be read. */
export async function readPortListener(port: number, run: (script: string) => Promise<string> = runPowerShell): Promise<PortListener | null> {
  try {
    const out = (await run(listenerScript(port))).trim()
    if (!out) return null
    const j = JSON.parse(out) as Record<string, unknown>
    if (typeof j.pid !== 'number' || typeof j.name !== 'string') return null
    return { pid: j.pid, name: j.name, parentName: typeof j.parentName === 'string' ? j.parentName : null, parentIsOlder: j.parentIsOlder === true }
  } catch (err) {
    console.log(`[llama-cpp] could not read who holds port ${port}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ---- Is the pid a listing names as a socket's owner the process that made it? (F255) ----
//
// Windows names as a listening socket's owner the pid of the process that MADE the socket. When that process has
// ended and a process it started inherited the socket, the listing keeps naming the dead pid ("orphaned listening
// socket", "netstat kept reporting the DEAD engine PID" in docs/cynco-failure-log.md), and Windows may have given that
// number to any process since. A kill of "whatever listens on the port" then lands on a stranger. A process created
// after the socket cannot have made it: that is the one thing a listing can show, and it is what is read here.

/** One listening socket on a port: the pid the listing names, and when the socket and that process were created (ms since 1601, UTC; null when unread). */
export type ListenerAge = { pid: number; socketCreatedMs: number | null; processCreatedMs: number | null }

/** `owner`: not younger than the socket. `younger`: created after it, so the number has changed hands. `unknown`: a time could not be read. */
export type ListenerVerdict = 'owner' | 'younger' | 'unknown'

/**
 * `Get-NetTCPConnection` gives a socket's creation time in whole seconds (measured 2026-11-25: every listener's
 * CreationTime ends in .0000000, while the process that made it was created up to 0.97 s later than that time says).
 * So a process is younger than its socket only when it was created a whole second or more after the time given.
 */
export const SOCKET_TIME_RESOLUTION_MS = 1_000

/** The comparison, pure. A number that changed hands within the second the socket was made reads as `owner`, as every pid did before. */
export function listenerVerdict(socketCreatedMs: number | null, processCreatedMs: number | null): ListenerVerdict {
  if (socketCreatedMs === null || processCreatedMs === null || !Number.isFinite(socketCreatedMs) || !Number.isFinite(processCreatedMs)) return 'unknown'
  return processCreatedMs >= socketCreatedMs + SOCKET_TIME_RESOLUTION_MS ? 'younger' : 'owner'
}

/** The verdict for one pid among a port's rows: `younger` when it is younger than any socket it is named for (IPv4 and IPv6 are two). */
export function listenerVerdictFor(pid: number, ages: ListenerAge[] | null): ListenerVerdict {
  const verdicts = (ages ?? []).filter(a => a.pid === pid).map(a => listenerVerdict(a.socketCreatedMs, a.processCreatedMs))
  if (verdicts.includes('younger')) return 'younger'
  return verdicts.includes('owner') ? 'owner' : 'unknown'
}

// No double quotes anywhere: the script travels as one argv element. Milliseconds, so the numbers stay exact in JSON.
function listenerAgesScript(port: number): string {
  return [
    `$out = New-Object System.Collections.ArrayList`,
    `foreach ($c in @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)) { $o = [ordered]@{ pid = [int]$c.OwningProcess; socketCreatedMs = $null; processCreatedMs = $null }`,
    `if ($c.CreationTime) { $o.socketCreatedMs = [long][math]::Floor($c.CreationTime.ToFileTimeUtc() / 10000) }`,
    `$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess)`,
    `if ($p -and $p.CreationDate) { $o.processCreatedMs = [long][math]::Floor($p.CreationDate.ToFileTimeUtc() / 10000) }`,
    `[void]$out.Add($o) }`,
    `ConvertTo-Json -Compress -InputObject @($out)`,
    // Nothing listening is an empty list, not a failed command.
    `exit 0`,
  ].join('; ')
}

const timeOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Every listening socket on `port` with the two creation times, or null when the reading failed (said in one line).
 * Windows only (PowerShell + CIM), async and bounded like `readPortListener`; an empty list is nothing listening.
 */
export async function readListenerAges(port: number, run: (script: string) => Promise<string> = runPowerShell, log: (line: string) => void = console.log): Promise<ListenerAge[] | null> {
  try {
    const out = (await run(listenerAgesScript(port))).trim()
    if (!out) return []
    const parsed = JSON.parse(out) as unknown
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown> | null>
    return rows.filter((r): r is Record<string, unknown> => !!r && typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0)
      .map(r => ({ pid: r.pid as number, socketCreatedMs: timeOrNull(r.socketCreatedMs), processCreatedMs: timeOrNull(r.processCreatedMs) }))
  } catch (err) {
    log(`[llama-cpp] could not read when the socket on port ${port} and its process were created: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export async function portOwner(port: number, platform: string = process.platform): Promise<PortOwner> {
  // Off Windows there is nothing to read, and the lazy wait asks again on every poll: answer without a log line.
  if (platform !== 'win32') return { owner: 'unknown', detail: 'port ownership is read on Windows only' }
  return classifyPortOwner(await readPortListener(port))
}
