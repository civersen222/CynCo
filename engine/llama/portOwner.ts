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

export type PortOwner = { owner: 'engine' | 'foreign' | 'unknown'; detail: string }

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

export async function portOwner(port: number, platform: string = process.platform): Promise<PortOwner> {
  // Off Windows there is nothing to read, and the lazy wait asks again on every poll: answer without a log line.
  if (platform !== 'win32') return { owner: 'unknown', detail: 'port ownership is read on Windows only' }
  return classifyPortOwner(await readPortListener(port))
}
