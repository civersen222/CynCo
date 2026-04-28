
import { Database } from 'bun:sqlite'
import type { Chunk, IndexResult, Relationship } from './types.js'

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  chunk_type TEXT NOT NULL,
  name TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  file_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  target_file TEXT NOT NULL,
  rel_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(file_hash);
CREATE INDEX IF NOT EXISTS idx_rels_source ON relationships(source_chunk_id);
`

export class IndexStore {
  private db: Database
  private vecEnabled = false
  private embeddingDim: number

  constructor(dbPath: string, embeddingDim = 768) {
    this.embeddingDim = embeddingDim
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(BASE_SCHEMA)

    // Try to load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(this.db)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${this.embeddingDim}]
        );
      `)
      this.vecEnabled = true
      console.log(`[index] sqlite-vec loaded — vector search enabled (dim=${this.embeddingDim})`)
    } catch (e) {
      console.log(`[index] sqlite-vec not available — falling back to keyword search: ${e}`)
    }
  }

  /** Remove all chunks for a given file (before re-indexing). */
  removeFile(filePath: string): void {
    const chunks = this.db.prepare('SELECT id FROM chunks WHERE file_path = ?').all(filePath) as any[]
    for (const c of chunks) {
      this.db.prepare('DELETE FROM relationships WHERE source_chunk_id = ?').run(c.id)
      if (this.vecEnabled) {
        this.db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(c.id)
      }
    }
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath)
  }

  /** Insert a chunk and its embedding. Returns the chunk ID. */
  insertChunk(chunk: Chunk, embedding: number[]): number {
    const result = this.db.prepare(
      'INSERT INTO chunks (file_path, chunk_type, name, start_line, end_line, content, file_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(chunk.filePath, chunk.chunkType, chunk.name, chunk.startLine, chunk.endLine, chunk.content, chunk.fileHash)

    const chunkId = Number(result.lastInsertRowid)

    if (this.vecEnabled && embedding.length > 0) {
      const vec = new Float32Array(embedding)
      this.db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vec)
    }

    return chunkId
  }

  /** Insert a relationship. */
  insertRelationship(rel: Relationship): void {
    this.db.prepare(
      'INSERT INTO relationships (source_chunk_id, target_file, rel_type) VALUES (?, ?, ?)'
    ).run(rel.sourceChunkId, rel.targetFile, rel.relType)
  }

  /** Get file hash from index (for incremental update checks). */
  getFileHash(filePath: string): string | null {
    const row = this.db.prepare('SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1').get(filePath) as any
    return row?.file_hash ?? null
  }

  /** Cosine similarity search via sqlite-vec. Returns empty array if vec not available. */
  search(queryEmbedding: number[], topK = 5): IndexResult[] {
    if (!this.vecEnabled) return []

    const vec = new Float32Array(queryEmbedding)
    const rows = this.db.prepare(`
      SELECT v.chunk_id, v.distance, c.file_path, c.name, c.chunk_type, c.start_line, c.end_line, c.content
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `).all(vec, topK) as any[]

    return rows.map(r => ({
      filePath: r.file_path,
      name: r.name,
      chunkType: r.chunk_type,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      score: 1.0 - (r.distance ?? 0), // distance → similarity
    }))
  }

  /** Keyword fallback search when sqlite-vec is not available. */
  keywordSearch(query: string, topK = 5): IndexResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    if (terms.length === 0) return []

    const where = terms.map(() => `(LOWER(content) LIKE '%' || ? || '%' OR LOWER(name) LIKE '%' || ? || '%')`).join(' OR ')
    const params = terms.flatMap(t => [t, t])

    const rows = this.db.prepare(`
      SELECT file_path, name, chunk_type, start_line, end_line, content
      FROM chunks WHERE ${where} LIMIT ?
    `).all(...params, topK) as any[]

    return rows.map(r => ({
      filePath: r.file_path,
      name: r.name,
      chunkType: r.chunk_type,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      score: 0.5, // keyword match, no real score
    }))
  }

  /** Set a metadata value. */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  /** Get a metadata value. */
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any
    return row?.value ?? null
  }

  /** Get total chunk count. */
  getChunkCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as any
    return row?.cnt ?? 0
  }

  /** Get all indexed file paths. */
  getIndexedFiles(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT file_path FROM chunks').all() as any[]
    return rows.map(r => r.file_path)
  }

  /** Whether sqlite-vec vector search is available. */
  get isVecEnabled(): boolean {
    return this.vecEnabled
  }

  close(): void {
    this.db.close()
  }
}
