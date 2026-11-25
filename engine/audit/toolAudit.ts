/**
 * engine/audit/toolAudit.ts: the tool-call audit of unattended runs (F242).
 *
 * On 2026-11-22 a mission deleted the owner's home folder, and every record of what it had run
 * lived inside that folder. This module keeps evidence that survives: every tool call of a
 * contained run has its full input on disk, outside the home folder, fsynced BEFORE the tool
 * starts, and its exit code and duration after; every refused call has a record. A run that cannot
 * write the record runs nothing: `start` answers a refusal, never a throw.
 *
 * One JSON object per line in `<audit folder>/<local YYYY-MM-DD>.jsonl` (then `<date>.1.jsonl` past
 * the size cap; records are never moved). Several processes append to one file; `proc` separates
 * them and `seq` numbers each one's records from 1, so a gap is a record that was attempted and
 * did not reach the disk. Checks whose text is withheld from the model (`WITHHELD_SRC`) are
 * written as a sha256 and a byte count, never as text (F34, F37).
 *
 * The writer never creates the audit folder and never writes its marker: the machine setup script
 * does both, and a folder without the marker is refused. There is no switch: a process that holds
 * no run context (an interactive engine) is simply not audited, and a test context that names no
 * audit folder is the only other way to be left out.
 *
 * Every line it prints starts `[tool-audit]`; `[audit]` belongs to the per-session governance
 * logger beside it (`auditLogger.ts`), which is a different thing and never refuses.
 *
 * `containmentFault` and `setContainmentFaultSink` are the one channel through which a refusal of
 * layer containment, audit or integrity ends a run whatever the model does next: callers raise it
 * without holding a reference to the conversation loop, and the loop registers the one sink that
 * turns it into a critical governance alert. The sink is one slot of module state: a process has
 * at most one loop, and the last one constructed owns it.
 */
import {
  appendFileSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readSync, readdirSync, statSync,
} from 'node:fs'
import { basename, join, posix, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  listUnprotectedVolumes, runContainment,
  type ContainmentKind, type RefusalLayer, type RunContainment,
} from '../containment.js'
import { auditDir, sandboxRoot } from '../paths.js'
import { isInside, realPathOf } from '../realPath.js'
import { pruneOldFiles } from '../logCap.js'

// ─── Constants and types ─────────────────────────────────────────────────────────────────────

/** The marker file the setup script writes into the audit folder; a folder without it is refused. */
export const AUDIT_MARKER = '.cynco-audit'
/** The names of the day files: `<YYYY-MM-DD>.jsonl` and `<YYYY-MM-DD>.<n>.jsonl`. */
export const AUDIT_FILE_RE = /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/
export const AUDIT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const AUDIT_KEEP_DAYS = 90
export const AUDIT_OUTPUT_CHARS = 2000
export const AUDIT_REASON_CHARS = 500
/** What a model, an alert and an outcome file are told when a start record could not be written. No path in it. */
export const AUDIT_NOT_WRITTEN = (code: string): string =>
  `the record of this call could not be written before it ran (${code})`

export type AuditSrc = 'tool' | 'subagent' | 'contract' | 'best-of-n' | 'lsp' | 'precheck'
                     | 'driver' | 'driver-probe' | 'driver-marker' | 'gate' | 'dispatch-check'
/** Sources whose command and output are withheld from the model: written as hashes and lengths only. */
export const WITHHELD_SRC: readonly AuditSrc[] = ['contract', 'gate', 'driver-marker', 'driver-probe']

export type AuditProbeBy = 'dispatch' | 'dispatch-check' | 'capability' | 'preflight' | 'task-runner' | 'driver'

export interface ToolAudit {
  open(): { ok: true; dir: string } | { ok: false; reason: string }
  probe(by: AuditProbeBy): string | null
  start(rec: { src: AuditSrc; tool?: string; input?: unknown; command?: string; cwd: string;
               escalate?: object }): { ok: true; call: number } | { ok: false; reason: string }
  end(call: number, rec: { isError: boolean; exitCode?: number | null; ms: number; output?: string }): void
  /** `by`: the executor's checks, the loop's (the main loop's or a sub-agent's), or a site that starts
   *  a process without the executor (a contract check, best-of-N tests, a precheck) refusing it first. */
  refused(rec: { src: AuditSrc; by: 'executor' | 'loop' | 'site'; tool?: string; input?: unknown; cwd: string;
                 layer?: RefusalLayer; reason: string }): void
}

type Kind = 'open' | 'probe' | 'start' | 'end' | 'refused'
type Outcome = { ok: true } | { ok: false; code: string; reason: string }

const TOOL_SRC: readonly AuditSrc[] = ['tool', 'subagent']
const isWithheld = (src: AuditSrc): boolean => WITHHELD_SRC.includes(src)

/** This process's id in every record: `<pid>-<boot ms, base 36>`, computed once. */
const PROC = `${process.pid}-${Date.now().toString(36)}`

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : `${e.name}: ${e.message}`
  }
  return String(e)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The end of the local day a day file is named for, in ms; null for a name that is not dated. */
function nameDateMs(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime()
  return Number.isFinite(t) ? t : null
}

function fold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function session(): string | undefined {
  const s = process.env.LOCALCODE_SESSION_ID
  return s !== undefined && s !== '' ? s : undefined
}

/** The `src` an open or probe record carries: which kind of process wrote it. */
function srcOfProbe(by: AuditProbeBy): AuditSrc {
  // Wave 19 (plan P6 item 1): the dispatch's own gate (`cynco-audit.mjs check --run`) is told from the driver's probe.
  if (by === 'dispatch-check') return 'dispatch-check'
  if (by === 'driver' || by === 'dispatch') return 'driver'
  if (by === 'task-runner') return 'precheck'
  return 'tool'
}

function srcOfKind(kind: ContainmentKind): AuditSrc {
  if (kind === 'precheck') return 'precheck'
  if (kind === 'grader') return 'gate'
  return 'tool'
}

// ─── The rate-limited fault line ─────────────────────────────────────────────────────────────

const FAULT_LINE_MS = 60_000
const faultLines = new Map<string, { last: number; suppressed: number }>()

/** `[tool-audit] <code>: <sentence>` for the first fault of a key, then at most one line a minute. */
function faultLine(key: string, reason: string): void {
  const now = Date.now()
  const s = faultLines.get(key)
  if (!s) {
    faultLines.set(key, { last: now, suppressed: 0 })
    console.error(`[tool-audit] ${reason}`)
    return
  }
  if (now - s.last < FAULT_LINE_MS) {
    s.suppressed++
    return
  }
  const more = s.suppressed
  s.last = now
  s.suppressed = 0
  console.error(`[tool-audit] ${reason}${more > 0 ? ` (${more} more since the last line)` : ''}`)
}

// ─── The fault channel ───────────────────────────────────────────────────────────────────────

type FaultSink = (layer: RefusalLayer, reason: string) => void
let faultSink: FaultSink | null = null

/**
 * A refusal of layer containment, audit or integrity: printed on stderr, then handed to the sink
 * (the conversation loop turns it into a critical `governance.alert`). Never throws.
 */
export function containmentFault(layer: RefusalLayer, reason: string): void {
  console.error(`[containment] fault: ${layer}: ${reason}`)
  const sink = faultSink
  if (!sink) return
  try {
    sink(layer, reason)
  } catch (e) {
    console.error(`[containment] fault sink threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The one consumer of `containmentFault`; the last loop constructed owns it, `null` clears it. */
export function setContainmentFaultSink(sink: FaultSink | null): void {
  faultSink = sink
}

// ─── The folder policy ───────────────────────────────────────────────────────────────────────

function volumeRoot(p: string): string | null {
  const m = /^([A-Za-z]):/.exec(p)
  return m ? `${m[1]!.toUpperCase()}:\\` : null
}

function normVolume(v: string): string {
  const m = /^([A-Za-z]):?[\\/]?$/.exec(v.trim())
  return m ? `${m[1]!.toUpperCase()}:\\` : v.trim().toUpperCase()
}

/**
 * Whether `dir` may hold the audit: set, absolute, local, on a protectable volume, and resolving
 * neither inside nor around the home folder nor the run's working folder. Never throws, creates
 * nothing, writes nothing. On success `dir` is the REAL path. `platform` governs only the two
 * syntactic checks (absolute, network); the real-path checks use the host's file system.
 */
export function resolveAuditDir(a: { dir: string | null; home: string; missionCwd?: string;
                                     unprotectedVolumes?: string[]; platform?: NodeJS.Platform;
                                     workspaceRoots?: string[] })
  : { ok: true; dir: string } | { ok: false; code: string; reason: string } {
  const platform = a.platform ?? process.platform
  const refuse = (code: string, sentence: string) => ({ ok: false as const, code, reason: `${code}: ${sentence}` })
  const dir = a.dir
  if (dir === null || dir === undefined || dir === '') {
    return refuse('audit-dir-unset', `LOCALCODE_AUDIT_DIR is not set and there is no default audit folder on ${platform}; set it to a folder on a local disk outside the home folder`)
  }
  const absolute = platform === 'win32' ? win32.isAbsolute(dir) : posix.isAbsolute(dir)
  if (!absolute) return refuse('audit-dir-relative', `the audit folder ${dir} is not an absolute path`)
  if (dir.startsWith('\\\\') || dir.startsWith('//')) {
    return refuse('audit-dir-network', `the audit folder ${dir} is a network path; it must be on a local NTFS disk`)
  }
  // A rooted path with no drive letter (`\cynco-audit`) lands on whichever drive is current.
  if (platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(dir)) {
    return refuse('audit-dir-relative', `the audit folder ${dir} names no drive letter, so it lands on whichever drive is current; give the full path, such as C:\\cynco-audit`)
  }
  const unprotected = (a.unprotectedVolumes ?? []).map(normVolume)
  const root = volumeRoot(dir)
  if (root !== null && unprotected.includes(root)) {
    return refuse('audit-dir-not-ntfs', `the audit folder ${dir} is on ${root}, a volume that integrity labels cannot protect; it must be on a local NTFS disk`)
  }
  let real: string
  let realHome: string
  let realCwd: string | null = null
  const realRoots: Array<{ given: string; real: string }> = []
  try {
    real = realPathOf(dir, { quiet: true })
    realHome = realPathOf(a.home, { quiet: true })
    if (a.missionCwd !== undefined && a.missionCwd !== '') realCwd = realPathOf(a.missionCwd, { quiet: true })
    for (const w of a.workspaceRoots ?? []) {
      if (typeof w === 'string' && w !== '') realRoots.push({ given: w, real: realPathOf(w, { quiet: true }) })
    }
  } catch (e) {
    return refuse('audit-dir-unwritable', `the audit folder ${dir} could not be resolved (${errText(e)})`)
  }
  // Judged again where the folder really lands: a junction on C: can point at the camera drive.
  const realRoot = volumeRoot(real)
  if (realRoot !== null && unprotected.includes(realRoot)) {
    return refuse('audit-dir-not-ntfs', `the audit folder ${dir} resolves to ${real}, on ${realRoot}, a volume that integrity labels cannot protect; it must be on a local NTFS disk`)
  }
  if (isInside(realHome, real) || isInside(real, realHome)) {
    return refuse('audit-dir-in-home', `the audit folder ${dir} resolves to ${real}, which is, is inside or contains the home folder ${a.home}; evidence kept there is deleted with it (F242)`)
  }
  if (realCwd !== null && (isInside(realCwd, real) || isInside(real, realCwd))) {
    return refuse('audit-dir-in-workspace', `the audit folder ${dir} resolves to ${real}, which is, is inside or contains the run's working folder ${a.missionCwd}, where the run can change it`)
  }
  for (const w of realRoots) {
    if (isInside(w.real, real) || isInside(real, w.real)) {
      return refuse('audit-dir-in-workspace', `the audit folder ${dir} resolves to ${real}, which is, is inside or contains ${w.given}, a folder a contained run may write, where the run can change it`)
    }
  }
  return { ok: true, dir: real }
}

// ─── The writer core: one per real folder per process ────────────────────────────────────────

interface DayFile { date: string; n: number; path: string; size: number; written: boolean; full: boolean }

interface Core {
  dir: string
  proc: string
  now: () => Date
  maxFileBytes: number
  keepDays: number
  seq: number
  opened: boolean
  file: DayFile | null
  /** Set once a day file this core wrote is gone or shorter: the reason, for the life of the process. */
  shrunk: string | null
  /** The source of each start that has no end yet, so the end is written the same way. */
  pending: Map<number, AuditSrc>
}

const cores = new Map<string, Core>()

function newCore(opts: { dir: string; proc?: string; now?: () => Date; maxFileBytes?: number; keepDays?: number }): Core {
  return {
    dir: opts.dir,
    proc: opts.proc ?? PROC,
    now: opts.now ?? (() => new Date()),
    maxFileBytes: opts.maxFileBytes ?? AUDIT_MAX_FILE_BYTES,
    keepDays: opts.keepDays ?? AUDIT_KEEP_DAYS,
    seq: 0,
    opened: false,
    file: null,
    shrunk: null,
    pending: new Map(),
  }
}

/** The shared core for a folder that has passed the policy (`dir` is its real path). */
function sharedCore(dir: string): Core {
  const key = fold(dir)
  let core = cores.get(key)
  if (!core) {
    core = newCore({ dir })
    cores.set(key, core)
  }
  return core
}

function unwritable(core: Core, e: unknown): Outcome {
  return { ok: false, code: 'audit-dir-unwritable', reason: `audit-dir-unwritable: the audit folder ${core.dir} could not be written (${errText(e)})` }
}

function shrunkReason(path: string, now: number, then: number): string {
  return `audit-file-shrunk: the audit file ${path} is gone or shorter than this process left it (${now} bytes, at least ${then} expected); records were removed, so nothing more is run`
}

/**
 * The day file the next record goes to. The folder is listed only when the local date changed or
 * the file last written reached the cap; the highest existing `n` for the date is adopted, and one
 * that is already full is passed over, so several processes converge on one file.
 */
function dayFile(core: Core): { ok: true; file: DayFile } | { ok: false; outcome: Outcome } {
  const date = localDate(core.now())
  const cur = core.file
  if (cur && cur.date === date && !cur.full) return { ok: true, file: cur }
  let names: string[]
  try {
    names = readdirSync(core.dir)
  } catch (e) {
    return { ok: false, outcome: unwritable(core, e) }
  }
  let n = 0
  for (const name of names) {
    if (!name.startsWith(date)) continue
    const m = /^\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.jsonl$/.exec(name)
    if (m && name.slice(0, 10) === date) n = Math.max(n, m[1] ? Number(m[1]) : 0)
  }
  if (cur && cur.date === date && cur.full && n <= cur.n) n = cur.n + 1
  const pathOf = (k: number) => join(core.dir, k === 0 ? `${date}.jsonl` : `${date}.${k}.jsonl`)
  for (let guard = 0; guard < 10_000; guard++) {
    let size = -1
    try {
      const st = statSync(pathOf(n))
      size = st.isFile() ? st.size : -1
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, outcome: unwritable(core, e) }
    }
    if (size < core.maxFileBytes) break
    n++
  }
  const file: DayFile = { date, n, path: pathOf(n), size: 0, written: false, full: false }
  core.file = file
  return { ok: true, file }
}

/** A record that cannot be turned into one line of JSON (a BigInt, a cycle, a throwing toJSON). */
function unserialisable(e: unknown): Outcome & { ok: false } {
  return { ok: false, code: 'audit-record-unserialisable', reason: `audit-record-unserialisable: the record could not be serialised (${errText(e)})` }
}

/** JSON text that never throws: the outcome of a value that cannot be serialised instead. */
function jsonOf(value: unknown): { ok: true; text: string } | (Outcome & { ok: false }) {
  try {
    return { ok: true, text: JSON.stringify(value) ?? '' }
  } catch (e) {
    return unserialisable(e)
  }
}

/**
 * Write one record: the line built first (a value that cannot be serialised is a failed write), one
 * open, one append, an fsync for open, probe and start, the size read back, and a close in a
 * `finally`. `seq` is consumed before the write, even when it fails.
 *
 * A day file this process already wrote is opened WITHOUT create and measured on the open handle
 * before the append: gone or shorter is `audit-file-shrunk`, and it is never recreated silently. On
 * the first write to a day file whose last byte is not a newline (a record torn by a power loss),
 * the record starts on a line of its own.
 */
function writeRecord(core: Core, kind: Kind, src: AuditSrc, run: string | null, body: Record<string, unknown>)
  : Outcome & { seq: number } {
  const seq = ++core.seq
  if (core.shrunk !== null) return { ok: false, code: 'audit-file-shrunk', reason: core.shrunk, seq }
  const now = core.now()
  const json = jsonOf({ v: 1, ts: now.toISOString(), kind, proc: core.proc, seq, src, run, ...body })
  if (!json.ok) return { ...json, seq }
  const line = json.text + '\n'
  const picked = dayFile(core)
  if (!picked.ok) return { ...picked.outcome, seq }
  const file = picked.file
  const sync = kind === 'open' || kind === 'probe' || kind === 'start'
  const shrunk = (size: number) => {
    core.shrunk = shrunkReason(file.path, Math.max(size, 0), file.size)
    return { ok: false as const, code: 'audit-file-shrunk', reason: core.shrunk, seq }
  }
  let fd: number | null = null
  try {
    let lead = ''
    if (file.written) {
      try {
        fd = openSync(file.path, fsConstants.O_WRONLY | fsConstants.O_APPEND)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return shrunk(-1)
        throw e
      }
      const before = fstatSync(fd).size
      if (before < file.size) return shrunk(before)
    } else {
      fd = openSync(file.path, 'a+')
      const before = fstatSync(fd).size
      if (before > 0) {
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, before - 1)
        if (last[0] !== 0x0a) lead = '\n'
      }
    }
    appendFileSync(fd, lead + line)
    if (sync) fsyncSync(fd)
    const size = fstatSync(fd).size
    file.size = size
    file.written = true
    if (size >= core.maxFileBytes) file.full = true
  } catch (e) {
    return { ...unwritable(core, e), seq }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (e) {
        console.error(`[tool-audit] closing ${file.path} failed: ${errText(e)}`)
      }
    }
  }
  return { ok: true, seq }
}

// ─── Views ───────────────────────────────────────────────────────────────────────────────────

interface ViewOpts { run: string | null; runKind: ContainmentKind | null; missionCwd: string | null; defaultSrc: AuditSrc }

function openCore(core: Core, v: ViewOpts, src: AuditSrc): Outcome {
  if (core.shrunk !== null) return { ok: false, code: 'audit-file-shrunk', reason: core.shrunk }
  if (core.opened) return { ok: true }
  let isDir = false
  try {
    isDir = statSync(core.dir).isDirectory()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return unwritable(core, e)
  }
  if (!isDir) {
    return { ok: false, code: 'audit-dir-missing', reason: `audit-dir-missing: the audit folder ${core.dir} does not exist; scripts\\cynco-containment-setup.ps1 -Apply creates it, and nothing else does` }
  }
  let marked = false
  try {
    marked = lstatSync(join(core.dir, AUDIT_MARKER)).isFile()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return unwritable(core, e)
  }
  if (!marked) {
    return { ok: false, code: 'audit-dir-foreign', reason: `audit-dir-foreign: the audit folder ${core.dir} has no ${AUDIT_MARKER} marker; nothing is written into a folder the setup script did not create` }
  }
  // The arguments are written as a hash and a count, never as text: the mission driver is started
  // with the marker check and the probe command as arguments, and those are withheld (rule 10).
  const args = JSON.stringify(process.argv.slice(2))
  const w = writeRecord(core, 'open', src, v.run, {
    dir: core.dir, script: process.argv[1] ?? null, argc: Math.max(0, process.argv.length - 2),
    argvSha256: sha256(args), argvBytes: Buffer.byteLength(args, 'utf8'),
    cwd: process.cwd(), ppid: process.ppid, runKind: v.runKind, missionCwd: v.missionCwd,
  })
  if (!w.ok) return w
  core.opened = true
  // Retention: day files older than keepDays go, by their modification time AND the date in their
  // name; never the file just written, never anything else. A day file named after today means the
  // clock is behind the files, so nothing is pruned at all.
  const keep = core.file ? [basename(core.file.path)] : []
  const nowDate = core.now()
  const today = localDate(nowDate)
  let names: string[] = []
  try {
    names = readdirSync(core.dir)
  } catch (e) {
    console.error(`[tool-audit] retention: ${core.dir}: ${errText(e)}`)
  }
  const ahead = names.filter(n => AUDIT_FILE_RE.test(n) && n.slice(0, 10) > today)
  if (ahead.length > 0) {
    console.error(`[tool-audit] retention skipped: ${ahead[0]} is dated after the clock (${today}); nothing was pruned`)
  } else {
    const pruned = pruneOldFiles(core.dir, AUDIT_FILE_RE, core.keepDays, {
      now: nowDate.getTime(), keep, nameTime: nameDateMs,
    })
    for (const f of pruned.failed) console.error(`[tool-audit] retention: ${f.name}: ${f.error}`)
  }
  return { ok: true }
}

function writingView(core: Core, v: ViewOpts): ToolAudit {
  const failed = (o: Outcome & { ok: false }) => {
    faultLine(`write:${fold(core.dir)}:${core.proc}`, o.reason)
  }
  return {
    open() {
      const o = openCore(core, v, v.defaultSrc)
      return o.ok ? { ok: true, dir: core.dir } : { ok: false, reason: o.reason }
    },

    probe(by) {
      const src = srcOfProbe(by)
      const o = openCore(core, v, src)
      if (!o.ok) return o.reason
      const w = writeRecord(core, 'probe', src, v.run, { by })
      return w.ok ? null : w.reason
    },

    start(rec) {
      const fail = (o: Outcome & { ok: false }) => {
        failed(o)
        const short = AUDIT_NOT_WRITTEN(o.code)
        containmentFault('audit', short)
        return { ok: false as const, reason: short }
      }
      const o = openCore(core, v, rec.src)
      if (!o.ok) return fail(o)
      const body: Record<string, unknown> = {}
      if (rec.tool !== undefined) body.tool = rec.tool
      body.cwd = rec.cwd
      const s = session()
      if (s !== undefined) body.session = s
      if (isWithheld(rec.src)) {
        let text = rec.command ?? ''
        if (rec.command === undefined && rec.input !== undefined) {
          const j = jsonOf(rec.input)
          if (!j.ok) { core.seq++; return fail(j) }
          text = j.text
        }
        body.commandSha256 = sha256(text)
        body.commandBytes = Buffer.byteLength(text, 'utf8')
        // An escalate note names targets and a reason read from the command: hashed like it.
        if (rec.escalate !== undefined) {
          const j = jsonOf(rec.escalate)
          if (!j.ok) { core.seq++; return fail(j) }
          body.escalateSha256 = sha256(j.text)
        }
      } else {
        if (rec.input !== undefined) body.input = rec.input
        if (rec.command !== undefined) body.command = rec.command
        if (rec.escalate !== undefined) body.escalate = rec.escalate
      }
      const w = writeRecord(core, 'start', rec.src, v.run, body)
      if (!w.ok) return fail(w)
      core.pending.set(w.seq, rec.src)
      return { ok: true, call: w.seq }
    },

    end(call, rec) {
      // An end whose start this core did not see is written as withheld: no text without a known source.
      const src = core.pending.get(call) ?? 'gate'
      core.pending.delete(call)
      const o = openCore(core, v, src)
      if (!o.ok) { failed(o); return }
      const body: Record<string, unknown> = { call, isError: rec.isError }
      if ('exitCode' in rec) body.exitCode = rec.exitCode === undefined ? null : rec.exitCode
      body.ms = rec.ms
      const output = rec.output ?? ''
      if (isWithheld(src)) {
        body.outputSha256 = sha256(output)
        body.outputBytes = Buffer.byteLength(output, 'utf8')
      } else if (TOOL_SRC.includes(src)) {
        body.outputHead = output.slice(0, AUDIT_OUTPUT_CHARS)
      } else {
        body.outputTail = output.slice(-AUDIT_OUTPUT_CHARS)
      }
      const w = writeRecord(core, 'end', src, v.run, body)
      if (!w.ok) failed(w)
    },

    refused(rec) {
      const o = openCore(core, v, rec.src)
      if (!o.ok) { failed(o); return }
      const body: Record<string, unknown> = { by: rec.by }
      if (rec.tool !== undefined) body.tool = rec.tool
      body.cwd = rec.cwd
      const s = session()
      if (s !== undefined) body.session = s
      if (isWithheld(rec.src)) {
        // Rule 10 holds for refusals too: no text of a withheld check, in its input or its refusal.
        if (rec.input !== undefined) {
          const j = jsonOf(rec.input)
          if (!j.ok) { core.seq++; failed(j); return }
          body.inputSha256 = sha256(j.text)
          body.inputBytes = Buffer.byteLength(j.text, 'utf8')
        }
        if (rec.layer !== undefined) body.layer = rec.layer
        body.reasonSha256 = sha256(rec.reason)
        body.reasonBytes = Buffer.byteLength(rec.reason, 'utf8')
      } else {
        if (rec.input !== undefined) body.input = rec.input
        if (rec.layer !== undefined) body.layer = rec.layer
        body.reason = String(rec.reason).slice(0, AUDIT_REASON_CHARS)
      }
      const w = writeRecord(core, 'refused', rec.src, v.run, body)
      if (!w.ok) failed(w)
    },
  }
}

/** A handle over a folder that failed the policy: everything refuses, nothing throws, nothing is written. */
function refusingView(code: string, reason: string, key: string): ToolAudit {
  const line = () => faultLine(`refuse:${key}`, reason)
  return {
    open() { return { ok: false, reason } },
    probe() { return reason },
    start() {
      line()
      const short = AUDIT_NOT_WRITTEN(code)
      containmentFault('audit', short)
      return { ok: false, reason: short }
    },
    end() { line() },
    refused() { line() },
  }
}

// ─── Handles ─────────────────────────────────────────────────────────────────────────────────

/** Policy answers that passed, by their inputs: kept while ok; a refusal is judged again every call. */
const passed = new Map<string, string>()

function judged(a: { dir: string | null; home: string; missionCwd?: string; unprotectedVolumes: string[];
                    workspaceRoots: string[] })
  : { ok: true; dir: string } | { ok: false; code: string; reason: string } {
  const key = JSON.stringify([a.dir, a.home, a.missionCwd ?? null, [...a.unprotectedVolumes].sort(), [...a.workspaceRoots].sort()])
  const hit = passed.get(key)
  if (hit !== undefined) return { ok: true, dir: hit }
  const r = resolveAuditDir(a)
  if (r.ok) passed.set(key, r.dir)
  return r
}

/**
 * The audit handle of a contained run, or null when there is nothing to audit: no context (an
 * interactive run), or a test context that names no audit folder. A context whose folder fails the
 * policy gets a REFUSING handle, never null, so a caller holding a context never runs unaudited.
 */
export function toolAudit(ctx: RunContainment | null = runContainment()): ToolAudit | null {
  if (ctx === null) return null
  if (ctx.test && ctx.folders.audit === null) return null
  // The places a contained run may write are refused as audit folders, like its mission folder.
  const workspaceRoots = [sandboxRoot(), ctx.sandbox.root, ...ctx.extraRoots]
  const r = judged({ dir: ctx.folders.audit, home: ctx.home, missionCwd: ctx.missionCwd,
                     unprotectedVolumes: ctx.unprotectedVolumes, workspaceRoots })
  if (!r.ok) return refusingView(r.code, r.reason, String(ctx.folders.audit))
  return writingView(sharedCore(r.dir), {
    run: ctx.runId, runKind: ctx.kind, missionCwd: ctx.missionCwd, defaultSrc: srcOfKind(ctx.kind),
  })
}

/** The unprotected volumes as a harness process sees them: asked once, again only while refused. */
let harnessVolumes: string[] | null = null

/**
 * The audit handle of a harness process that holds no context (the campaign runner's graders and
 * calibration, a dispatch's gate). `dir` defaults to `auditDir()`, `home` to the user's home
 * folder, `run` to null. Never null: a writing handle or a refusing one.
 */
export function harnessAudit(a: { dir?: string | null; home?: string; missionCwd?: string;
                                  run?: string | null } = {}): ToolAudit {
  const dir = a.dir !== undefined ? a.dir : auditDir()
  const home = a.home ?? homedir()
  let volumes = harnessVolumes
  if (volumes === null) {
    try {
      volumes = listUnprotectedVolumes().map(v => v.root)
    } catch (e) {
      const reason = `audit-dir-not-ntfs: ${e instanceof Error ? e.message : String(e)}`
      return refusingView('audit-dir-not-ntfs', reason, String(dir))
    }
  }
  const r = judged({ dir, home, missionCwd: a.missionCwd, unprotectedVolumes: volumes, workspaceRoots: [sandboxRoot()] })
  // The volume answer is remembered only while the policy passes: a refusal asks again next time.
  harnessVolumes = r.ok ? volumes : null
  if (!r.ok) return refusingView(r.code, r.reason, String(dir))
  return writingView(sharedCore(r.dir), {
    run: a.run ?? null, runKind: null, missionCwd: a.missionCwd ?? null, defaultSrc: 'driver',
  })
}

/**
 * The gate question for a starter: null means a probe record was appended and fsynced just now; a
 * string is the operator's reason (`<code>: <sentence>`).
 */
export function auditRefusal(a?: { dir?: string | null; home?: string; missionCwd?: string; run?: string | null;
                                   by?: 'dispatch' | 'dispatch-check' | 'preflight' | 'task-runner' | 'driver' }): string | null {
  return harnessAudit(a).probe(a?.by ?? 'dispatch')
}

/**
 * A NEW writer over a folder the caller vouches for: no policy check, the opening checks (missing,
 * foreign, unwritable) still apply. Tests use it; two over one folder in one process need distinct
 * `proc` values.
 */
export function createToolAudit(opts: { dir: string; run?: string | null; proc?: string; now?: () => Date;
                                        maxFileBytes?: number; keepDays?: number }): ToolAudit {
  const core = newCore({ ...opts, dir: realPathOf(opts.dir, { quiet: true }) })
  return writingView(core, { run: opts.run ?? null, runKind: null, missionCwd: null, defaultSrc: 'tool' })
}

// ─── Reading the records back ────────────────────────────────────────────────────────────────

interface ProcAcc {
  seqs: Set<number>
  records: number
  runs: Set<string>
  starts: Map<number, { seq: number; ts: string; src: string; tool?: string }>
  ended: Set<number>
}


/** At most this many gap ranges are listed per process; `gapCount` always counts them all. */
export const AUDIT_GAP_RANGES = 100

/** The start of every record: where a torn line's surviving record begins. */
const RECORD_HEAD = '{"v":1,'

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const r = JSON.parse(line) as unknown
    return r !== null && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : null
  } catch (e) {
    return null
  }
}

/**
 * Read day files together and report, per process: how many records, the first sequence number
 * seen, the numbers missing between the lowest and the highest (as ranges, at most
 * AUDIT_GAP_RANGES of them, and their total), whether its head is missing (its lowest number is
 * above 1 although it booted no earlier than the earliest file read), the runs it wrote for, and
 * every start with no end. An unparsable line, a record whose `seq` is not a whole number of at
 * least 1, or a file that cannot be read, is counted, never fatal. A line whose head was torn (a
 * record cut short, then another written onto it) counts once as unparsable, and the record that
 * follows the tear is read.
 */
export function verifyAuditFiles(paths: string[]): {
  procs: Array<{ proc: string; records: number; firstSeq: number; gaps: Array<{ from: number; to: number }>;
                 gapCount: number; headMissing: boolean; runs: string[];
                 openStarts: Array<{ seq: number; ts: string; src: string; tool?: string }> }>
  unparsable: number } {
  const acc = new Map<string, ProcAcc>()
  let unparsable = 0
  let earliest: string | null = null
  for (const p of paths) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(basename(p))
    if (m && (earliest === null || m[1]! < earliest)) earliest = m[1]!
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch (e) {
      console.error(`[tool-audit] verify: ${p} could not be read (${errText(e)})`)
      unparsable++
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let r = parseRecord(line)
      if (r === null) {
        unparsable++
        const at = line.lastIndexOf(RECORD_HEAD)
        if (at <= 0) continue
        r = parseRecord(line.slice(at))
        if (r === null) continue
      }
      const seq = r.seq
      if (typeof r.proc !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
        unparsable++
        continue
      }
      let a = acc.get(r.proc)
      if (!a) {
        a = { seqs: new Set(), records: 0, runs: new Set(), starts: new Map(), ended: new Set() }
        acc.set(r.proc, a)
      }
      a.records++
      a.seqs.add(seq)
      if (typeof r.run === 'string') a.runs.add(r.run)
      if (r.kind === 'start') {
        a.starts.set(seq, {
          seq, ts: String(r.ts ?? ''), src: String(r.src ?? ''),
          ...(typeof r.tool === 'string' ? { tool: r.tool } : {}),
        })
      } else if (r.kind === 'end' && typeof r.call === 'number') {
        a.ended.add(r.call)
      }
    }
  }
  const procs = [...acc.entries()].map(([proc, a]) => {
    const seqs = [...a.seqs].sort((x, y) => x - y)
    const firstSeq = seqs[0] ?? 0
    // Gaps from the differences of the sorted numbers: time and memory follow the records, not their values.
    const gaps: Array<{ from: number; to: number }> = []
    let gapCount = 0
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]!, cur = seqs[i]!
      if (cur - prev > 1) {
        gapCount += cur - prev - 1
        if (gaps.length < AUDIT_GAP_RANGES) gaps.push({ from: prev + 1, to: cur - 1 })
      }
    }
    let headMissing = false
    if (firstSeq > 1) {
      const bootMs = parseInt(proc.slice(proc.indexOf('-') + 1), 36)
      const bootDate = proc.includes('-') && Number.isFinite(bootMs) ? localDate(new Date(bootMs)) : null
      // Unknown boot or unknown file dates: report it, since the head cannot be shown to be elsewhere.
      headMissing = bootDate === null || earliest === null || bootDate >= earliest
    }
    const openStarts = [...a.starts.values()].filter(s => !a.ended.has(s.seq)).sort((x, y) => x.seq - y.seq)
    return { proc, records: a.records, firstSeq, gaps, gapCount, headMissing, runs: [...a.runs].sort(), openStarts }
  })
  return { procs, unparsable }
}
