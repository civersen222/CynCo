import { describe, expect, it } from 'bun:test'
import { resolveSpecifier, buildRepoGraph, formatRepoMap } from '../../index/repoMapBuilder.js'

const FILES = ['engine/index/store.ts', 'engine/index/indexer.ts', 'engine/util/log.ts']

describe('resolveSpecifier', () => {
  it('resolves a relative specifier to an indexed file', () => {
    expect(resolveSpecifier('./store.js', FILES)).toBe('engine/index/store.ts')
  })

  it('resolves a deeper relative specifier', () => {
    expect(resolveSpecifier('../index/store', FILES)).toBe('engine/index/store.ts')
  })

  it('returns null for a third-party / unresolvable specifier', () => {
    expect(resolveSpecifier('react', FILES)).toBeNull()
    expect(resolveSpecifier('EventEmitter', FILES)).toBeNull()
  })
})

describe('buildRepoGraph + pageRank', () => {
  it('ranks a heavily-imported file\'s symbols above an unimported one', () => {
    const defs = [
      { file: 'engine/index/store.ts', name: 'IndexStore', kind: 'class' },
      { file: 'engine/index/indexer.ts', name: 'ProjectIndexer', kind: 'class' },
      { file: 'engine/util/log.ts', name: 'logUnused', kind: 'function' },
    ]
    // indexer imports store; nothing imports log.ts
    const rels = [
      { sourceFile: 'engine/index/indexer.ts', sourceName: 'ProjectIndexer', target: './store.js' },
    ]
    const graph = buildRepoGraph(defs, rels, FILES)
    expect(graph.edgeCount()).toBeGreaterThan(0)

    const ranked = graph.pageRank([], 3)
    const storeRank = ranked.findIndex(r => r.name === 'IndexStore')
    const logRank = ranked.findIndex(r => r.name === 'logUnused')
    expect(storeRank).toBeGreaterThanOrEqual(0)
    expect(storeRank).toBeLessThan(logRank)
  })

  it('produces no edges when all targets are unresolvable', () => {
    const defs = [{ file: 'engine/index/store.ts', name: 'IndexStore', kind: 'class' }]
    const rels = [{ sourceFile: 'engine/index/store.ts', sourceName: 'IndexStore', target: 'react' }]
    const graph = buildRepoGraph(defs, rels, FILES)
    expect(graph.edgeCount()).toBe(0)
  })
})

describe('formatRepoMap', () => {
  it('formats ranked definitions into a repo-map block', () => {
    const block = formatRepoMap([
      { file: 'engine/index/store.ts', name: 'IndexStore', kind: 'class', score: 0.9 },
    ])
    expect(block).toContain('[Repo map]')
    expect(block).toContain('engine/index/store.ts :: IndexStore (class)')
  })

  it('returns empty string for no results', () => {
    expect(formatRepoMap([])).toBe('')
  })
})
