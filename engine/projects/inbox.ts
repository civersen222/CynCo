/**
 * engine/projects/inbox.ts — a project's inbox: work done while nobody was in the chat.
 *
 * Every project has had an `inbox/` folder since projects mode (createProject
 * makes it); nothing used it. It is where a draft waits: a plain file, the
 * work itself, with a small record beside it (`inbox/.meta/<name>.json`) of
 * when it arrived and what run wrote it. A draft is not knowledge and not an
 * artifact: it is not indexed, the chat does not search it, and nothing reads
 * it until the owner does. They accept it (`acceptDraftApi` in api.ts: it
 * becomes an artifact, through the checks an upload meets) or discard it.
 *
 * The folder is the truth, not an index: a file put there by hand, or by a
 * script, is a draft too, and one record per draft means the two processes
 * that touch an inbox — the daemon's one-shot that files a draft and the
 * engine whose page accepts it — never rewrite a file they share.
 *
 * What files a draft today: a scheduled run whose working folder is a project
 * folder (`fileRunDraft`, called by engine/daemon/oneShot.ts when a one-shot
 * ends well). Its answer is the draft.
 *
 * Decision: docs/decisions/2026-11-11-phone-uploads-and-inbox.md.
 */
import { existsSync, lstatSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { appendJournal, isReservedFileName, readProject, realInside, realPathOf, slugify, writeBytesAtomic, writeJsonAtomic } from './layout.js'
import { safeStem } from './upload.js'

/** Drafts one inbox holds. Past this an unattended run's work is not filed: it must not be able to fill the disk. */
export const INBOX_MAX_DRAFTS = 200
/** Characters of a run's answer one draft keeps. */
export const DRAFT_MAX_CHARS = 1_000_000
/** Bytes of a text draft the page is given to read. */
export const DRAFT_READ_MAX_BYTES = 256 * 1024

/** Drafts the page can show as words. Anything else is accepted or discarded unread, or opened from the folder. */
const READABLE_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt'])

export type DraftFrom = { mission: string; triggerId: string; sessionId?: string }
type DraftRecord = { addedAt: string; from: DraftFrom; summary: string }
export type DraftSummary = { name: string; bytes: number; addedAt: string; from: string; summary: string; readable: boolean }

const inboxDir = (dir: string) => join(dir, 'inbox')
const metaPath = (dir: string, name: string) => join(dir, 'inbox', '.meta', `${name}.json`)

/** `name` when it can be a draft's file name — one path segment, not hidden, not the project's own index name — else null. */
export function draftName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
  if (basename(name) !== name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name.startsWith('.') || isReservedFileName(name)) return null
  return name
}

/** Null when `inbox/` really is a folder of this project (made if absent); otherwise why not. A junction there would carry a draft out of the project. */
function inboxFault(dir: string): string | null {
  const inbox = inboxDir(dir)
  try {
    if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true })
    const real = realInside(dir, inbox)
    if (real.inside && lstatSync(inbox).isDirectory()) return null
    return `inbox/ is not a folder inside this project (it resolves to ${real.real})`
  } catch (e) {
    return `inbox/ is not a folder inside this project (${e instanceof Error ? e.message : String(e)})`
  }
}

/** The regular files in `inbox/` that are drafts, by name; a link, a folder, a dot file or `index.json` is not one. */
function draftNames(dir: string): string[] {
  const inbox = inboxDir(dir)
  let entries: string[]
  try {
    if (!existsSync(inbox) || !realInside(dir, inbox).inside) return []
    entries = readdirSync(inbox)
  } catch (e) {
    console.log(`[inbox] cannot list ${inbox}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
  return entries.filter(n => {
    if (draftName(n) === null) return false
    try { return lstatSync(join(inbox, n)).isFile() } catch { return false }
  })
}

/** How many drafts wait in the project at `dir` (the project list shows it). */
export function draftCount(dir: string): number {
  return draftNames(dir).length
}

function readRecord(dir: string, name: string): DraftRecord | null {
  const p = metaPath(dir, name)
  try {
    if (!lstatSync(p).isFile()) return null
    const r = JSON.parse(readFileSync(p, 'utf8')) as Partial<DraftRecord>
    if (typeof r?.addedAt !== 'string' || typeof r.from?.mission !== 'string' || typeof r.from?.triggerId !== 'string') return null
    return { addedAt: r.addedAt, from: r.from, summary: typeof r.summary === 'string' ? r.summary : '' }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.log(`[inbox] unreadable record for ${name}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** Every draft in the project at `dir`, newest first; `full` when the inbox takes no more. */
export function listDrafts(dir: string): { drafts: DraftSummary[]; full: boolean } {
  const names = draftNames(dir)
  const drafts: DraftSummary[] = []
  for (const name of names) {
    let bytes = 0, modified = ''
    try { const st = lstatSync(join(inboxDir(dir), name)); bytes = st.size; modified = st.mtime.toISOString() } catch (e) {
      console.log(`[inbox] cannot stat ${name}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const rec = readRecord(dir, name)
    drafts.push({
      name, bytes,
      addedAt: rec?.addedAt ?? modified,
      from: rec ? `${rec.from.mission} · ${rec.from.triggerId}` : 'put here by hand',
      summary: rec?.summary ?? '',
      readable: READABLE_EXTS.has(extname(name).toLowerCase()),
    })
  }
  drafts.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.name < b.name ? -1 : 1))
  return { drafts, full: names.length >= INBOX_MAX_DRAFTS }
}

/** `20261111-184500` (UTC) for an instant. Lower case and hyphens only, so the name survives the slug an accepted draft is given. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-')
}

/**
 * File `text` as a draft named `<stamp>-<stem>.md`. Refused, with the reason,
 * when the draft is empty, the inbox is full, or `inbox/` is not a folder of
 * this project. Never over another draft: a taken name gets a number.
 */
export function addDraft(dir: string, draft: { stem: string; text: string; from: DraftFrom; summary?: string; now?: Date }): { ok: true; name: string } | { ok: false; reason: string } {
  if (!draft.text.trim()) return { ok: false, reason: 'nothing to file: the draft is empty' }
  const fault = inboxFault(dir)
  if (fault) return { ok: false, reason: fault }
  if (draftNames(dir).length >= INBOX_MAX_DRAFTS) return { ok: false, reason: `the inbox holds ${INBOX_MAX_DRAFTS} drafts; accept or discard some to let new work in` }
  const now = draft.now ?? new Date()
  const base = `${stamp(now)}-${safeStem(slugify(draft.stem))}`
  let name = `${base}.md`
  for (let n = 2; existsSync(join(inboxDir(dir), name)); n++) name = `${base}-${n}.md`
  const over = draft.text.length - DRAFT_MAX_CHARS
  const body = over > 0
    ? `${draft.text.slice(0, DRAFT_MAX_CHARS)}\n\n[cut here: the run wrote ${over} more characters than a draft keeps]\n`
    : draft.text.endsWith('\n') ? draft.text : draft.text + '\n'
  try {
    writeBytesAtomic(join(inboxDir(dir), name), new TextEncoder().encode(body))
    mkdirSync(dirname(metaPath(dir, name)), { recursive: true })
    const record: DraftRecord = { addedAt: now.toISOString(), from: draft.from, summary: (draft.summary ?? '').slice(0, 2000) }
    writeJsonAtomic(metaPath(dir, name), record)
  } catch (e) {
    return { ok: false, reason: `the draft could not be written: ${e instanceof Error ? e.message : String(e)}` }
  }
  appendJournal(dir, 'draft.added', `inbox/${name} from ${draft.from.mission} · ${draft.from.triggerId}`)
  return { ok: true, name }
}

/** The draft file at `name` when it is one: a draft name, a regular file, really inside the project. */
export function draftPath(dir: string, name: unknown): string | null {
  const n = draftName(name)
  if (n === null) return null
  const p = join(inboxDir(dir), n)
  try {
    if (!lstatSync(p).isFile() || !realInside(dir, p).inside) return null
    return p
  } catch {
    return null
  }
}

/** A text draft's words, up to `DRAFT_READ_MAX_BYTES`. */
export function readDraft(dir: string, name: unknown): { ok: true; text: string; truncated: boolean } | { ok: false; status: number; reason: string } {
  const p = draftPath(dir, name)
  if (p === null) return { ok: false, status: 404, reason: 'no such draft' }
  const n = basename(p)
  if (!READABLE_EXTS.has(extname(n).toLowerCase())) return { ok: false, status: 415, reason: `${n} is not text; accept it to keep it, or open the project folder to look at it` }
  try {
    const size = lstatSync(p).size
    const buf = Buffer.alloc(Math.min(size, DRAFT_READ_MAX_BYTES))
    const fd = openSync(p, 'r')
    try { readSync(fd, buf, 0, buf.length, 0) } finally { closeSync(fd) }
    return { ok: true, text: buf.toString('utf8'), truncated: size > DRAFT_READ_MAX_BYTES }
  } catch (e) {
    return { ok: false, status: 500, reason: `the draft could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Remove a draft and its record (after an accept, or as a discard). False when there was no such draft. */
export function removeDraft(dir: string, name: unknown): boolean {
  const p = draftPath(dir, name)
  if (p === null) return false
  rmSync(p, { force: true })
  rmSync(metaPath(dir, basename(p)), { force: true })
  return true
}

/** Discard a draft: gone, and the journal says so. False when there was no such draft. */
export function discardDraft(dir: string, name: unknown): boolean {
  if (!removeDraft(dir, name)) return false
  appendJournal(dir, 'draft.discarded', `inbox/${String(name)}`)
  return true
}

// ── What a run files ─────────────────────────────────────────────

type RunMessage = { role: string; content?: { type: string; text?: unknown }[] }

/** A fenced json block that is the one-shot's outcome contract (`{"summary": …}`), which is the daemon's, not the work. */
function isOutcomeBlock(inner: string): boolean {
  try { return typeof (JSON.parse(inner) as { summary?: unknown })?.summary === 'string' } catch { return false }
}

/**
 * The answer a run left: its last assistant message that says something, with
 * the outcome block the daemon asked for, any thinking and any tool-call
 * fragment taken out. Empty when the run left no words.
 */
export function finalAnswerText(messages: RunMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const raw = (m.content ?? []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
    const text = raw
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
      .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
      .replace(/```json\s*\n([\s\S]*?)```/g, (block, inner: string) => (isOutcomeBlock(inner) ? '' : block))
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * A finished run's answer, filed as a draft in the project its working folder
 * is. `cwd` must BE a project folder under `home` (not the home, not a folder
 * inside a project, not anywhere else): that is how a scheduled trigger is
 * aimed at a project, with the `cwd` it already has. Any other run files
 * nothing. Never throws — the run that calls this has finished its work and
 * must still write its outcome.
 */
export function fileRunDraft(run: { home: string; cwd: string | undefined; missionId: string; triggerId: string; sessionId?: string; messages: RunMessage[]; summary: string; now?: Date }): { slug: string; name: string } | null {
  try {
    if (!run.cwd) return null
    const real = realPathOf(run.cwd)
    if (dirname(real) !== realPathOf(run.home)) return null
    const slug = basename(real)
    if (!readProject(run.home, slug)) return null
    const dir = join(run.home, slug)
    const text = finalAnswerText(run.messages) || run.summary.trim()
    const filed = addDraft(dir, {
      stem: run.triggerId, text, summary: run.summary,
      from: { mission: run.missionId, triggerId: run.triggerId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) },
      ...(run.now ? { now: run.now } : {}),
    })
    if (!filed.ok) { console.warn(`[inbox] ${run.missionId}/${run.triggerId}: no draft filed in ${slug}: ${filed.reason}`); return null }
    console.log(`[inbox] ${run.missionId}/${run.triggerId}: filed inbox/${filed.name} in ${slug}`)
    return { slug, name: filed.name }
  } catch (e) {
    console.warn(`[inbox] ${run.missionId}/${run.triggerId}: no draft filed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
