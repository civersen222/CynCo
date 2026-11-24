/**
 * engine/daemon/housekeeping.ts: the daemon's hourly page about a service log over 1 GiB (F242).
 *
 * A service launcher appends its output with `>>` and rotates its log only when the service starts
 * (scripts/rotate-log.cmd), so between starts nothing bounds it: the embedding server's log reached
 * 26 GB that way. This pass looks at the `*.log` files (and the `*.log.1` the rotation keeps) directly
 * in one folder (the CynCo home) and pages once per file per 24 hours for each one over LOG_PAGE_BYTES. A page that was not taken is
 * tried again on the next pass. The memory of what was paged is the caller's map, in memory only:
 * a daemon restart may page once more.
 *
 * What it can touch: nothing on disk. It only lists and stats (oversizedLogs, read-only); it
 * deletes, moves, truncates and writes nothing, and starts no process. Never throws.
 */
import { LOG_PAGE_BYTES, oversizedLogs } from '../logCap.js'

const DAY_MS = 24 * 60 * 60 * 1000
const GIB = 1024 * 1024 * 1024

export type HousekeepingDeps = {
  /** The folder whose `*.log` files are looked at (not recursively). */
  logsDir: string
  /** Sends one page; resolves whether the server took it. */
  publish: (p: { title: string; message: string }) => Promise<boolean>
  now: () => number
  /** Path to the time it was last paged about; updated here. */
  lastPaged: Map<string, number>
  /** The oversized logs of a folder; default oversizedLogs. */
  list?: (dir: string, minBytes: number) => Array<{ path: string; bytes: number }>
  /** One line of the daemon log; default console.error. */
  log?: (line: string) => void
}

export const LOG_PAGE_TITLE = 'CynCo: a log is over 1 GiB'

/**
 * The page's message for one log. A restart frees no space by itself: the rotation renames the log to
 * <log>.1 and keeps it, so the message says so, and a <log>.1 over the size has its own message.
 */
export function logPageMessage(path: string, bytes: number): string {
  const size = `${(bytes / GIB).toFixed(1)} GiB`
  if (path.toLowerCase().endsWith('.log.1')) {
    return `${path} is the previous log the rotation keeps (${size}); nothing deletes it until the log passes its cap again. Delete it by hand to free the space.`
  }
  return `${path} is ${size}. A service log is rotated only when its service starts: stop and start its service with scripts\\cynco-services.ps1. The rotation keeps it as ${path}.1, so delete that by hand afterwards to free the space.`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runHousekeeping(deps: HousekeepingDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.error(line))
  const list = deps.list ?? oversizedLogs
  let logs: Array<{ path: string; bytes: number }>
  try {
    logs = list(deps.logsDir, LOG_PAGE_BYTES)
  } catch (e) {
    log(`[daemon] the service logs in ${deps.logsDir} could not be listed: ${errText(e)}`)
    return
  }
  for (const { path, bytes } of logs) {
    const last = deps.lastPaged.get(path)
    if (last !== undefined && deps.now() - last < DAY_MS) continue
    let sent = false
    let why = 'the server did not take it'
    try {
      sent = await deps.publish({ title: LOG_PAGE_TITLE, message: logPageMessage(path, bytes) })
    } catch (e) {
      why = errText(e)
    }
    if (sent === true) deps.lastPaged.set(path, deps.now())
    else log(`[daemon] log page not sent: ${path}: ${why}`)
  }
}
