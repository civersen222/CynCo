/**
 * ProjectIndexer holds a SQLite handle on <project>/.cynco/index/project.db.
 * On Windows that open handle pins the whole directory: every test that built
 * a ConversationLoop in a temp dir then failed its afterAll rmSync with EPERM,
 * and in a long engine run each unclosed indexer was a leaked descriptor. The
 * per-message context injection closed its indexer on the success path only.
 *
 * These tests pin the contract that fixed it: every open indexer is reachable
 * from closeAllIndexers(), close() is idempotent and observable via isClosed,
 * the CodeIndex tool rebuilds a cached indexer that was closed underneath it,
 * and a directory whose indexers are all closed can actually be removed.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectIndexer, closeAllIndexers } from '../../index/indexer.js'
import { codeIndexTool } from '../../tools/impl/codeIndex.js'

const dirs: string[] = []
function tempProject(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(d, 'a.ts'), 'export function alpha() { return 1 }\n')
  dirs.push(d)
  return d
}
afterAll(() => {
  closeAllIndexers()
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

describe('ProjectIndexer registry', () => {
  it('closeAllIndexers closes every open instance and reports the count', () => {
    closeAllIndexers()
    const cwd = tempProject('cynco-ixreg-')
    const a = new ProjectIndexer(cwd)
    const b = new ProjectIndexer(cwd)
    expect(a.isClosed).toBe(false)
    expect(b.isClosed).toBe(false)

    expect(closeAllIndexers()).toBe(2)
    expect(a.isClosed).toBe(true)
    expect(b.isClosed).toBe(true)
    // Nothing left to close, and closing again is a no-op rather than a throw.
    expect(closeAllIndexers()).toBe(0)
    expect(() => a.close()).not.toThrow()
  })

  it('a directory with all indexers closed can be removed (the Windows EPERM case)', () => {
    closeAllIndexers()
    const cwd = tempProject('cynco-ixrm-')
    const ix = new ProjectIndexer(cwd)
    expect(existsSync(join(cwd, '.cynco', 'index', 'project.db'))).toBe(true)
    ix.close()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
    expect(existsSync(cwd)).toBe(false)
  })

  it('the CodeIndex tool rebuilds a cached indexer that was closed underneath it', async () => {
    closeAllIndexers()
    const cwd = tempProject('cynco-ixtool-')
    // Embedding is unavailable in tests; the tool degrades to keyword/regex and
    // still answers. What matters here is that it answers on BOTH calls.
    const first = await codeIndexTool.execute({ query: 'alpha' }, cwd)
    expect(first.isError ?? false).toBe(false)

    // Shutdown / test teardown closes the tool's cached instance from outside.
    expect(closeAllIndexers()).toBeGreaterThanOrEqual(1)

    // Before the isClosed check the tool queried a closed store and threw.
    const second = await codeIndexTool.execute({ query: 'alpha' }, cwd)
    expect(second.isError ?? false).toBe(false)
  }, 60000)
})
