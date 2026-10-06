import { describe, it, expect, beforeEach } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-allchunks-'))
})

describe('IndexStore.allChunks', () => {
  it('allChunks returns ids and filters by chunk type', () => {
    const store = new IndexStore(join(dir, 'p.db'))
    const a = store.insertChunk({ filePath: 'knowledge/a.md', chunkType: 'knowledge', name: 'A', startLine: 1, endLine: 1, content: 'resin cures slowly', fileHash: 'h1' }, [])
    store.insertChunk({ filePath: 'src/x.ts', chunkType: 'function', name: 'x', startLine: 1, endLine: 2, content: 'function x(){}', fileHash: 'h2' }, [])
    const all = store.allChunks()
    expect(all).toHaveLength(2)
    expect(all.find(r => r.id === a)?.content).toBe('resin cures slowly')
    expect(store.allChunks(['knowledge']).map(r => r.filePath)).toEqual(['knowledge/a.md'])
    expect(store.keywordSearch('resin', 5)[0].id).toBe(a)
    store.close()
  })
})
