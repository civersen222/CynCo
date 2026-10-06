/**
 * engine/projects/api.ts — the dashboard's project routes as plain functions.
 *
 * Every function returns { status, body } and never throws for a user
 * mistake: unknown project 404, bad input 400, unsupported type 415, too
 * large 413. The server (Task 8) only parses the request and mounts these.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { EmbedClient } from '../index/embedClient.js'
import { ACCEPTED_EXTS } from './extract/index.js'
import { commitHistory, ensureHistory } from './history.js'
import { ingestFile, makeProseEmbedClient, proseEmbedModel, removeFromIndex, rescanProject, type IngestEvent } from './ingest.js'
import { appendJournal, createProject, projectDir, readFileIndex, readInstructions, readJournal, readProject, slugify, writeInstructions, writeProject, SLUG_RE } from './layout.js'
import { readRegistry, upsertRegistry } from './registry.js'
import { listChats, readTranscript, renameChat } from './chat.js'
import { searchProjects, type SearchKind } from './search.js'

export type ProjectsDeps = { home: string; embed: EmbedClient | null; embedModel: string; emit: (e: IngestEvent) => void; contextLength: number }
export type ApiResult = { status: number; body: unknown }
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export { SLUG_RE }

export function makeProjectsDeps(args: { home: string; embedBaseUrl: string; emitEvent: (e: { type: 'project.ingest' } & IngestEvent) => void; contextLength: number }): ProjectsDeps {
  return { home: args.home, embed: makeProseEmbedClient(args.embedBaseUrl), embedModel: proseEmbedModel(), emit: (e) => args.emitEvent({ type: 'project.ingest', ...e }), contextLength: args.contextLength }
}

const notFound = (what: string): ApiResult => ({ status: 404, body: { error: `no such ${what}` } })
const bad = (reason: string): ApiResult => ({ status: 400, body: { error: reason } })
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {})

export function listProjects(d: ProjectsDeps): ApiResult {
  const { registry, rebuilt } = readRegistry(d.home)
  return { status: 200, body: { projects: registry.projects, rebuilt } }
}

export async function createProjectApi(d: ProjectsDeps, body: unknown): Promise<ApiResult> {
  const b = obj(body)
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return bad('name is required')
  const meta = createProject(d.home, { name, description: typeof b.description === 'string' ? b.description : '', instructions: typeof b.instructions === 'string' ? b.instructions : '', tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string') : [] })
  const dir = projectDir(d.home, meta.slug)
  await ensureHistory(dir)
  await commitHistory(dir, ['.'], 'project: create')
  upsertRegistry(d.home, { slug: meta.slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt: null, path: dir })
  return { status: 201, body: meta }
}

export function getProjectApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!SLUG_RE.test(slug)) return bad('bad slug')
  const meta = readProject(d.home, slug)
  if (!meta) return notFound('project')
  const dir = projectDir(d.home, slug)
  const knowledge = readFileIndex(dir, 'knowledge').files, artifacts = readFileIndex(dir, 'artifacts').files
  return { status: 200, body: { ...meta, instructions: readInstructions(d.home, slug), counts: { knowledge: Object.keys(knowledge).length, artifacts: Object.keys(artifacts).length, chats: listChats(dir).length }, plan: existsSync(join(dir, 'plan.md')) ? readFileSync(join(dir, 'plan.md'), 'utf8') : '', journal: readJournal(dir, 50) } }
}

export async function patchProjectApi(d: ProjectsDeps, slug: string, body: unknown): Promise<ApiResult> {
  const meta = readProject(d.home, slug)
  if (!meta) return notFound('project')
  const b = obj(body)
  if (typeof b.name === 'string' && b.name.trim()) meta.name = b.name.trim()
  if (typeof b.description === 'string') meta.description = b.description.trim()
  if (Array.isArray(b.tags)) meta.tags = b.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean)
  writeProject(d.home, meta)
  const paths = ['project.json']
  if (typeof b.instructions === 'string') { writeInstructions(d.home, slug, b.instructions); paths.push('instructions.md') }
  const dir = projectDir(d.home, slug)
  await commitHistory(dir, paths, 'project: update')
  const existing = readRegistry(d.home).registry.projects.find(p => p.slug === slug)
  upsertRegistry(d.home, { slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt: existing?.lastOpenedAt ?? null, path: dir })
  return { status: 200, body: { ...meta, instructions: readInstructions(d.home, slug) } }
}

export async function searchApi(d: ProjectsDeps, slug: string | null, q: string, kinds: string | null, limit: string | null): Promise<ApiResult> {
  if (!q.trim()) return bad('q is required')
  const ks = kinds ? kinds.split(',').filter((k): k is SearchKind => ['knowledge', 'artifact', 'chat'].includes(k)) : undefined
  const r = await searchProjects({ home: d.home, embed: d.embed }, { query: q, scope: slug ? { slug } : 'all', kinds: ks, limit: limit ? Number(limit) || 10 : 10 })
  return { status: 200, body: r }
}

export function listKnowledgeApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: readFileIndex(projectDir(d.home, slug), 'knowledge') }
}

export async function addKnowledgeApi(d: ProjectsDeps, slug: string, item: { name: string; text?: string; bytes?: Uint8Array }): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rawName = basename(item.name || '').trim()
  if (!rawName) return bad('name is required')
  const ext = extname(rawName).toLowerCase() || (item.text !== undefined ? '.md' : '')
  if (!ACCEPTED_EXTS.has(ext)) return { status: 415, body: { error: `unsupported file type ${ext || '(none)'}` } }
  const bytes = item.bytes ?? new TextEncoder().encode(item.text ?? '')
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return { status: 413, body: { error: `file is larger than ${UPLOAD_MAX_BYTES} bytes` } }
  if (bytes.byteLength === 0) return bad('empty file')
  const rel = `${slugify(rawName.slice(0, rawName.length - extname(rawName).length))}${ext}`
  const dir = projectDir(d.home, slug)
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', rel), bytes)
  const ev = await ingestFile(d, slug, 'knowledge', rel, item.bytes ? 'uploaded' : 'pasted')
  await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: add ${rel}`)
  return { status: 201, body: { name: rel, ...readFileIndex(dir, 'knowledge').files[rel], event: ev } }
}

export async function removeKnowledgeApi(d: ProjectsDeps, slug: string, name: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rel = basename(name)
  const dir = projectDir(d.home, slug)
  if (!readFileIndex(dir, 'knowledge').files[rel]) return notFound('knowledge file')
  await removeFromIndex(d, slug, 'knowledge', rel)
  rmSync(join(dir, 'knowledge', rel), { force: true })
  await commitHistory(dir, ['knowledge', 'journal.md'], `knowledge: remove ${rel}`)
  return { status: 200, body: { removed: rel } }
}

export function listArtifactsApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: readFileIndex(projectDir(d.home, slug), 'artifacts') }
}

export async function promoteArtifactApi(d: ProjectsDeps, slug: string, name: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rel = basename(name)
  const dir = projectDir(d.home, slug)
  if (!existsSync(join(dir, 'artifacts', rel))) return notFound('artifact')
  copyFileSync(join(dir, 'artifacts', rel), join(dir, 'knowledge', rel))
  const ev = await ingestFile(d, slug, 'knowledge', rel, 'artifact')
  appendJournal(dir, 'artifact.promoted', `${rel} → knowledge/${rel}`)
  await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: promote ${rel}`)
  return { status: 200, body: { promoted: rel, event: ev } }
}

export function listChatsApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: { chats: listChats(projectDir(d.home, slug)) } }
}

/** One chat's transcript — the page renders it when a chat is reopened. */
export function getChatApi(d: ProjectsDeps, slug: string, file: string): ApiResult {
  if (!SLUG_RE.test(slug)) return bad('bad slug')
  if (!readProject(d.home, slug)) return notFound('project')
  const t = readTranscript(projectDir(d.home, slug), basename(file))
  if (!t) return notFound('chat')
  return { status: 200, body: t }
}

export async function renameChatApi(d: ProjectsDeps, slug: string, file: string, body: unknown): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const title = typeof obj(body).title === 'string' ? (obj(body).title as string) : ''
  if (!title.trim()) return bad('title is required')
  const dir = projectDir(d.home, slug)
  if (!renameChat(dir, basename(file), title)) return notFound('chat')
  appendJournal(dir, 'chat.renamed', `${basename(file)} → ${title.trim()}`)
  await commitHistory(dir, [`chats/${basename(file)}`, 'journal.md'], `chat: rename ${basename(file)}`)
  return { status: 200, body: { file: basename(file), title: title.trim() } }
}

export async function rescanApi(d: ProjectsDeps, slug: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const counts = await rescanProject(d, slug)
  return { status: 200, body: counts }
}
