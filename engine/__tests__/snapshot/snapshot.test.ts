import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorkspaceSnapshot } from '../../snapshot/snapshot.js'
import type { DiffResult, SnapshotHash } from '../../snapshot/types.js'

describe('WorkspaceSnapshot', () => {
  let tempDir: string
  let snap: WorkspaceSnapshot

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'snapshot-test-'))
    snap = new WorkspaceSnapshot(tempDir)
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // cleanup best-effort
    }
  })

  // 1. Type shape test
  it('DiffResult has the expected shape', () => {
    const result: DiffResult = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      hasChanges: false,
    }
    expect(result).toHaveProperty('files')
    expect(result).toHaveProperty('totalAdditions')
    expect(result).toHaveProperty('totalDeletions')
    expect(result).toHaveProperty('hasChanges')
    expect(Array.isArray(result.files)).toBe(true)
  })

  // 2. init() creates the snapshot directory
  it('init() creates .cynco-snapshots directory', () => {
    snap.init()
    expect(existsSync(join(tempDir, '.cynco-snapshots'))).toBe(true)
  })

  // 3. track() returns a hash string
  it('track() returns a hash string', () => {
    snap.init()
    writeFileSync(join(tempDir, 'hello.txt'), 'hello world')
    const hash = snap.track()
    expect(typeof hash).toBe('string')
    expect(hash.length).toBeGreaterThan(0)
    // git tree hashes are 40 hex chars (SHA-1)
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
  })

  // 4. track() returns different hashes for different content
  it('track() returns different hashes for different content', () => {
    snap.init()
    writeFileSync(join(tempDir, 'file.txt'), 'version 1')
    const hash1 = snap.track()

    writeFileSync(join(tempDir, 'file.txt'), 'version 2')
    const hash2 = snap.track()

    expect(hash1).not.toBe(hash2)
  })

  // 5. track() returns same hash for unchanged content
  it('track() returns same hash for unchanged content', () => {
    snap.init()
    writeFileSync(join(tempDir, 'file.txt'), 'stable content')
    const hash1 = snap.track()
    const hash2 = snap.track()

    expect(hash1).toBe(hash2)
  })

  // 6. diff() detects file additions
  it('diff() detects file additions', () => {
    snap.init()
    writeFileSync(join(tempDir, 'existing.txt'), 'already here')
    const before = snap.track()

    writeFileSync(join(tempDir, 'new-file.txt'), 'I am new\nLine 2\n')
    const after = snap.track()

    const result = snap.diff(before, after)
    expect(result.hasChanges).toBe(true)
    expect(result.files.length).toBeGreaterThanOrEqual(1)

    const added = result.files.find(f => f.path === 'new-file.txt')
    expect(added).toBeDefined()
    expect(added!.status).toBe('added')
    expect(added!.additions).toBeGreaterThan(0)
  })

  // 7. diff() detects file modifications
  it('diff() detects file modifications', () => {
    snap.init()
    writeFileSync(join(tempDir, 'readme.txt'), 'original content\n')
    const before = snap.track()

    writeFileSync(join(tempDir, 'readme.txt'), 'modified content\nextra line\n')
    const after = snap.track()

    const result = snap.diff(before, after)
    expect(result.hasChanges).toBe(true)

    const modified = result.files.find(f => f.path === 'readme.txt')
    expect(modified).toBeDefined()
    expect(modified!.status).toBe('modified')
  })

  // 8. diff() returns no changes for same hash
  it('diff() returns no changes for same hash', () => {
    snap.init()
    writeFileSync(join(tempDir, 'data.txt'), 'some data')
    const hash = snap.track()

    const result = snap.diff(hash, hash)
    expect(result.hasChanges).toBe(false)
    expect(result.files).toEqual([])
    expect(result.totalAdditions).toBe(0)
    expect(result.totalDeletions).toBe(0)
  })

  // 9. restore() reverts file content to prior state
  it('restore() reverts file content to prior state', () => {
    snap.init()
    writeFileSync(join(tempDir, 'config.txt'), 'original')
    const original = snap.track()

    writeFileSync(join(tempDir, 'config.txt'), 'corrupted data!!!')
    snap.track() // record the bad state

    snap.restore(original)
    const content = readFileSync(join(tempDir, 'config.txt'), 'utf-8')
    expect(content).toBe('original')
  })

  // 10. restore() removes files that didn't exist in the snapshot
  it('restore() removes files that did not exist in the snapshot', () => {
    snap.init()
    writeFileSync(join(tempDir, 'keep.txt'), 'keep me')
    const clean = snap.track()

    writeFileSync(join(tempDir, 'rogue.txt'), 'should not survive restore')
    snap.track()

    snap.restore(clean)
    expect(existsSync(join(tempDir, 'keep.txt'))).toBe(true)
    expect(existsSync(join(tempDir, 'rogue.txt'))).toBe(false)
  })
})
