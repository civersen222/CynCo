/**
 * engine/apps/portTree.ts — the process listening on a port, what started it,
 * and every process on the machine, with command lines.
 *
 * `engine/llama/portOwner.ts` reads the listener and its parent's name, which is
 * enough to tell a CynCo engine's server from any other. Naming an app needs the
 * command lines up the chain (`bash scripts/start-llm.sh`), and deciding whether
 * an app is in use needs the whole list. Windows only, through PowerShell and
 * CIM, async and bounded like `portOwner.ts`; what cannot be read is null.
 */
import { execFile } from 'child_process'
import { listenerVerdict } from '../llama/portOwner.js'

export type Proc = {
  pid: number
  name: string
  /** The executable's full path, or null when it could not be read. */
  exe: string | null
  commandLine: string | null
  /** Creation time, any monotonic number: only compared. */
  created: number
}

/** The listener and its ancestors, nearest first. The chain stops where a parent pid belongs to a later process (Windows reuses pids). */
export type PortTree = { listener: Proc; ancestors: Proc[] }

export type ListedProc = { pid: number; ppid: number; exe: string; commandLine: string }

// No double quotes anywhere: the script travels as one argv element and Windows
// argument quoting would mangle them.
function treeScript(port: number): string {
  return [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($c) { $all = @{}`,
    `Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = $_ }`,
    `$out = New-Object System.Collections.ArrayList`,
    `$p = $all[[int]$c.OwningProcess]`,
    `$n = 0`,
    `while ($p -and $n -lt 8) { [void]$out.Add([ordered]@{ pid = [int]$p.ProcessId; name = $p.Name; exe = $p.ExecutablePath; commandLine = $p.CommandLine; created = $p.CreationDate.ToFileTimeUtc() })`,
    `$pp = $all[[int]$p.ParentProcessId]`,
    `if ($pp -and $pp.CreationDate -le $p.CreationDate) { $p = $pp } else { $p = $null }`,
    `$n++ }`,
    `if ($out.Count -gt 0) { $l = $all[[int]$c.OwningProcess]; $out[0]['socketCreatedMs'] = $null; $out[0]['listenerCreatedMs'] = $null; if ($c.CreationTime) { $out[0]['socketCreatedMs'] = [long][math]::Floor($c.CreationTime.ToFileTimeUtc() / 10000) }; if ($l.CreationDate) { $out[0]['listenerCreatedMs'] = [long][math]::Floor($l.CreationDate.ToFileTimeUtc() / 10000) } }`,
    `ConvertTo-Json -Compress -InputObject @($out) }`,
    // Nothing listening is an empty answer, not a failed command.
    `exit 0`,
  ].join('; ')
}

const LIST_SCRIPT = `Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $_.ExecutablePath + '|' + $_.CommandLine }`

export type RunPowerShell = (script: string) => Promise<string>

export const runPowerShell: RunPowerShell = (script) => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') { reject(new Error('processes are read on Windows only')); return }
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
})

function toProc(v: unknown): Proc | null {
  const j = v as Record<string, unknown>
  if (!j || typeof j.pid !== 'number' || typeof j.name !== 'string') return null
  return {
    pid: j.pid, name: j.name,
    exe: typeof j.exe === 'string' && j.exe ? j.exe : null,
    commandLine: typeof j.commandLine === 'string' && j.commandLine ? j.commandLine : null,
    created: typeof j.created === 'number' ? j.created : 0,
  }
}

/** The listener on `port` and its ancestors, or null when nothing listens or it cannot be read. */
export async function readPortTree(port: number, run: RunPowerShell = runPowerShell, log: (line: string) => void = console.log): Promise<PortTree | null> {
  try {
    const out = (await run(treeScript(port))).trim()
    if (!out) return null
    // One parse for both readers (`parseTree`); a listener younger than its socket is not the listener.
    const tree = parseTree(port, out, log)
    if (tree === 'younger-than-socket') return null
    return tree
  } catch (err) {
    log(`[apps] could not read who holds port ${port}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** `pid|ppid|exe|command line` per line; the command line may itself contain `|`. */
export function parseProcessList(out: string): ListedProc[] {
  const rows: ListedProc[] = []
  for (const line of out.split(/\r?\n/)) {
    const a = line.indexOf('|'), b = line.indexOf('|', a + 1), c = line.indexOf('|', b + 1)
    if (a < 0 || b < 0 || c < 0) continue
    const pid = Number(line.slice(0, a)), ppid = Number(line.slice(a + 1, b))
    if (!Number.isInteger(pid) || pid <= 0) continue
    rows.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, exe: line.slice(b + 1, c), commandLine: line.slice(c + 1) })
  }
  return rows
}

/** Every process on the machine. Throws when the list cannot be read: a caller must not decide on an empty list. */
export async function listProcesses(run: RunPowerShell = runPowerShell): Promise<ListedProc[]> {
  return parseProcessList(await run(LIST_SCRIPT))
}

/**
 * F255: Windows names as a listening socket's owner the pid of the process that made it, also after that process has
 * ended and a process it started inherited the socket; the number may be another process's by then. The chain above
 * already stops where a parent is younger than its child; this is the same test for the listener against its socket
 * (`listenerVerdict`, `engine/llama/portOwner.ts`). A listener created after its socket is not the listener, so the
 * tree is null, as when nothing can be read. Times that could not be read decide nothing.
 *
 * The line is said once per port, pid and socket time (`saidChangedHands`): the lazy wait asks every 5 s for up to
 * 30 minutes, and the same socket would otherwise be said about 360 times. The answer is null at every ask.
 */
function listenerChangedHands(port: number, parsed: unknown, listener: Proc, log: (line: string) => void): boolean {
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null | undefined
  const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const socket = time(first?.socketCreatedMs)
  if (listenerVerdict(socket, time(first?.listenerCreatedMs)) !== 'younger') return false
  const key = `${port}:${listener.pid}:${socket}`
  if (saidChangedHands.has(key)) return true
  // A handful of keys in a day; the bound only keeps a process that runs for months from holding them all.
  if (saidChangedHands.size >= 64) saidChangedHands.clear()
  saidChangedHands.add(key)
  log(`[apps] port ${port}: pid ${listener.pid} (${listener.name}) was created after the socket it is listed for: the process that made the socket has ended and the number is another process's now, so nothing on the port is read as its listener`)
  return true
}

/** The port, pid and socket time of every `[apps] port` line said, so each is said once (`listenerChangedHands`). */
const saidChangedHands = new Set<string>()

/**
 * What listens on `port` now, against `was`, the listener read seconds earlier: `same` (the same pid created at the
 * same time), `free` (nothing listens), `other` (another process, or a later one with the same number) or `unread`
 * (`because`: the reading failed, its listener is younger than its socket, or a creation time is missing on either side).
 */
export type ListenerNow = { kind: 'same' } | { kind: 'free' } | { kind: 'other'; now: Proc } | { kind: 'unread'; because: UnreadBecause }

/**
 * F255: between the reading that identified a port's listener and its stop, the owner is told, an app's processes are
 * listed and a debt is written: seconds in which the listener can end and its number go to another process. A stop
 * reads the port again here immediately before it, and goes ahead only on `same`. One `readPortTree` reading; the
 * text it read is parsed by `readPortTree` itself, so the two read the port the same way.
 */
export async function listenerNow(port: number, was: Proc, run: RunPowerShell = runPowerShell, log: (line: string) => void = console.log): Promise<ListenerNow> {
  const failed = (why: string): ListenerNow => {
    log(`[apps] could not read who holds port ${port} again before stopping pid ${was.pid}: ${why}`)
    return { kind: 'unread', because: 'reading-failed' }
  }
  let tree: PortTree | 'younger-than-socket' | null
  try {
    const out = (await run(treeScript(port))).trim()
    if (!out) return { kind: 'free' }
    tree = parseTree(port, out, log)
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
  if (tree === 'younger-than-socket') return { kind: 'unread', because: 'younger-than-socket' }
  if (!tree) return failed('the answer names no process')
  const now = tree.listener
  const timed = was.created > 0 && now.created > 0
  if (now.pid === was.pid && timed && now.created === was.created) return { kind: 'same' }
  if (now.pid !== was.pid || timed) return { kind: 'other', now }
  return { kind: 'unread', because: 'time-missing' }
}

/** Why the port's second look answered `unread`: only `younger-than-socket` is a finding about the port. */
export type UnreadBecause = 'reading-failed' | 'younger-than-socket' | 'time-missing'

/**
 * Wave 24, round three (check X-4): a second look that could not be made, or whose two readings cannot be compared,
 * decides nothing, the rule `killProcessOnPort` (`engine/llama/processManager.ts`) already follows. The stop then goes
 * ahead by the pid read earlier, as it did before the second look: refusing there would make one PowerShell that failed
 * once keep the model unloaded (the lazy engine remembers a refused hand-off as a server it could not stop until its
 * next load). A listener younger than its socket is a finding about the port, and stops nothing.
 */
export function lookDecidedNothing(now: ListenerNow): now is { kind: 'unread'; because: 'reading-failed' | 'time-missing' } {
  return now.kind === 'unread' && now.because !== 'younger-than-socket'
}

/** The one log line of a stop that goes ahead as it was read (`lookDecidedNothing`). */
export function stoppedAsReadLine(port: number, pid: number, because: 'reading-failed' | 'time-missing'): string {
  const why = because === 'reading-failed' ? 'the reading failed' : 'a creation time is missing on one side, so the two readings cannot be compared'
  return `[apps] port ${port} could not be read again just before the stop (${why}): pid ${pid} is stopped as it was read`
}

/**
 * The text of the tree script parsed: the tree, `younger-than-socket` when its listener was created after its socket
 * (`listenerChangedHands`), or null when the answer names no process. Throws when the text is not JSON.
 */
function parseTree(port: number, out: string, log: (line: string) => void): PortTree | 'younger-than-socket' | null {
  const parsed = JSON.parse(out) as unknown
  const procs = (Array.isArray(parsed) ? parsed : [parsed]).map(toProc).filter((p): p is Proc => p !== null)
  if (procs.length === 0) return null
  if (listenerChangedHands(port, parsed, procs[0], log)) return 'younger-than-socket'
  return { listener: procs[0], ancestors: procs.slice(1) }
}
