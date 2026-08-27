
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
CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(file_hash);
CREATE INDEX IF NOT EXISTS idx_rels_source ON relationships(source_chunk_id);
`

/**
 * Canonical stored form for file paths is forward slashes. Callers pass
 * whatever the OS handed them; mixing forms in the DB indexed the same file
 * twice (gilded\docket.py AND gilded/docket.py, 2026-08-27 civkings probe),
 * which ate top-k result slots and made removeFile miss the twin's rows.
 */
const normPath = (p: string): string => p.replace(/\\/g, '/')

export class IndexStore {
  private db: Database
  private vecEnabled = false
  private embeddingDim: number

  constructor(dbPath: string, embeddingDim = 768) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL;')
    // The eval harness and a live mission engine can hold this DB at once.
    this.db.exec('PRAGMA busy_timeout=5000;')
    this.db.exec(BASE_SCHEMA)

    // Detect embedding dimension from stored metadata if available
    const storedDim = this.getMeta('embedding_dim')
    if (storedDim !== null) {
      this.embeddingDim = parseInt(storedDim, 10) || embeddingDim
    } else {
      this.embeddingDim = embeddingDim
    }

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
      // Persist the embedding dimension for future opens
      this.setMeta('embedding_dim', String(this.embeddingDim))
      console.log(`[index] sqlite-vec loaded — vector search enabled (dim=${this.embeddingDim})`)
    } catch (e) {
      console.log(`[index] sqlite-vec not available — falling back to keyword search: ${e}`)
    }

    this.migrateMixedSeparators()
  }

  /**
   * One-time repair for indexes written before path normalization: collapse
   * separator twins (keep the newer rows — higher max id = later index run)
   * and rewrite every stored path to the canonical forward-slash form.
   */
  private migrateMixedSeparators(): void {
    const backRows = this.db.prepare(
      `SELECT DISTINCT file_path FROM chunks WHERE instr(file_path, ?) > 0`
    ).all('\\') as any[]
    if (backRows.length > 0) {
      let collapsed = 0
      for (const { file_path: backPath } of backRows) {
        const fwd = normPath(backPath)
        const twin = this.db.prepare('SELECT MAX(id) AS m FROM chunks WHERE file_path = ?').get(fwd) as any
        if (twin?.m != null) {
          const backMax = (this.db.prepare('SELECT MAX(id) AS m FROM chunks WHERE file_path = ?').get(backPath) as any).m
          // Delete the older form's rows (vec + relationships included)
          this.deleteChunkRows(backMax > twin.m ? fwd : backPath)
          collapsed++
        }
      }
      this.db.prepare(`UPDATE chunks SET file_path = REPLACE(file_path, ?, ?)`).run('\\', '/')
      console.log(`[index] Normalized ${backRows.length} legacy path(s) to forward slashes (${collapsed} separator twin(s) collapsed)`)
    }
    this.db.prepare(`UPDATE relationships SET target_file = REPLACE(target_file, ?, ?)`).run('\\', '/')
  }

  /** Delete all rows (chunks + vec + relationships) stored under an exact path string. */
  private deleteChunkRows(storedPath: string): void {
    const chunks = this.db.prepare('SELECT id FROM chunks WHERE file_path = ?').all(storedPath) as any[]
    for (const c of chunks) {
      this.db.prepare('DELETE FROM relationships WHERE source_chunk_id = ?').run(c.id)
      if (this.vecEnabled) {
        this.db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(c.id)
      }
    }
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(storedPath)
  }

  /** Remove all chunks for a given file (before re-indexing). */
  removeFile(filePath: string): void {
    const chunks = this.db.prepare('SELECT id FROM chunks WHERE file_path = ?').all(normPath(filePath)) as any[]
    for (const c of chunks) {
      this.db.prepare('DELETE FROM relationships WHERE source_chunk_id = ?').run(c.id)
      if (this.vecEnabled) {
        this.db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(c.id)
      }
    }
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(normPath(filePath))
  }

  /** Insert a chunk and its embedding. Returns the chunk ID. */
  insertChunk(chunk: Chunk, embedding: number[]): number {
    const result = this.db.prepare(
      'INSERT INTO chunks (file_path, chunk_type, name, start_line, end_line, content, file_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(normPath(chunk.filePath), chunk.chunkType, chunk.name, chunk.startLine, chunk.endLine, chunk.content, chunk.fileHash)

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
    ).run(rel.sourceChunkId, normPath(rel.targetFile), rel.relType)
  }

  /** Get file hash from index (for incremental update checks). */
  getFileHash(filePath: string): string | null {
    const row = this.db.prepare('SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1').get(normPath(filePath)) as any
    return row?.file_hash ?? null
  }

  /** Cosine similarity search via sqlite-vec. Returns empty array if vec not available. */
  search(queryEmbedding: number[], topK = 5): IndexResult[] {
    if (!this.vecEnabled) return []

    // `k = ?` rather than `LIMIT ?`: sqlite-vec plans a knn scan up front and
    // rejects a bound LIMIT outright ("A LIMIT or 'k = ?' constraint is
    // required on vec0 knn queries"). That error used to be swallowed upstream,
    // so this was a silent fallback to keyword search rather than a crash.
    const vec = new Float32Array(queryEmbedding)
    const rows = this.db.prepare(`
      SELECT v.chunk_id, v.distance, c.file_path, c.name, c.chunk_type, c.start_line, c.end_line, c.content
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `).all(vec, Math.max(1, Math.floor(topK))) as any[]

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

  /**
   * Exact-name definition lookup (symbol-first retrieval). Exact match first;
   * when that pass is empty and `ciFallback` is true, a case-insensitive pass.
   * Score 1.0 — a name match is definitional, not similarity.
   */
  findByName(name: string, ciFallback = true): IndexResult[] {
    const map = (rows: any[]): IndexResult[] => rows.map(r => ({
      filePath: r.file_path,
      name: r.name,
      chunkType: r.chunk_type,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      score: 1.0,
    }))
    const cols = 'file_path, name, chunk_type, start_line, end_line, content'
    const exact = this.db.prepare(`SELECT ${cols} FROM chunks WHERE name = ?`).all(name) as any[]
    if (exact.length > 0 || !ciFallback) return map(exact)
    const ci = this.db.prepare(`SELECT ${cols} FROM chunks WHERE LOWER(name) = LOWER(?)`).all(name) as any[]
    return map(ci)
  }

  /**
   * Keyword fallback search. Demoted (2026-08-27): identifier-like terms are
   * ANDed and query-filler words are dropped entirely — the OR-over-everything
   * version served a Spy class for "_gen_betrothal_offer function body"
   * because "function" matched. "No results" beats a wrong answer.
   */
  keywordSearch(query: string, topK = 5): IndexResult[] {
    // require() rather than a top-level import: symbolLookup type-imports this
    // module, and a runtime edge back would be a cycle.
    const { extractIdentifiers } = require('./symbolLookup.js') as typeof import('./symbolLookup.js')
    const terms = extractIdentifiers(query).map(t => t.toLowerCase())
    if (terms.length === 0) return []

    const where = terms.map(() => `(LOWER(content) LIKE '%' || ? || '%' OR LOWER(name) LIKE '%' || ? || '%')`).join(' AND ')
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

  /**
   * One chunk per distinct FILE whose content or name contains `term`.
   * Coverage ranking needs file presence, not chunk lists — keywordSearch's
   * rowid-ordered LIMIT let one scratch file hoard all 50 slots for seed_42
   * while the gold file never entered the map (2026-08-27 replay).
   */
  filesContaining(term: string, cap = 50): IndexResult[] {
    const t = term.toLowerCase()
    const rows = this.db.prepare(`
      SELECT file_path, name, chunk_type, start_line, end_line, content, MIN(id)
      FROM chunks
      WHERE LOWER(content) LIKE '%' || ? || '%' OR LOWER(name) LIKE '%' || ? || '%'
      GROUP BY file_path LIMIT ?
    `).all(t, t, cap) as any[]
    return rows.map(r => ({
      filePath: r.file_path,
      name: r.name,
      chunkType: r.chunk_type,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      score: 0.5,
    }))
  }

  /** Delete chunks (and their vec/relationship rows) whose file_path fails `keep`. Returns purge count. */
  purgeWhere(keep: (filePath: string) => boolean): number {
    let purged = 0
    for (const f of this.getIndexedFiles()) {
      if (!keep(f)) {
        this.removeFile(f)
        purged++
      }
    }
    return purged
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

  /** All named definitions (functions/classes) for repo-map graph construction. */
  getAllDefinitions(): { file: string; name: string; kind: string }[] {
    const rows = this.db.prepare(
      `SELECT file_path, name, chunk_type FROM chunks WHERE name IS NOT NULL AND name != ''`
    ).all() as any[]
    return rows.map(r => ({ file: r.file_path, name: r.name, kind: r.chunk_type }))
  }

  /** All relationships joined to their source symbol, for repo-map graph edges. */
  getAllRelationships(): { sourceFile: string; sourceName: string; target: string }[] {
    const rows = this.db.prepare(
      `SELECT c.file_path AS source_file, c.name AS source_name, r.target_file AS target
       FROM relationships r JOIN chunks c ON c.id = r.source_chunk_id
       WHERE c.name IS NOT NULL AND c.name != ''`
    ).all() as any[]
    return rows.map(r => ({ sourceFile: r.source_file, sourceName: r.source_name, target: r.target }))
  }

  /** Whether sqlite-vec vector search is available. */
  get isVecEnabled(): boolean {
    return this.vecEnabled
  }

  close(): void {
    this.db.close()
  }
}
