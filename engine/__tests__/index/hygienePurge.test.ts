import { describe, it, expect } from 'bun:test'
import { IndexStore } from '../../index/store.js'
import { ProjectIndexer } from '../../index/indexer.js'
import { mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const chunkFor = (filePath: string) => ({
  filePath, chunkType: 'block', name: 'x', startLine: 1, endLine: 2,
  content: 'stale', fileHash: 'h',
})

describe('index hygiene purge on open', () => {
  it('removes non-indexable and out-of-tree rows, keeps real source', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-purge-'))
    const dbDir = join(root, '.cynco', 'index')
    mkdirSync(dbDir, { recursive: true })

    // Seed a store the way the pre-guard index accumulated junk.
    const seed = new IndexStore(join(dbDir, 'project.db'))
    const mdId = seed.insertChunk(chunkFor('SESSION_HANDOFF.md'), [])          // the measured leak
    seed.insertRelationship({ sourceChunkId: mdId, targetFile: 'x', relType: 'import' })
    seed.insertChunk(chunkFor('..\\scratch\\probe.py'), [])                    // traversal escape
    seed.insertChunk(chunkFor('gilded/orders.py'), [])                         // legit
    seed.close()

    const indexer = new ProjectIndexer(root)
    const store = (indexer as any).store as IndexStore
    expect(store.getIndexedFiles()).toEqual(['gilded/orders.py'])
    expect(store.getAllRelationships()).toHaveLength(0)                        // cascade cleaned
    indexer.close()
  })
})
