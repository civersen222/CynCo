import { describe, expect, it } from 'bun:test'
import { LearningStore } from '../../memory/learningStore.js'

describe('LearningStore promote/demote + ACE delta', () => {
  it('promote(id, true) sets promoted=1; promote(id, false) is a no-op', () => {
    const store = new LearningStore(':memory:')
    const id = store.save({ type: 'pattern', content: 'c' })
    store.promote(id, false)
    expect(store.allIncludingInvalidated()[0].promoted).toBe(0)
    store.promote(id, true)
    expect(store.allIncludingInvalidated()[0].promoted).toBe(1)
    store.close()
  })

  it('markHelpful / markHarmful bump counters (delta update, not overwrite)', () => {
    const store = new LearningStore(':memory:')
    const id = store.save({ type: 'pattern', content: 'c' })
    store.markHelpful(id)
    store.markHelpful(id)
    store.markHarmful(id)
    const row = store.allIncludingInvalidated()[0]
    expect(row.helpful).toBe(2)
    expect(row.harmful).toBe(1)
    store.close()
  })

  it('demote sets invalidated_at (demote-dont-delete) and hides from active reads', () => {
    const store = new LearningStore(':memory:')
    const id = store.save({ type: 'pattern', content: 'c' })
    store.demote(id)
    const row = store.allIncludingInvalidated()[0]
    expect(row.invalidatedAt).not.toBeNull()
    // still present in the audit view, just marked invalid — no rows deleted
    expect(store.allIncludingInvalidated()).toHaveLength(1)
    store.close()
  })

  it('duplicate (type, content) save bumps helpful instead of inserting a new row', () => {
    const store = new LearningStore(':memory:')
    const id1 = store.save({ type: 'preference', content: 'dup' })
    const id2 = store.save({ type: 'preference', content: 'dup' })
    expect(id2).toBe(id1) // same row returned
    expect(store.allIncludingInvalidated()).toHaveLength(1)
    expect(store.allIncludingInvalidated()[0].helpful).toBe(1)
    store.close()
  })
})
