import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { LearningStore, defaultLearningsDbPath } from '../../memory/learningStore.js'
import { cyncoHome } from '../../paths.js'

describe('LearningStore.save (schema + bitemporal + counters)', () => {
  it('saves a learning and reads it back with defaults', () => {
    const store = new LearningStore(':memory:')
    const id = store.save({ type: 'preference', content: 'user likes tabs', context: 'formatting' })
    expect(id).toBeGreaterThan(0)
    const all = store.allIncludingInvalidated()
    expect(all).toHaveLength(1)
    expect(all[0].content).toBe('user likes tabs')
    expect(all[0].type).toBe('preference')
    expect(all[0].helpful).toBe(0)
    expect(all[0].harmful).toBe(0)
    expect(all[0].promoted).toBe(0)
    expect(all[0].validFrom).toBeGreaterThan(0)
    expect(all[0].invalidatedAt).toBeNull()
    store.close()
  })

  it('stores a sessionId so learnings can be grouped', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'p1', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'p2', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'p3', sessionId: 'sess-B' })
    expect(store.idsForSession('sess-A')).toHaveLength(2)
    expect(store.idsForSession('sess-B')).toHaveLength(1)
    store.close()
  })

  it('persists an embedding as a Float32 BLOB round-trip', () => {
    const store = new LearningStore(':memory:')
    const id = store.save({ type: 'decision', content: 'use vitest', embedding: [0.1, 0.2, 0.3] })
    const emb = store.embeddingFor(id)
    expect(emb).not.toBeNull()
    expect(emb!.length).toBe(3)
    expect(emb![0]).toBeCloseTo(0.1, 5)
    store.close()
  })

  it('defaultLearningsDbPath points under the CynCo state directory', () => {
    // Was `toContain('.cynco')` — the literal directory name, which is the
    // mechanism, not the property. The property is that the learnings DB lives
    // under whatever CynCo currently calls home, and that is what has to keep
    // holding once CYNCO_HOME can move it (F58). `toBe` over `toContain` also
    // pins the filename to a position rather than to "appears somewhere".
    expect(defaultLearningsDbPath()).toBe(join(cyncoHome(), 'learnings.db'))
  })
})
