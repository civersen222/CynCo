/**
 * scripts/cynco-audit.mjs: the tool-call audit of unattended runs, from the command line (F242).
 *
 *   bun scripts/cynco-audit.mjs check
 *       Asks whether the audit can be written now: a probe record is appended and fsynced. One line
 *       on stdout, `writing to <real audit folder>` (exit 0) or the reason (exit 3). Nothing else
 *       goes to stdout, because scripts/dispatch-mission.sh captures it as one line.
 *   bun scripts/cynco-audit.mjs verify [--run <id>] [file ...]
 *       Reads day files back: per process, the sequence numbers missing, a head that is missing, and
 *       every start that has no end. The files default to today's and yesterday's in the audit
 *       folder; with --run, to every day file dated on or after the day before the run id's date,
 *       and only the processes that wrote a record for that run are reported. Exit 0 when clean,
 *       1 when something was found, 2 for bad arguments, 3 when the audit folder is refused.
 *
 * A start without an end is expected for the call that was running when a mission engine was
 * stopped; it is printed as a fact, and the reader of the driver log judges it. This script starts
 * no process. `check` writes its probe record and, as every first open of the audit in a process
 * does, applies the 90-day retention of day files in the audit folder (never anything outside it);
 * `verify` only reads.
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT_FILE_RE, auditRefusal, resolveAuditDir, verifyAuditFiles } from '../engine/audit/toolAudit.js'
import { auditDir } from '../engine/paths.js'
import { RUN_ID_RE } from '../engine/missionEnv.js'

const EXIT_OK = 0
const EXIT_FOUND = 1
const EXIT_USAGE = 2
const EXIT_REFUSED = 3

const USAGE = 'usage: bun scripts/cynco-audit.mjs check | verify [--run <id>] [file ...]'

/**
 * The answer of `check`. `io.auditRefusal` is the gate question (null means a probe record was
 * written just now); `io.realDir` names the folder it wrote to.
 */
export function checkLine(io = {}) {
  const refusal = io.auditRefusal ?? (() => auditRefusal({ by: 'dispatch' }))
  const realDir = io.realDir ?? (() => {
    const r = resolveAuditDir({ dir: auditDir(), home: homedir() })
    return r.ok ? r.dir : String(auditDir())
  })
  const why = refusal()
  if (why === null) return { exit: EXIT_OK, line: `writing to ${realDir()}` }
  return { exit: EXIT_REFUSED, line: why }
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The local date of the run id's stamp (`<label>-<YYYYMMDD>T<HHMMSS>-<hex>`), or null. */
function runDate(runId) {
  const m = /-(\d{4})(\d{2})(\d{2})T\d{6}-[0-9a-f]{4}$/.exec(runId)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * Which day files of a folder listing to read: today's and yesterday's, or with a run id every one
 * dated on or after the day before the run's date. Pure; `now` is injected.
 */
export function selectDayFiles(names, { runId = null, now = new Date() } = {}) {
  const day = (d, back) => localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back))
  let from
  let to = null
  if (runId) {
    const d = runDate(runId)
    const [y, m, dd] = d.split('-').map(Number)
    from = day(new Date(y, m - 1, dd), 1)
  } else {
    from = day(now, 1)
    to = day(now, 0)
  }
  return names
    .filter(n => AUDIT_FILE_RE.test(n))
    .filter(n => { const d = n.slice(0, 10); return d >= from && (to === null || d <= to) })
    .sort()
}

function seqList(gaps, gapCount) {
  const parts = gaps.map(g => (g.from === g.to ? String(g.from) : `${g.from}-${g.to}`))
  const listed = gaps.reduce((n, g) => n + (g.to - g.from + 1), 0)
  return parts.join(', ') + (gapCount > listed ? ` (and ${gapCount - listed} more)` : '')
}

/**
 * The lines and the exit code of `verify` over `paths`, for one run id or for every process.
 * Pure over the files it reads; a malformed run id is exit 2 and reads nothing.
 */
export function verifyReport(paths, runId = null) {
  if (runId !== null && !RUN_ID_RE.test(runId)) {
    return { exit: EXIT_USAGE, lines: [`[tool-audit] verify: ${runId} is not a run id (<label>-<YYYYMMDD>T<HHMMSS>-<4 hex>)`] }
  }
  const r = verifyAuditFiles(paths)
  const procs = runId === null ? r.procs : r.procs.filter(p => p.runs.includes(runId))
  if (runId !== null && procs.length === 0) {
    return { exit: EXIT_FOUND, lines: [`[tool-audit] verify run ${runId}: no record carries this run id`] }
  }
  const records = procs.reduce((n, p) => n + p.records, 0)
  const gaps = procs.reduce((n, p) => n + p.gapCount, 0)
  const open = procs.reduce((n, p) => n + p.openStarts.length, 0)
  const heads = procs.filter(p => p.headMissing).length
  const lines = [
    `[tool-audit] verify${runId !== null ? ` run ${runId}` : ''}: ${procs.length} process(es), ${records} record(s), ${gaps} gap(s), ${open} start(s) without an end, ${r.unparsable} unparsable line(s)`,
  ]
  for (const p of procs) {
    if (p.gapCount > 0) lines.push(`[tool-audit] verify: ${p.proc} is missing seq ${seqList(p.gaps, p.gapCount)}`)
    if (p.headMissing) lines.push(`[tool-audit] verify: ${p.proc} has no record before seq ${p.firstSeq}, and the file of its first day was read`)
    for (const s of p.openStarts) {
      lines.push(`[tool-audit] verify: ${p.proc} seq ${s.seq} (${s.ts}, ${s.src}${s.tool ? `, ${s.tool}` : ''}) started and has no end`)
    }
  }
  const clean = gaps === 0 && heads === 0 && open === 0 && r.unparsable === 0
  return { exit: clean ? EXIT_OK : EXIT_FOUND, lines }
}

/** The command line. Returns the exit code; prints its lines. */
export function main(argv, io = {}) {
  const out = io.out ?? ((l) => console.log(l))
  const err = io.err ?? ((l) => console.error(l))
  const [cmd, ...rest] = argv
  if (cmd === 'check') {
    if (rest.length > 0) { err(USAGE); return EXIT_USAGE }
    const r = checkLine(io)
    out(r.line)
    return r.exit
  }
  if (cmd !== 'verify') { err(USAGE); return EXIT_USAGE }
  let runId = null
  const files = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--run') {
      const v = rest[i + 1]
      if (v === undefined || v.startsWith('--')) { err(USAGE); return EXIT_USAGE }
      runId = v
      i++
    } else if (rest[i].startsWith('--')) {
      err(USAGE)
      return EXIT_USAGE
    } else {
      files.push(rest[i])
    }
  }
  if (runId !== null && !RUN_ID_RE.test(runId)) {
    out(`[tool-audit] verify: ${runId} is not a run id (<label>-<YYYYMMDD>T<HHMMSS>-<4 hex>)`)
    return EXIT_USAGE
  }
  let paths = files.map(f => resolve(f))
  if (paths.length === 0) {
    const r = resolveAuditDir({ dir: io.dir !== undefined ? io.dir : auditDir(), home: io.home ?? homedir() })
    if (!r.ok) { out(`[tool-audit] verify: ${r.reason}`); return EXIT_REFUSED }
    let names
    try {
      names = readdirSync(r.dir)
    } catch (e) {
      out(`[tool-audit] verify: the audit folder ${r.dir} could not be listed (${e?.message ?? e})`)
      return EXIT_REFUSED
    }
    paths = selectDayFiles(names, { runId, now: io.now ? io.now() : new Date() }).map(n => join(r.dir, n))
  }
  const report = verifyReport(paths, runId)
  for (const l of report.lines) out(l)
  return report.exit
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  process.exit(main(process.argv.slice(2)))
}
