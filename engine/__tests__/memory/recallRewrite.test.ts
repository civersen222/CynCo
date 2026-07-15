import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LearningStore } from '../../memory/learningStore.js'
import { recallMemories, formatRecalledMemories } from '../../memory/recall.js'

describe('recall.ts on LearningStore', () => {
  let dir: string
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('recallMemories reads from a LearningStore db path (no python subprocess)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-'))
    const dbPath = join(dir, 'learnings.db')
    const store = new LearningStore(dbPath)
    store.save({ type: 'preference', content: 'always use vitest run' })
    store.close()

    const memories = await recallMemories('how to run tests with vitest', 5, dbPath)
    expect(memories.length).toBeGreaterThan(0)
    expect(memories[0].content).toContain('vitest')
    expect(memories[0].type).toBe('preference')
  })

  it('formatRecalledMemories renders a Recalled Learnings block', () => {
    const section = formatRecalledMemories([{ type: 'pattern', content: 'x', context: 'ctx' }])
    expect(section).toContain('## Recalled Learnings')
    expect(section).toContain('[pattern]')
  })

  it('returns [] gracefully when the db does not exist', async () => {
    const memories = await recallMemories('anything', 5, join(tmpdir(), 'nope-does-not-exist.db'))
    expect(memories).toEqual([])
  })
})
