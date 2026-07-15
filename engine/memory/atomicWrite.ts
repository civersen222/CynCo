import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync, existsSync } from 'fs'

/**
 * Atomic durable file write: write to a temp sibling, fsync it, then rename
 * over the target. On a crash the target is either the old bytes or the new
 * bytes — never a torn half-write. Used by the ledger, handoff, and learning
 * store writers so persisted memory survives an interrupted process.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, data)
    // fsync the temp file's contents to disk before the rename.
    const fd = openSync(tmp, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
  } catch (err) {
    // Best-effort cleanup of the temp file on any failure.
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}
