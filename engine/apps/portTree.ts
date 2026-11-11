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
    const parsed = JSON.parse(out) as unknown
    const procs = (Array.isArray(parsed) ? parsed : [parsed]).map(toProc).filter((p): p is Proc => p !== null)
    if (procs.length === 0) return null
    return { listener: procs[0], ancestors: procs.slice(1) }
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
