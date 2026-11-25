/**
 * engine/daemon/housekeeping.ts: the daemon's hourly page about a service log over 1 GiB (F242).
 *
 * A service launcher appends its output with `>>` and rotates its log only when the service starts
 * (scripts/rotate-log.cmd), so between starts nothing bounds it: the embedding server's log reached
 * 26 GB that way. This pass looks at the `*.log` files (and the `*.log.1` the rotation keeps) directly
 * in one folder (the CynCo home) and pages once per file per 24 hours for each one over LOG_PAGE_BYTES. A page that was not taken is
 * tried again on the next pass. The memory of what was paged is the caller's map; since wave 15 the
 * daemon keeps it in one small file of its state folder (`PAGED_FILE` in the CynCo home: `loadLastPaged`,
 * `saveLastPaged`), so a restart does not page again within the day. The same record keeps a refused
 * due run to one page a day for each reason (`onceADayRefusals`).
 *
 * What it can touch: the logs are only listed and stat'ed (oversizedLogs, read-only); nothing is
 * deleted, moved or truncated, and no process is started. The one file written is the record of pages
 * sent (tmp and rename). Never throws.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  /** Called with `lastPaged` after a page was taken (wave 15: the daemon writes it to `PAGED_FILE`). */
  save?: (lastPaged: Map<string, number>) => void
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
    if (sent === true) {
      deps.lastPaged.set(path, deps.now())
      deps.save?.(deps.lastPaged)
    } else log(`[daemon] log page not sent: ${path}: ${why}`)
  }
}

// ─── The record of pages sent, kept across a restart (wave 15, NOW.md:94) ───────────────────────

/** The file, in the daemon's state folder (the CynCo home), that holds when each page was last sent. */
export const PAGED_FILE = 'daemon-paged.json'

/** The record of pages sent; a missing file is an empty record, an unreadable one too (said in the log). Never throws. */
export function loadLastPaged(file: string, log: (line: string) => void = (l) => console.error(l)): Map<string, number> {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[daemon] the record of pages sent (${file}) cannot be read (${errText(e)}); starting with none`)
    return new Map()
  }
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object')
    return new Map(Object.entries(o).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])))
  } catch (e) {
    log(`[daemon] the record of pages sent (${file}) cannot be read (${errText(e)}); starting with none`)
    return new Map()
  }
}

/** Writes the record (tmp and rename), leaving out what is older than a day. A failure is said in the log; never throws. */
export function saveLastPaged(file: string, lastPaged: Map<string, number>, now: () => number = Date.now, log: (line: string) => void = (l) => console.error(l)): void {
  const t = now()
  for (const [k, v] of lastPaged) if (t - v >= DAY_MS) lastPaged.delete(k)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(lastPaged)))
    renameSync(tmp, file)
  } catch (e) {
    log(`[daemon] the record of pages sent (${file}) could not be written (${errText(e)}); a restart may page again`)
  }
}

/** The title of the mission runner's page about a refused run (`missionRunner.ts`, `complete`). */
export const REFUSED_RUN_TITLE = /^CynCo refused a run of mission /

/**
 * The key of a refused run's page (wave 15b, check P1-C10): the title and the message with what changes
 * from one due run to the next left out, so one standing reason is one key. A run id (`<label>-<yyyymmdd>T<hhmmss>-<hex>`,
 * `mintRunId`) is `<run>`, a time (ISO) is `<time>`, every other number is `#`. Pure.
 */
export function refusedRunKey(title: string, message: string): string {
  const reason = message
    .replace(/[A-Za-z0-9][A-Za-z0-9._-]*-\d{8}T\d{6}-[0-9a-f]{4}\b/g, '<run>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\d+/g, '#')
  return `refused|${title}|${reason}`
}

/**
 * A publish that sends a refused run's page at most once a day for each reason (wave 15, NOW.md:89):
 * a run refused by a standing cause (the models record, the sandbox root) is due again every few
 * minutes, and each due run paged. The key is the page's title and message (`refusedRunKey`: run ids,
 * times and numbers left out, wave 15b), so another mission or another reason pages at once. Every other page passes as it is. A page not taken is not recorded,
 * so the next due run pages. A page held back is said in the log and answers true.
 */
export function onceADayRefusals(o: {
  publish: (p: { title: string; message: string; priority?: number }) => Promise<boolean>
  lastPaged: Map<string, number>; now: () => number
  save?: (lastPaged: Map<string, number>) => void
  log?: (line: string) => void
}): (p: { title: string; message: string; priority?: number }) => Promise<boolean> {
  const log = o.log ?? ((l: string) => console.log(l))
  return async (p) => {
    if (!REFUSED_RUN_TITLE.test(p.title)) return o.publish(p)
    const key = refusedRunKey(p.title, p.message)
    const last = o.lastPaged.get(key)
    if (last !== undefined && o.now() - last < DAY_MS) {
      log(`[daemon] not paged again today (paged at ${new Date(last).toISOString()}): ${p.title}: ${p.message}`)
      return true
    }
    const sent = await o.publish(p)
    if (sent === true) {
      o.lastPaged.set(key, o.now())
      o.save?.(o.lastPaged)
    }
    return sent
  }
}
