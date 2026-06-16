/**
 * bun:sqlite shim for vitest, backed by Node's built-in node:sqlite.
 *
 * Provides a Database class with the subset of bun:sqlite's API used in
 * production code (exec / query / prepare / run / all / get / close),
 * backed by a real SQLite engine (node:sqlite's DatabaseSync). This lets
 * tests exercise actual SQL — schema creation, inserts, queries, percentile
 * math — instead of the previous no-op stub that returned empty results.
 *
 * Result rows from node:sqlite arrive as null-prototype objects; we copy
 * them into plain objects so they compare equal under vitest's toEqual,
 * matching what Bun's driver returns.
 */
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

function toPlain(row: Row | undefined): Row | null {
  if (row === undefined || row === null) return null
  return { ...row }
}

/** Wrap a node:sqlite StatementSync so .all()/.get() return plain objects. */
function wrapStatement(stmt: any) {
  return {
    run: (...params: unknown[]) => stmt.run(...params),
    all: (...params: unknown[]) => (stmt.all(...params) as Row[]).map(r => ({ ...r })),
    get: (...params: unknown[]) => toPlain(stmt.get(...params) as Row | undefined),
  }
}

export class Database {
  private db: DatabaseSync

  constructor(path?: string, _options?: any) {
    this.db = new DatabaseSync(path ?? ':memory:')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  query(sql: string): any {
    return wrapStatement(this.db.prepare(sql))
  }

  prepare(sql: string): any {
    return wrapStatement(this.db.prepare(sql))
  }

  close(): void {
    this.db.close()
  }
}
