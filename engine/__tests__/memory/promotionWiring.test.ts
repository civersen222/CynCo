import { describe, expect, it } from 'bun:test'
import { LearningStore, promoteSessionLearnings } from '../../memory/learningStore.js'

describe('promoteSessionLearnings (AWM gate)', () => {
  it('promotes a session\'s learnings only when outcome is viable', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'a', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'b', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'c', sessionId: 'sess-B' })

    const promoted = promoteSessionLearnings(store, 'sess-A', 'viable')
    expect(promoted).toBe(2)
    const all = store.allIncludingInvalidated()
    expect(all.filter(l => l.sessionId === 'sess-A').every(l => l.promoted === 1)).toBe(true)
    store.close()
  })

  it('does NOT promote on a non-viable outcome', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'x', sessionId: 'sess-B' })
    const promoted = promoteSessionLearnings(store, 'sess-B', 'non-viable')
    expect(promoted).toBe(0)
    expect(store.allIncludingInvalidated()[0].promoted).toBe(0)
    store.close()
  })

  it('does NOT promote on a marginal outcome', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'y', sessionId: 'sess-C' })
    expect(promoteSessionLearnings(store, 'sess-C', 'marginal')).toBe(0)
    store.close()
  })
})
