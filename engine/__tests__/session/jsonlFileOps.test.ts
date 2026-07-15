import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { JSONLStore } from '../../session/jsonlStore.js'

function sessionFile(id: string) { return join(homedir(), '.cynco', 'sessions', `${id}.jsonl`) }

describe('JSONLStore file-ops + session-end marker', () => {
  const id = `test-fileops-${Date.now()}`
  afterEach(() => { const f = sessionFile(id); if (existsSync(f)) rmSync(f) })

  it('loadFileOps returns the most recent journaled fileOps string', () => {
    const store = new JSONLStore(id)
    store.appendCompaction('summary one', JSON.stringify([{ path: 'a.ts', tool: 'Edit', timestamp: 1 }]))
    store.appendCompaction('summary two', JSON.stringify([{ path: 'b.ts', tool: 'Edit', timestamp: 2 }]))
    const ops = store.loadFileOps()
    expect(ops).toContain('b.ts')
  })

  it('loadFileOps returns null when no compaction was journaled', () => {
    const store = new JSONLStore(id)
    store.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(store.loadFileOps()).toBeNull()
  })

  it('appendSessionEnd marks the session ended; hasEnded reflects it', () => {
    const store = new JSONLStore(id)
    store.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(store.hasEnded()).toBe(false)
    store.appendSessionEnd()
    expect(store.hasEnded()).toBe(true)
  })
})
