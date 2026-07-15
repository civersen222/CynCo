import { describe, expect, it } from 'bun:test'
import { LearningStore } from '../../memory/learningStore.js'

describe('LearningStore.recall (generative-agents ranking)', () => {
  it('recall returns most-relevant first, caps to k, excludes invalidated', () => {
    const store = new LearningStore(':memory:')
    store.save({ type: 'pattern', content: 'use vitest for typescript tests' })
    store.save({ type: 'pattern', content: 'python uses pytest' })
    const junk = store.save({ type: 'pattern', content: 'unrelated banana note' })
    store.demote(junk)
    const results = store.recall('how do I run typescript tests', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
    expect(results[0].content).toContain('vitest')
    // invalidated row is never recalled
    expect(results.find(r => r.content.includes('banana'))).toBeUndefined()
    store.close()
  })

  it('promoted learnings get a ranking bonus over an otherwise-equal peer', () => {
    const store = new LearningStore(':memory:')
    const a = store.save({ type: 'decision', content: 'shared keyword alpha one' })
    const b = store.save({ type: 'decision', content: 'shared keyword alpha two' })
    store.promote(b, true)
    const results = store.recall('shared keyword alpha', 5)
    const ia = results.findIndex(r => r.id === a)
    const ib = results.findIndex(r => r.id === b)
    expect(ib).toBeLessThan(ia) // promoted 'b' ranks ahead
    store.close()
  })

  it('caps to k even when more match', () => {
    const store = new LearningStore(':memory:')
    for (let i = 0; i < 12; i++) store.save({ type: 'pattern', content: `common token item ${i}` })
    expect(store.recall('common token', 5)).toHaveLength(5)
    store.close()
  })
})
