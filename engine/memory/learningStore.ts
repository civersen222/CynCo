import { Database } from 'bun:sqlite'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

export type SaveLearningInput = {
  type: string
  content: string
  context?: string
  sessionId?: string
  importance?: number   // 0..1, default 0.5
  embedding?: number[]
}

export type StoredLearning = {
  id: number
  type: string
  content: string
  context: string
  sessionId: string | null
  importance: number
  helpful: number
  harmful: number
  promoted: number
  validFrom: number
  invalidatedAt: number | null
  lastAccessed: number
}

export type RecallResult = StoredLearning & { score: number }

// Generative-agents ranking constants (overridable via env — flag #3).
const wRecency = Number(process.env.LOCALCODE_RECALL_W_RECENCY ?? 0.25)
const wImportance = Number(process.env.LOCALCODE_RECALL_W_IMPORTANCE ?? 0.25)
const wRelevance = Number(process.env.LOCALCODE_RECALL_W_RELEVANCE ?? 0.5)
const halfLifeMs = Number(process.env.LOCALCODE_RECALL_HALFLIFE_HOURS ?? 72) * 3600_000
const promotedBonus = Number(process.env.LOCALCODE_RECALL_PROMOTED_BONUS ?? 0.15)

export const RANKING = { wRecency, wImportance, wRelevance, halfLifeMs, promotedBonus }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  helpful INTEGER NOT NULL DEFAULT 0,
  harmful INTEGER NOT NULL DEFAULT 0,
  promoted INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL,
  invalidated_at INTEGER,
  last_accessed INTEGER NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_learn_session ON learnings(session_id);
CREATE INDEX IF NOT EXISTS idx_learn_valid ON learnings(invalidated_at);
CREATE INDEX IF NOT EXISTS idx_learn_type_content ON learnings(type, content);
`

export function defaultLearningsDbPath(): string {
  const dir = join(homedir(), '.cynco')
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return join(dir, 'learnings.db')
}

function floatsToBlob(v: number[]): Uint8Array {
  const f32 = new Float32Array(v)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

function blobToFloats(b: Uint8Array | null): number[] | null {
  if (!b || b.byteLength === 0) return null
  const copy = new Uint8Array(b) // fresh, aligned ArrayBuffer
  const f32 = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
  return Array.from(f32)
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function lexicalOverlap(query: string, content: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean))
  const c = new Set(content.toLowerCase().split(/\W+/).filter(Boolean))
  if (q.size === 0 || c.size === 0) return 0
  let hits = 0
  for (const t of q) if (c.has(t)) hits++
  return hits / q.size
}

function rowToStored(r: any): StoredLearning {
  return {
    id: r.id,
    type: r.type,
    content: r.content,
    context: r.context ?? '',
    sessionId: r.session_id ?? null,
    importance: r.importance,
    helpful: r.helpful,
    harmful: r.harmful,
    promoted: r.promoted,
    validFrom: r.valid_from,
    invalidatedAt: r.invalidated_at ?? null,
    lastAccessed: r.last_accessed,
  }
}

export class LearningStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    try { this.db.exec('PRAGMA journal_mode=WAL;') } catch { /* :memory: has no WAL */ }
    this.db.exec(SCHEMA)
  }

  /** Insert a new learning. Returns the row id. */
  save(input: SaveLearningInput): number {
    const now = Date.now()
    // ACE delta: a duplicate (type, content) is reinforcement, not a new row.
    const existing = this.db
      .prepare('SELECT id FROM learnings WHERE type = ? AND content = ? AND invalidated_at IS NULL')
      .get(input.type, input.content) as any
    if (existing) {
      this.markHelpful(existing.id)
      return existing.id as number
    }
    const stmt = this.db.prepare(`
      INSERT INTO learnings (type, content, context, session_id, importance, valid_from, last_accessed, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      input.type,
      input.content,
      input.context ?? '',
      input.sessionId ?? null,
      input.importance ?? 0.5,
      now,
      now,
      input.embedding && input.embedding.length ? floatsToBlob(input.embedding) : null,
    )
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as any
    return row.id as number
  }

  /** AWM promotion gate: only a verified successful mission promotes. */
  promote(id: number, verified: boolean): void {
    if (!verified) return
    this.db.prepare('UPDATE learnings SET promoted = 1 WHERE id = ?').run(id)
  }

  /** ACE delta: reinforce a learning that helped. */
  markHelpful(id: number): void {
    this.db.prepare('UPDATE learnings SET helpful = helpful + 1, last_accessed = ? WHERE id = ?').run(Date.now(), id)
  }

  /** ACE delta: penalize a learning that misled. */
  markHarmful(id: number): void {
    this.db.prepare('UPDATE learnings SET harmful = harmful + 1, last_accessed = ? WHERE id = ?').run(Date.now(), id)
  }

  /** Demote-don't-delete: mark invalid rather than removing the row. */
  demote(id: number): void {
    this.db.prepare('UPDATE learnings SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL').run(Date.now(), id)
  }

  /**
   * Generative-agents recall: composite of recency, importance, relevance,
   * plus a bonus for AWM-promoted learnings. Excludes invalidated rows.
   * @param queryEmbedding optional; when provided, relevance uses cosine.
   */
  recall(query: string, k = 5, queryEmbedding?: number[]): RecallResult[] {
    const now = Date.now()
    const rows = this.db
      .prepare('SELECT * FROM learnings WHERE invalidated_at IS NULL')
      .all() as any[]
    const scored: RecallResult[] = rows.map(raw => {
      const s = rowToStored(raw)
      const ageMs = Math.max(0, now - s.lastAccessed)
      const recency = Math.pow(0.5, ageMs / RANKING.halfLifeMs)
      let relevance: number
      if (queryEmbedding && queryEmbedding.length) {
        const emb = blobToFloats(raw.embedding as Uint8Array | null)
        relevance = emb ? Math.max(0, cosine(queryEmbedding, emb)) : lexicalOverlap(query, s.content)
      } else {
        relevance = lexicalOverlap(query, s.content + ' ' + s.context)
      }
      let score =
        RANKING.wRecency * recency +
        RANKING.wImportance * s.importance +
        RANKING.wRelevance * relevance
      if (s.promoted) score += RANKING.promotedBonus
      return { ...s, score }
    })
    scored.sort((x, y) => y.score - x.score)
    return scored.slice(0, k)
  }

  /** All rows, including invalidated ones — for audit/tests. */
  allIncludingInvalidated(): StoredLearning[] {
    const rows = this.db.prepare('SELECT * FROM learnings ORDER BY id ASC').all() as any[]
    return rows.map(rowToStored)
  }

  /** Row ids that belong to a given session (for AWM promotion). */
  idsForSession(sessionId: string): number[] {
    const rows = this.db.prepare('SELECT id FROM learnings WHERE session_id = ?').all(sessionId) as any[]
    return rows.map(r => r.id as number)
  }

  /** Raw embedding for a row (test helper + recall). */
  embeddingFor(id: number): number[] | null {
    const row = this.db.prepare('SELECT embedding FROM learnings WHERE id = ?').get(id) as any
    if (!row) return null
    return blobToFloats(row.embedding as Uint8Array | null)
  }

  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }
}
