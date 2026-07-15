import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveLearningTool } from '../../tools/impl/saveLearning.js'
import { recallMemories, formatRecalledMemories } from '../../memory/recall.js'

describe('two-session memory closure', () => {
  let dir: string, prev: string | undefined
  afterEach(() => {
    if (prev === undefined) delete process.env.LOCALCODE_LEARNINGS_DB
    else process.env.LOCALCODE_LEARNINGS_DB = prev
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('a learning saved in session 1 is recalled in session 2', async () => {
    dir = mkdtempSync(join(tmpdir(), 'twosession-'))
    const dbPath = join(dir, 'learnings.db')
    prev = process.env.LOCALCODE_LEARNINGS_DB
    process.env.LOCALCODE_LEARNINGS_DB = dbPath

    // Session 1: save (embed server absent → embedding undefined, still stored)
    const saved = await saveLearningTool.execute(
      { type: 'preference', content: 'always run migrations before deploy' },
      {} as any,
    )
    expect(saved.isError).toBe(false)

    // Session 2: recall via the same db path
    const memories = await recallMemories('what should I do before deploy', 5, dbPath)
    const section = formatRecalledMemories(memories)
    expect(section).toContain('migrations before deploy')
  })
})
