/**
 * engine/projects/layout.ts — a project on disk.
 *
 * One folder per project under the projects home. The folder is the truth;
 * every other record (registry, file indexes, journal) is derived from or
 * appended beside it. Nothing here reaches the engine loop: this module is
 * plain filesystem shape, so it can be tested against a temp dir alone.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, realpathSync, lstatSync, readlinkSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export type ProjectMeta = { schema: 1; slug: string; name: string; description: string; tags: string[]; createdAt: string }
export type FileOrigin = 'pasted' | 'uploaded' | 'phone' | 'research' | 'artifact' | 'chat'
export type FileRecord = { sha256: string; addedAt: string; origin: FileOrigin; indexed: boolean; reason?: string; chunks?: number; embedModel?: string }
export type FileIndex = { files: Record<string, FileRecord> }
export type JournalEvent =
  | 'created' | 'knowledge.added' | 'knowledge.removed' | 'knowledge.unindexed'
  | 'artifact.saved' | 'artifact.unindexed' | 'artifact.removed' | 'artifact.promoted' | 'chat.opened' | 'chat.renamed'
  | 'index.rebuilt' | 'history.failed' | 'registry.rebuilt' | 'image.generated' | 'image.failed'

export const INSTRUCTIONS_HINT = '<!-- Standing instructions for every chat in this project. Write them below this line. -->\n'
export const PLAN_TEMPLATE = '# Plan\n\n<!-- One checkbox item per line: - [ ] item -->\n'

export function projectsHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_PROJECTS_HOME
  return v && v.trim() ? v : join(homedir(), 'cynco-projects')
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
  return s || 'project'
}

export function uniqueSlug(name: string, taken: (slug: string) => boolean): string {
  const base = slugify(name)
  if (!taken(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base.slice(0, 64 - String(n).length - 1)}-${n}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`no free slug for "${name}"`)
}

/** The one spelling of a valid slug; `projectDir`/`readProject` refuse anything
 *  else so a slug carrying `../` or a path separator can never resolve
 *  outside the projects home, whatever the caller (an API handler, a tool,
 *  a direct unit test) decoded it from. */
export const SLUG_RE = /^[a-z0-9-]{1,64}$/

export function projectDir(home: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug: ${slug}`)
  return join(home, slug)
}

export function sha256Of(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** True when `candidate` resolves to `root` or somewhere beneath it. Case-folded on win32. */
export function isInside(root: string, candidate: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const r = norm(root), c = norm(candidate)
  return c === r || c.startsWith(r + sep)
}

/** `realpathSync.native` (the OS's own resolution, junctions included), else the JS one; null when neither resolves. */
function realOf(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch (nativeErr) {
    try {
      return realpathSync(p)
    } catch (jsErr) {
      const code = (jsErr as NodeJS.ErrnoException).code
      // ENOENT/ENOTDIR are the expected "not there yet" answers (a Write of a
      // new file); anything else is worth a line.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[projects] realpath failed for ${p}: ${(nativeErr as Error).message} / ${(jsErr as Error).message}`)
      return null
    }
  }
}

/**
 * Where `p` really lands on disk: the deepest existing ancestor resolved
 * through every symlink and junction, with the not-yet-existing tail appended
 * back. A dangling link counts as existing (`lstat`) and is followed to its
 * target, so a Write through a link whose target does not exist yet is
 * judged by where it would land.
 */
export function realPathOf(p: string): string {
  let cur = resolve(p)
  const tail: string[] = []
  for (let hops = 0; hops < 64; hops++) {
    const real = realOf(cur)
    if (real !== null) return tail.length ? join(real, ...tail.reverse()) : real
    let link: string | null = null
    try {
      if (lstatSync(cur).isSymbolicLink()) link = resolve(dirname(cur), readlinkSync(cur))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[projects] lstat failed for ${cur}: ${(e as Error).message}`)
    }
    if (link !== null) { cur = link; continue }
    const parent = dirname(cur)
    if (parent === cur) return tail.length ? join(cur, ...tail.reverse()) : cur
    tail.push(basename(cur))
    cur = parent
  }
  return resolve(p)
}

/**
 * `isInside` after following links: a symlink or junction inside the project
 * that points outside it is outside (spec §5, "no symlink escapes"). Returns
 * the real path it judged, so a refusal can name where the call would land.
 */
export function realInside(root: string, candidate: string): { inside: boolean; real: string } {
  const real = realPathOf(candidate)
  return { inside: isInside(realPathOf(root), real), real }
}

/** The name every area's own file index uses; no artifact or knowledge file may take it. */
export const RESERVED_FILE_NAME = 'index.json'
export function isReservedFileName(name: string): boolean {
  return basename(name).toLowerCase() === RESERVED_FILE_NAME
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}` // unguessable, and 'wx' never follows a link planted there
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  renameSync(tmp, path)
}

export function createProject(home: string, input: { name: string; description?: string; instructions?: string; tags?: string[] }): ProjectMeta {
  mkdirSync(home, { recursive: true })
  const slug = uniqueSlug(input.name, s => existsSync(join(home, s)))
  const dir = join(home, slug)
  const meta: ProjectMeta = {
    schema: 1, slug, name: input.name.trim(), description: (input.description ?? '').trim(),
    tags: [...(input.tags ?? [])].map(t => t.trim()).filter(Boolean), createdAt: new Date().toISOString(),
  }
  for (const sub of ['knowledge', 'chats', 'artifacts', 'inbox', join('.cynco', 'index')]) mkdirSync(join(dir, sub), { recursive: true })
  writeJsonAtomic(join(dir, 'project.json'), meta)
  const instr = (input.instructions ?? '').trim()
  writeFileSync(join(dir, 'instructions.md'), instr ? instr + '\n' : INSTRUCTIONS_HINT, 'utf8')
  writeJsonAtomic(join(dir, 'knowledge', 'index.json'), { files: {} })
  writeJsonAtomic(join(dir, 'artifacts', 'index.json'), { files: {} })
  writeFileSync(join(dir, 'plan.md'), PLAN_TEMPLATE, 'utf8')
  writeFileSync(join(dir, '.gitignore'), '.cynco/\n', 'utf8')
  writeFileSync(join(dir, 'journal.md'), '', 'utf8')
  appendJournal(dir, 'created', `${meta.name} (${slug})`)
  return meta
}

export function readProject(home: string, slug: string): ProjectMeta | null {
  if (!SLUG_RE.test(slug)) return null
  const p = join(home, slug, 'project.json')
  if (!existsSync(p)) return null
  try {
    const meta = JSON.parse(readFileSync(p, 'utf8')) as ProjectMeta
    return meta && meta.schema === 1 && typeof meta.slug === 'string' ? meta : null
  } catch (e) {
    console.log(`[projects] unreadable project.json at ${p}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export function writeProject(home: string, meta: ProjectMeta): void {
  writeJsonAtomic(join(home, meta.slug, 'project.json'), meta)
}

export function readInstructions(home: string, slug: string): string {
  const p = join(home, slug, 'instructions.md')
  if (!existsSync(p)) return ''
  const raw = readFileSync(p, 'utf8')
  return raw.startsWith('<!--') ? raw.replace(/^<!--[\s\S]*?-->\s*/, '').trim() : raw.trim()
}

export function writeInstructions(home: string, slug: string, text: string): void {
  const t = text.trim()
  writeFileSync(join(home, slug, 'instructions.md'), t ? t + '\n' : INSTRUCTIONS_HINT, 'utf8')
}

export function readFileIndex(dir: string, area: 'knowledge' | 'artifacts'): FileIndex {
  const p = join(dir, area, 'index.json')
  if (!existsSync(p)) return { files: {} }
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as FileIndex
    return v && typeof v.files === 'object' && v.files ? v : { files: {} }
  } catch (e) {
    console.log(`[projects] unreadable ${area}/index.json at ${p}: ${e instanceof Error ? e.message : String(e)}`)
    return { files: {} }
  }
}

export function writeFileIndex(dir: string, area: 'knowledge' | 'artifacts', index: FileIndex): void {
  mkdirSync(join(dir, area), { recursive: true })
  writeJsonAtomic(join(dir, area, 'index.json'), index)
}

export function appendJournal(dir: string, event: JournalEvent, detail: string, now: () => string = () => new Date().toISOString()): void {
  journalAppend(join(dir, 'journal.md'), `- ${now()} ${event} — ${detail.replace(/\r?\n/g, ' ')}\n`)
}

export function readJournal(dir: string, limit = 200): { at: string; event: string; detail: string }[] {
  const text = journalRead(join(dir, 'journal.md'))
  if (text === null) return []
  const out: { at: string; event: string; detail: string }[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^- (\S+) (\S+) — (.*)$/)
    if (m) out.push({ at: m[1], event: m[2], detail: m[3] })
  }
  return out.reverse().slice(0, limit)
}

// ─── the journal file is the engine's, but the model can plant anything at its name ───

/** `readJournal` reads at most this much, from the end: the History tab wants the newest lines, and a planted multi-gigabyte file must not be loaded whole. */
export const JOURNAL_READ_CAP = 8 * 1024 * 1024

/**
 * Why the engine must not write to or read `journal.md` here, or null when it
 * is a regular file or absent (the append creates it). The model can write
 * anywhere in a project, links included (`gradeProjectCall` grades `ln -s` as
 * safe), so a link planted at `journal.md` would carry the engine's own append
 * out of the project — the one thing the file-tool fence forbids the model —
 * and a FIFO or a device there would block the engine's thread on the write
 * or the read (review of F174; the image store guards its files the same way).
 * `lstat`, never `stat`: a link must be seen as a link, not as its target.
 */
function journalFault(p: string): string | null {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return 'journal.md in the project is a link; the engine writes and reads only a regular file there'
    if (!st.isFile()) return 'journal.md in the project is not a regular file; the engine writes and reads only a regular file there'
    return null
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    console.log(`[projects] lstat ${p} failed: ${(e as Error).message}`)
    return `journal.md in the project could not be checked (${code ?? (e as Error).message})`
  }
}

/** Append one line, or drop it with the reason logged: a journal line is a record, never worth breaking the write it records. */
function journalAppend(p: string, line: string): void {
  const fault = journalFault(p)
  if (fault) { console.log(`[projects] ${fault} — the journal line was not written: ${line.trim()}`); return }
  try {
    appendFileSync(p, line, 'utf8')
  } catch (e) {
    console.log(`[projects] journal.md append failed (${(e as Error).message}) — the journal line was not written: ${line.trim()}`)
  }
}

/**
 * The journal text, or null when there is none to read. Opened non-blocking
 * and checked on the open descriptor (a FIFO's plain read waits for a writer
 * that never comes); over `JOURNAL_READ_CAP` only the tail is read and the cut
 * first line dropped, so the newest entries still reach the History tab.
 */
function journalRead(p: string): string | null {
  const fault = journalFault(p)
  if (fault) { console.log(`[projects] ${fault} — not read`); return null }
  let fd: number
  try {
    fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`[projects] journal.md could not be opened: ${(e as Error).message}`)
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) { console.log('[projects] journal.md in the project is not a regular file — not read'); return null }
    let start = 0
    if (st.size > JOURNAL_READ_CAP) {
      start = st.size - JOURNAL_READ_CAP
      console.log(`[projects] journal.md is ${st.size} bytes, over the ${JOURNAL_READ_CAP}-byte cap; reading its tail`)
    }
    const buf = Buffer.alloc(st.size - start)
    let n = 0
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, start + n)
      if (r === 0) break
      n += r
    }
    const text = buf.subarray(0, n).toString('utf8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } catch (e) {
    console.log(`[projects] reading journal.md failed: ${(e as Error).message}`)
    return null
  } finally {
    try {
      closeSync(fd)
    } catch (e) {
      console.log(`[projects] closing journal.md failed: ${(e as Error).message}`)
    }
  }
}
