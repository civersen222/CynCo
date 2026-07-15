import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveLearningTool } from './saveLearning.js'
import { LearningStore } from '../../memory/learningStore.js'

describe('SaveLearning tool on LearningStore', () => {
  let dir: string, prevHome: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'savelearn-'))
    prevHome = process.env.LOCALCODE_LEARNINGS_DB
    process.env.LOCALCODE_LEARNINGS_DB = join(dir, 'learnings.db')
    process.env.LOCALCODE_RECALL_EMBED_TIMEOUT_MS = '1'
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.LOCALCODE_LEARNINGS_DB
    else process.env.LOCALCODE_LEARNINGS_DB = prevHome
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('writes a learning to the store db', async () => {
    const res = await saveLearningTool.execute({ type: 'preference', content: 'use tabs' }, {} as any)
    expect(res.isError).toBe(false)
    const store = new LearningStore(process.env.LOCALCODE_LEARNINGS_DB!)
    expect(store.allIncludingInvalidated()).toHaveLength(1)
    store.close()
  })

  it('duplicate save bumps helpful, does not add a second row', async () => {
    await saveLearningTool.execute({ type: 'preference', content: 'dup' }, {} as any)
    await saveLearningTool.execute({ type: 'preference', content: 'dup' }, {} as any)
    const store = new LearningStore(process.env.LOCALCODE_LEARNINGS_DB!)
    const all = store.allIncludingInvalidated()
    expect(all).toHaveLength(1)
    expect(all[0].helpful).toBe(1)
    store.close()
  })

  it('empty content is rejected', async () => {
    const res = await saveLearningTool.execute({ type: 'preference', content: '' }, {} as any)
    expect(res.isError).toBe(true)
  })
})
