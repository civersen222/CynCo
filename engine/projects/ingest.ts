/**
 * engine/projects/ingest.ts — extract → chunk → embed → store, for one file.
 *
 * The project's store is opened ONLY here (R2): `ProjectIndexer`'s constructor
 * purges every non-code chunk, so it must never see a project db. The store
 * records which model embedded it; a different configured model deletes and
 * recreates the db (the vec table's dimension is fixed at first open) and
 * journals `index.rebuilt` with both names. Every outcome, including a
 * refusal, is a record in the area's index.json, a journal line and one
 * `IngestEvent` — nothing silent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IndexStore } from '../index/store.js'
import { EmbedClient } from '../index/embedClient.js'
import type { Chunk } from '../index/types.js'
import { extractFile } from './extract/index.js'
import { chunkSegments, chunkTranscriptTurns, type ProseChunk } from './proseChunker.js'
import { appendJournal, projectDir, readFileIndex, sha256Of, writeFileIndex, type FileOrigin } from './layout.js'

export type IngestKind = 'knowledge' | 'artifact' | 'chat'
export type IngestEvent = { slug: string; filePath: string; kind: IngestKind; indexed: boolean; reason?: string; chunks?: number }
export type IngestDeps = { home: string; embed: EmbedClient | null; embedModel: string; emit?: (e: IngestEvent) => void; now?: () => string }
type FileIndexRecord = ReturnType<typeof readFileIndex>['files'][string]

const AREA_DIR: Record<'knowledge' | 'artifact', 'knowledge' | 'artifacts'> = { knowledge: 'knowledge', artifact: 'artifacts' }

export function proseEmbedModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_PROJECTS_EMBED_MODEL
  return v && v.trim() ? v.trim() : 'nomic-embed-text'
}

export function makeProseEmbedClient(baseUrl: string, env: NodeJS.ProcessEnv = process.env): EmbedClient {
  return new EmbedClient(baseUrl, proseEmbedModel(env), { pinModel: true })
}

/** The project store and its WAL sidecars; a rebuild removes all three together. */
export const PROJECT_DB_FILES = ['project.db', 'project.db-wal', 'project.db-shm'] as const

/**
 * Delete a (closed) project store. The store runs in WAL mode: a -wal/-shm
 * left beside a fresh project.db (another connection held it open at close,
 * so no checkpoint ran) would be replayed into it — the old model's frames,
 * the old vec dimension. So all three go together.
 */
export function removeProjectStore(dir: string): void {
  for (const f of PROJECT_DB_FILES) rmSync(join(dir, '.cynco', 'index', f), { force: true })
}

export function openProjectStore(dir: string): IndexStore {
  const indexDir = join(dir, '.cynco', 'index')
  mkdirSync(indexDir, { recursive: true })
  return new IndexStore(join(indexDir, 'project.db'))
}

/** Open the store for writing under `embedModel`, rebuilding it if a different model embedded it. */
function openForModel(dir: string, embedModel: string, now: () => string): IndexStore {
  let store = openProjectStore(dir)
  const recorded = store.getMeta('embed_model')
  if (recorded && recorded !== embedModel) {
    store.close()
    removeProjectStore(dir)
    appendJournal(dir, 'index.rebuilt', `embedding model changed ${recorded} → ${embedModel}; store recreated`, now)
    store = openProjectStore(dir)
  }
  store.setMeta('embed_model', embedModel)
  return store
}

async function writeChunks(store: IndexStore, embed: EmbedClient | null, filePath: string, kind: IngestKind, fileHash: string, chunks: ProseChunk[]): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  store.removeFile(filePath)
  let count = 0
  for (const c of chunks) {
    let embedding: number[] = []
    if (embed) {
      try { embedding = await embed.embed(c.text) } catch (e) {
        return { ok: false, reason: `embeddings unavailable: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const row: Chunk = { filePath, chunkType: kind, name: c.heading, startLine: c.ordinal, endLine: c.ordinal, content: c.text, fileHash }
    store.insertChunk(row, embedding)
    count++
  }
  return { ok: true, count }
}

export async function ingestFile(deps: IngestDeps, slug: string, kind: 'knowledge' | 'artifact', relPath: string, origin: FileOrigin): Promise<IngestEvent> {
  const now = deps.now ?? (() => new Date().toISOString())
  const dir = projectDir(deps.home, slug)
  const area = AREA_DIR[kind]
  const abs = join(dir, area, relPath)
  const filePath = `${area}/${relPath.replace(/\\/g, '/')}`
  const bytes = new Uint8Array(readFileSync(abs))
  const sha256 = sha256Of(bytes)
  const index = readFileIndex(dir, area)
  const finish = (ev: IngestEvent, extra: Partial<FileIndexRecord> = {}): IngestEvent => {
    index.files[relPath] = { sha256, addedAt: index.files[relPath]?.addedAt ?? now(), origin, indexed: ev.indexed, reason: ev.reason, chunks: ev.chunks, embedModel: ev.indexed ? deps.embedModel : undefined, ...extra }
    writeFileIndex(dir, area, index)
    deps.emit?.(ev)
    return ev
  }
  const extracted = await extractFile(bytes, relPath)
  if (!extracted.ok) {
    appendJournal(dir, kind === 'knowledge' ? 'knowledge.unindexed' : 'artifact.unindexed', `${relPath} (${origin}) — not indexed: ${extracted.reason}`, now)
    return finish({ slug, filePath, kind, indexed: false, reason: extracted.reason })
  }
  const chunks = chunkSegments(extracted.segments)
  const store = openForModel(dir, deps.embedModel, now)
  try {
    const w = await writeChunks(store, deps.embed, filePath, kind, sha256, chunks)
    if (!w.ok) {
      appendJournal(dir, kind === 'knowledge' ? 'knowledge.unindexed' : 'artifact.unindexed', `${relPath} (${origin}) — not indexed: ${w.reason}`, now)
      return finish({ slug, filePath, kind, indexed: false, reason: w.reason })
    }
    appendJournal(dir, kind === 'knowledge' ? 'knowledge.added' : 'artifact.saved', `${relPath} (${origin}) — ${w.count} chunk(s)`, now)
    return finish({ slug, filePath, kind, indexed: true, chunks: w.count })
  } finally {
    store.close()
  }
}

export async function ingestChat(deps: IngestDeps, slug: string, chatFile: string, title: string, turns: { user: string; assistant: string }[]): Promise<IngestEvent> {
  const now = deps.now ?? (() => new Date().toISOString())
  const dir = projectDir(deps.home, slug)
  const filePath = `chats/${chatFile}`
  const chunks = chunkTranscriptTurns(turns, title)
  const store = openForModel(dir, deps.embedModel, now)
  try {
    const w = await writeChunks(store, deps.embed, filePath, 'chat', sha256Of(JSON.stringify(turns)), chunks)
    const ev: IngestEvent = w.ok ? { slug, filePath, kind: 'chat', indexed: true, chunks: w.count } : { slug, filePath, kind: 'chat', indexed: false, reason: w.reason }
    deps.emit?.(ev)
    return ev
  } finally {
    store.close()
  }
}

export async function removeFromIndex(deps: IngestDeps, slug: string, kind: 'knowledge' | 'artifact', relPath: string): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const dir = projectDir(deps.home, slug)
  const area = AREA_DIR[kind]
  const store = openProjectStore(dir)
  try { store.removeFile(`${area}/${relPath.replace(/\\/g, '/')}`) } finally { store.close() }
  const index = readFileIndex(dir, area)
  delete index.files[relPath]
  writeFileIndex(dir, area, index)
  appendJournal(dir, kind === 'knowledge' ? 'knowledge.removed' : 'artifact.removed', `${relPath} removed`, now)
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === 'index.json') continue
      const r = rel ? `${rel}/${name}` : name
      if (statSync(join(root, r)).isDirectory()) walk(r); else out.push(r)
    }
  }
  walk('')
  return out.sort()
}

export async function rescanProject(deps: IngestDeps, slug: string): Promise<{ files: number; indexed: number; unindexed: number }> {
  const dir = projectDir(deps.home, slug)
  let files = 0, indexed = 0, unindexed = 0
  for (const kind of ['knowledge', 'artifact'] as const) {
    const area = AREA_DIR[kind]
    const existing = readFileIndex(dir, area).files
    for (const rel of listFiles(join(dir, area))) {
      files++
      const origin: FileOrigin = existing[rel]?.origin ?? 'uploaded'
      const ev = await ingestFile(deps, slug, kind, rel, origin)
      if (ev.indexed) indexed++; else unindexed++
    }
  }
  return { files, indexed, unindexed }
}
