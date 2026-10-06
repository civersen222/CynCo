/**
 * engine/projects/layout.ts — a project on disk.
 *
 * One folder per project under the projects home. The folder is the truth;
 * every other record (registry, file indexes, journal) is derived from or
 * appended beside it. Nothing here reaches the engine loop: this module is
 * plain filesystem shape, so it can be tested against a temp dir alone.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export type ProjectMeta = { schema: 1; slug: string; name: string; description: string; tags: string[]; createdAt: string }
export type FileOrigin = 'pasted' | 'uploaded' | 'phone' | 'research' | 'artifact' | 'chat'
export type FileRecord = { sha256: string; addedAt: string; origin: FileOrigin; indexed: boolean; reason?: string; chunks?: number; embedModel?: string }
export type FileIndex = { files: Record<string, FileRecord> }
export type JournalEvent =
  | 'created' | 'knowledge.added' | 'knowledge.removed' | 'knowledge.unindexed'
  | 'artifact.saved' | 'artifact.promoted' | 'chat.opened' | 'chat.renamed'
  | 'index.rebuilt' | 'history.failed' | 'registry.rebuilt'

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

export function projectDir(home: string, slug: string): string {
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

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
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
  appendFileSync(join(dir, 'journal.md'), `- ${now()} ${event} — ${detail.replace(/\r?\n/g, ' ')}\n`, 'utf8')
}

export function readJournal(dir: string, limit = 200): { at: string; event: string; detail: string }[] {
  const p = join(dir, 'journal.md')
  if (!existsSync(p)) return []
  const out: { at: string; event: string; detail: string }[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^- (\S+) (\S+) — (.*)$/)
    if (m) out.push({ at: m[1], event: m[2], detail: m[3] })
  }
  return out.reverse().slice(0, limit)
}
