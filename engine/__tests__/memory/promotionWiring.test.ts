import { describe, expect, it } from 'bun:test'
import { LearningStore, promoteSessionLearnings } from '../../memory/learningStore.js'

describe('promoteSessionLearnings (AWM gate)', () => {
  it('promotes a session\'s learnings when the gate said yes', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'a', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'b', sessionId: 'sess-A' })
    store.save({ type: 'pattern', content: 'c', sessionId: 'sess-B' })

    const promoted = promoteSessionLearnings(store, 'sess-A', { promote: true })
    expect(promoted).toBe(2)
    const all = store.allIncludingInvalidated()
    expect(all.filter(l => l.sessionId === 'sess-A').every(l => l.promoted === 1)).toBe(true)
    // And only that session's.
    expect(all.find(l => l.sessionId === 'sess-B')!.promoted).toBe(0)
    store.close()
  })

  it('promotes nothing when the gate said no', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'x', sessionId: 'sess-B' })
    const promoted = promoteSessionLearnings(store, 'sess-B', { promote: false })
    expect(promoted).toBe(0)
    expect(store.allIncludingInvalidated()[0].promoted).toBe(0)
    store.close()
  })
})
