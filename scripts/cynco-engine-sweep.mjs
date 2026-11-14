// scripts/cynco-engine-sweep.mjs
// Which engine processes a mission dispatch kills before it starts its own (F234).
//
// A dispatch starts from a fresh engine (scripts/dispatch-mission.sh, "a fresh
// engine, always"), so it kills every live engine tree first. It used to select
// `bun.exe` whose command line is `-like '*engine/main.ts*'`: forward slash only.
// The always-on phone engine (the Task Scheduler task "CynCo headless engine",
// scripts/run-headless-engine.cmd) runs `bun engine\main.ts` with a backslash,
// so the sweep missed it, the mission engine found the bridge port taken and the
// launch refused with "[ws] Port 9160 in use".
//
// An engine is: bun running engine/main.ts or engine\main.ts (any prefix, either
// slash). A daemon one-shot (`--run-task`, engine/daemon/taskRunner.ts) is never
// selected: it holds a GPU claim of its own, and the old sweep never reached it
// either (the daemon spawns it by a backslash path). A process whose command line
// cannot be read is not killed on a guess.
//
// The phone engine is also stopped through its task, not only killed: the task
// restarts on failure (scripts/cynco-services.ps1 registers RestartCount 3), so a
// killed phone engine could come back onto the port mid-dispatch. dispatch-mission.sh
// stops it with `cynco-services.ps1 stop engine` and starts it again when the
// mission is over.
//
//   bun scripts/cynco-engine-sweep.mjs            the PIDs to kill, one per line
//   bun scripts/cynco-engine-sweep.mjs --explain  every bun.exe and what would happen to it
//
// Exit 1 when the process list cannot be read: a dispatch must not go ahead blind.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** `engine/main.ts` or `engine\main.ts`, as a path segment (not `myengine/main.ts`). */
const ENGINE_ENTRY = /(^|[\s"'\\/])engine[\\/]main\.ts(["'\s]|$)/i
const ONE_SHOT = /(^|\s)--run-task(\s|=|$)/

/** @param {{ pid: number, commandLine: string }} row */
export function isSweptEngine(row) {
  if (!row.commandLine) return false
  return ENGINE_ENTRY.test(row.commandLine) && !ONE_SHOT.test(row.commandLine)
}

/** Why a row is killed or kept, for --explain. */
export function verdict(row) {
  if (isSweptEngine(row)) return 'kill: an engine'
  if (!row.commandLine) return 'keep: its command line could not be read'
  if (ENGINE_ENTRY.test(row.commandLine)) return 'keep: a daemon one-shot (--run-task)'
  return 'keep: not an engine'
}

/** `pid|command line` per line; the command line may itself contain `|`. */
export function parseProcessRows(out) {
  const rows = []
  for (const line of String(out).split(/\r?\n/)) {
    const a = line.indexOf('|')
    if (a < 0) continue
    const pid = Number(line.slice(0, a))
    if (!Number.isInteger(pid) || pid <= 0) continue
    rows.push({ pid, commandLine: line.slice(a + 1) })
  }
  return rows
}

const LIST = "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"

function powershell() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', LIST], { encoding: 'utf-8', windowsHide: true })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`powershell exited ${r.status}: ${String(r.stderr).trim().split('\n')[0]}`)
  return r.stdout ?? ''
}

/** Every bun.exe on this machine. Throws when the list cannot be read. */
export function bunRows({ platform = process.platform, run = powershell } = {}) {
  if (platform !== 'win32') return []
  return parseProcessRows(run())
}

/** The PIDs a dispatch kills, never its own. Throws when the list cannot be read. */
export function sweptEnginePids({ self = process.pid, ...deps } = {}) {
  return bunRows(deps).filter(r => r.pid !== self && isSweptEngine(r)).map(r => r.pid)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--explain')) {
      for (const r of bunRows()) console.log(`${r.pid}  ${verdict(r)}  ${r.commandLine.slice(0, 140)}`)
    } else {
      for (const pid of sweptEnginePids()) console.log(pid)
    }
  } catch (e) {
    console.error(`[engine-sweep] could not list bun processes: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
