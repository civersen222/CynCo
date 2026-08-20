import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Semantic search was dead in production and nothing said so.
 *
 * `IndexStore.search` built its knn query as
 *
 *   WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?
 *
 * and sqlite-vec rejects a *bound* LIMIT on a vec0 knn scan — it has to know k
 * when it plans the query. Every call threw
 *
 *   SQLiteError: A LIMIT or 'k = ?' constraint is required on vec0 knn queries.
 *
 * `ProjectIndexer.query` caught it with a bare `catch {}` and fell through to
 * `keywordSearch`, which scores every row a flat 0.5. So CodeIndex returned
 * LIKE-matches wearing a similarity score, the model got irrelevant files, and
 * it learned to reach for Grep instead. Two defects, and the second is what let
 * the first live: a vector search that *throws* looked exactly like one that
 * legitimately found nothing.
 *
 * sqlite-vec cannot load under the node test runner (`vecEnabled` is false), so
 * the knn path cannot be exercised here. These guards pin the two things that
 * would let it regress unnoticed.
 */
const root = join(import.meta.dirname, '..', '..')
const store = readFileSync(join(root, 'index', 'store.ts'), 'utf-8')
const indexer = readFileSync(join(root, 'index', 'indexer.ts'), 'utf-8')

describe('vector search', () => {
  it('constrains the knn scan with k = ?, which sqlite-vec accepts', () => {
    expect(store).toContain('k = ?')
  })

  it('does not bind the knn limit as a LIMIT parameter, which it rejects', () => {
    const knn = store.slice(store.indexOf('embedding MATCH ?'))
    const stmtEnd = knn.indexOf('`)')
    expect(knn.slice(0, stmtEnd)).not.toMatch(/LIMIT\s+\?/)
  })

  it('reports a failing vector search instead of silently degrading to keywords', () => {
    const q = indexer.slice(indexer.indexOf('async query('), indexer.indexOf('buildRepoMap'))
    expect(q).not.toMatch(/catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/)
    expect(q).toMatch(/console\.(log|warn|error)/)
  })
})
