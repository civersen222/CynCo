import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const chunk = (filePath: string, name: string | null = null, startLine = 1) => ({
  filePath, chunkType: 'function', name, startLine, endLine: startLine + 2,
  content: `def ${name ?? 'x'}():\n    pass\n`, fileHash: 'h' + startLine,
})

const dbPath = () => join(mkdtempSync(join(tmpdir(), 'ci-norm-')), 'p.db')

describe('store path normalization', () => {
  it('stores backslash paths as forward slashes', () => {
    const store = new IndexStore(dbPath())
    store.insertChunk(chunk('gilded\\ui\\actions.py', 'handle_click'), [])
    expect(store.getIndexedFiles()).toEqual(['gilded/ui/actions.py'])
    store.close()
  })

  it('removeFile and getFileHash accept either separator form', () => {
    const store = new IndexStore(dbPath())
    store.insertChunk(chunk('gilded/docket.py', '_auto_terms'), [])
    expect(store.getFileHash('gilded\\docket.py')).toBe('h1')
    store.removeFile('gilded\\docket.py')
    expect(store.getIndexedFiles()).toEqual([])
    store.close()
  })

  // The civkings index (2026-08-27 probe) held gilded\docket.py:607 AND
  // gilded/docket.py:607 — the same chunk twice, eating top-k result slots
  // and defeating removeFile-based reindexing.
  it('migrates a legacy mixed-separator index, dropping the older duplicate rows', () => {
    const p = dbPath()
    const raw = new Database(p)
    raw.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, chunk_type TEXT NOT NULL,
      name TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, file_hash TEXT NOT NULL);`)
    raw.exec(`CREATE TABLE relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
      target_file TEXT NOT NULL, rel_type TEXT NOT NULL);`)
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`)
    const ins = raw.prepare('INSERT INTO chunks (file_path, chunk_type, name, start_line, end_line, content, file_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    // Older forward rows (stale content), newer backslash rows (fresh content)
    ins.run('gilded/docket.py', 'function', '_auto_terms', 600, 610, 'old body', 'oldhash')
    ins.run('gilded\\docket.py', 'function', '_auto_terms', 607, 617, 'new body', 'newhash')
    ins.run('gilded\\intel.py', 'function', '_has_marriage_tie', 41, 50, 'tie body', 'tiehash')
    raw.prepare('INSERT INTO relationships (source_chunk_id, target_file, rel_type) VALUES (?, ?, ?)')
      .run(2, 'gilded\\houses.py', 'import')
    raw.close()

    const store = new IndexStore(p)
    const files = store.getIndexedFiles().sort()
    expect(files).toEqual(['gilded/docket.py', 'gilded/intel.py'])
    // The newer (higher max-id) rows survive the duplicate collapse
    expect(store.getFileHash('gilded/docket.py')).toBe('newhash')
    // relationship targets normalized too
    expect(store.getAllRelationships().map(r => r.target)).toEqual(['gilded/houses.py'])
    store.close()
  })

  it('findByName returns one definition after migration, not two separator twins', () => {
    const p = dbPath()
    const raw = new Database(p)
    raw.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, chunk_type TEXT NOT NULL,
      name TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, file_hash TEXT NOT NULL);`)
    const ins = raw.prepare('INSERT INTO chunks (file_path, chunk_type, name, start_line, end_line, content, file_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('gilded/intel.py', 'function', '_has_marriage_tie', 41, 50, 'old', 'h-old')
    ins.run('gilded\\intel.py', 'function', '_has_marriage_tie', 41, 50, 'new', 'h-new')
    raw.close()

    const store = new IndexStore(p)
    const defs = store.findByName('_has_marriage_tie')
    expect(defs.length).toBe(1)
    expect(defs[0].filePath).toBe('gilded/intel.py')
    expect(defs[0].content).toBe('new')
    store.close()
  })
})
