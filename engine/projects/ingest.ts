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
import { extractFile, IMAGE_EXTS, type LookInput } from './extract/index.js'
import { chunkSegments, chunkTranscriptTurns, type ProseChunk } from './proseChunker.js'
import { appendJournal, projectDir, readFileIndex, sha256Of, writeFileIndex, type FileOrigin } from './layout.js'

export type IngestKind = 'knowledge' | 'artifact' | 'chat'
export type IngestEvent = { slug: string; filePath: string; kind: IngestKind; indexed: boolean; reason?: string; chunks?: number }
/** `removeStore` is a test seam for the model-change rebuild's delete; it defaults to `removeProjectStore`. */
export type IngestDeps = { home: string; embed: EmbedClient | null; embedModel: string; emit?: (e: IngestEvent) => void; now?: () => string; removeStore?: (dir: string) => void }
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

/**
 * Open the store for writing under `embedModel`, rebuilding it if a different
 * model embedded it. A rebuild that cannot remove the old store (EBUSY on
 * Windows while a search holds project.db open) is a reason, never a throw
 * (spec §11): the old store is left as it is for the next rescan.
 */
function openForModel(dir: string, embedModel: string, now: () => string, removeStore: (dir: string) => void): { ok: true; store: IndexStore } | { ok: false; reason: string } {
  let store = openProjectStore(dir)
  const recorded = store.getMeta('embed_model')
  if (recorded && recorded !== embedModel) {
    store.close()
    try {
      removeStore(dir)
    } catch (e) {
      const reason = `index rebuild failed: ${e instanceof Error ? e.message : String(e)}`
      console.log(`[projects] ${dir}: ${reason} (embedding model ${recorded} → ${embedModel}; old store kept for the next rescan)`)
      return { ok: false, reason }
    }
    appendJournal(dir, 'index.rebuilt', `embedding model changed ${recorded} → ${embedModel}; store recreated`, now)
    store = openProjectStore(dir)
  }
  store.setMeta('embed_model', embedModel)
  return { ok: true, store }
}

/**
 * Store every chunk. An embedding failure mid-file does not throw the file
 * away: the remaining chunks go in with no vector (as when there is no embed
 * client at all), so keyword search still finds them, and `degraded` carries
 * the reason for the file record; a rescan re-embeds once the server is back.
 * (2026-11-08: a docx attached from the phone vanished from search because the
 * PC's Ollama had lost its llama-server binary.)
 */
async function writeChunks(store: IndexStore, embed: EmbedClient | null, filePath: string, kind: IngestKind, fileHash: string, chunks: ProseChunk[]): Promise<{ count: number; degraded?: string }> {
  store.removeFile(filePath)
  let count = 0
  let degraded: string | undefined
  for (const c of chunks) {
    let embedding: number[] = []
    if (embed && !degraded) {
      try { embedding = await embed.embed(c.text) } catch (e) {
        degraded = `embeddings unavailable: ${e instanceof Error ? e.message : String(e)} — kept for keyword search; a rescan re-embeds`
      }
    }
    const row: Chunk = { filePath, chunkType: kind, name: c.heading, startLine: c.ordinal, endLine: c.ordinal, content: c.text, fileHash }
    store.insertChunk(row, embedding)
    count++
  }
  return degraded ? { count, degraded } : { count }
}

export async function ingestFile(deps: IngestDeps, slug: string, kind: 'knowledge' | 'artifact', relPath: string, origin: FileOrigin, extra: { lookInput?: LookInput } = {}): Promise<IngestEvent> {
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
  const extracted = await extractFile(bytes, relPath, extra.lookInput)
  if (!extracted.ok) {
    appendJournal(dir, kind === 'knowledge' ? 'knowledge.unindexed' : 'artifact.unindexed', `${relPath} (${origin}) — not indexed: ${extracted.reason}`, now)
    return finish({ slug, filePath, kind, indexed: false, reason: extracted.reason })
  }
  const chunks = chunkSegments(extracted.segments)
  const opened = openForModel(dir, deps.embedModel, now, deps.removeStore ?? removeProjectStore)
  if (!opened.ok) {
    appendJournal(dir, kind === 'knowledge' ? 'knowledge.unindexed' : 'artifact.unindexed', `${relPath} (${origin}) — not indexed: ${opened.reason}`, now)
    return finish({ slug, filePath, kind, indexed: false, reason: opened.reason })
  }
  const store = opened.store
  try {
    const w = await writeChunks(store, deps.embed, filePath, kind, sha256, chunks)
    if (w.degraded) {
      appendJournal(dir, kind === 'knowledge' ? 'knowledge.unindexed' : 'artifact.unindexed', `${relPath} (${origin}) — not indexed: ${w.degraded} (${w.count} keyword chunk(s) kept)`, now)
      return finish({ slug, filePath, kind, indexed: false, reason: w.degraded, chunks: w.count })
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
  const opened = openForModel(dir, deps.embedModel, now, deps.removeStore ?? removeProjectStore)
  if (!opened.ok) {
    const ev: IngestEvent = { slug, filePath, kind: 'chat', indexed: false, reason: opened.reason }
    deps.emit?.(ev)
    return ev
  }
  const store = opened.store
  try {
    const w = await writeChunks(store, deps.embed, filePath, 'chat', sha256Of(JSON.stringify(turns)), chunks)
    const ev: IngestEvent = w.degraded ? { slug, filePath, kind: 'chat', indexed: false, reason: w.degraded, chunks: w.count } : { slug, filePath, kind: 'chat', indexed: true, chunks: w.count }
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

/** What a rescan needs from the image box's look runner (engine/vision/lookRunner.ts), without importing it. */
export type LookSource = {
  recent(slug: string, rel: string): import('../vision/lookClient.js').Look | null
  start(slug: string, rel: string, bytes: Uint8Array, mime: string): void
  pending(slug: string, rel: string): Promise<IngestEvent> | null
}

export async function rescanProject(deps: IngestDeps, slug: string, looks: LookSource | null = null): Promise<{ files: number; indexed: number; unindexed: number }> {
  const dir = projectDir(deps.home, slug)
  let files = 0, indexed = 0, unindexed = 0
  for (const kind of ['knowledge', 'artifact'] as const) {
    const area = AREA_DIR[kind]
    const existing = readFileIndex(dir, area).files
    for (const rel of listFiles(join(dir, area))) {
      files++
      const origin: FileOrigin = existing[rel]?.origin ?? 'uploaded'
      const ev = await rescanOne(deps, slug, kind, rel, origin, looks)
      if (ev.indexed) indexed++; else unindexed++
    }
  }
  return { files, indexed, unindexed }
}

/** An image is re-looked through the runner (a recent look is reused); everything else is ingested as before. */
async function rescanOne(deps: IngestDeps, slug: string, kind: 'knowledge' | 'artifact', rel: string, origin: FileOrigin, looks: LookSource | null): Promise<IngestEvent> {
  const ext = rel.toLowerCase().slice(rel.lastIndexOf('.'))
  if (!IMAGE_EXTS.has(ext) || !looks) return ingestFile(deps, slug, kind, rel, origin)
  const recent = looks.recent(slug, rel)
  if (recent) return ingestFile(deps, slug, kind, rel, origin, { lookInput: { look: recent } })
  if (kind !== 'knowledge') return ingestFile(deps, slug, kind, rel, origin)
  const bytes = new Uint8Array(readFileSync(join(projectDir(deps.home, slug), AREA_DIR[kind], rel)))
  looks.start(slug, rel, bytes, ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg')
  const pending = looks.pending(slug, rel)
  return pending ? pending : ingestFile(deps, slug, kind, rel, origin)
}
