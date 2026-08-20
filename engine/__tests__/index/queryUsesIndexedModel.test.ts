import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IndexStore } from '../../index/store.js'
import { ProjectIndexer } from '../../index/indexer.js'

/**
 * An index is only comparable to query vectors from the same embedding model.
 * The store already records which one built it (`embed_model` meta, shown by
 * `getSummary()`), but `ProjectIndexer` ignored that on the way back in and
 * always constructed an `EmbedClient` on the process default.
 *
 * Today that default is `jina-code-embeddings-0.5b`, the existing indexes were
 * built with `nomic-embed-text`, and search only kept working by accident:
 * jina isn't installed, so `EmbedClient` fell back to nomic. Install jina and
 * every query would embed in a space the stored vectors do not share — a
 * different dimension is a hard error, the same dimension is worse, because it
 * returns confident nonsense.
 *
 * The recorded model is the authority for querying. A fresh index has no
 * recorded model yet and must keep using the configured default.
 */
describe('ProjectIndexer embedding model', () => {
  const dirs: string[] = []

  const projectWithMeta = (model?: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'qim-'))
    dirs.push(root)
    const indexDir = join(root, '.cynco', 'index')
    mkdirSync(indexDir, { recursive: true })
    const store = new IndexStore(join(indexDir, 'project.db'))
    if (model) store.setMeta('embed_model', model)
    store.close()
    return root
  }

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('queries with the model that built the index', () => {
    const indexer = new ProjectIndexer(projectWithMeta('nomic-embed-text'))
    expect(indexer['embedClient'].modelName).toBe('nomic-embed-text')
    indexer.close()
  })

  it('leaves a freshly created index on the configured default', () => {
    const indexer = new ProjectIndexer(projectWithMeta())
    expect(indexer['embedClient'].modelName).toBe('jina-code-embeddings-0.5b')
    indexer.close()
  })
})
