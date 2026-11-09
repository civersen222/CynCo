// scripts/__tests__/fix-doc-line-pins.test.mjs
import { describe, expect, it } from 'vitest'
import { rewritePins } from '../fix-doc-line-pins.mjs'

describe('rewritePins (one pass, never re-scans its own output)', () => {
  it('two pins on one line each move once: 12->19 is not caught again by 19->25', () => {
    const map = new Map([['store.ts:12', 19], ['store.ts:19', 25]])
    expect(rewritePins('(`store.ts:12`, `store.ts:19`)', map)).toBe('(`store.ts:19`, `store.ts:25`)')
  })

  it('a range maps both ends, and moves the unmapped end by the same delta', () => {
    expect(rewritePins('`learningStore.ts:232-240`', new Map([['learningStore.ts:232', 244], ['learningStore.ts:240', 252]]))).toBe('`learningStore.ts:244-252`')
    expect(rewritePins('`learningStore.ts:232-240`', new Map([['learningStore.ts:232', 244]]))).toBe('`learningStore.ts:244-252`')
  })

  it('leaves longer numbers, other files and path-prefixed names alone', () => {
    const map = new Map([['store.ts:12', 19]])
    expect(rewritePins('store.ts:120 mystore.ts:12 index/store.ts:12 other.ts:12', map)).toBe('store.ts:120 mystore.ts:12 index/store.ts:12 other.ts:12')
  })

  it('a full-path key matches the full-path token', () => {
    const map = new Map([['engine/bridge/conversationLoop.ts:1255', 1263]])
    expect(rewritePins('(`engine/bridge/conversationLoop.ts:1255`)', map)).toBe('(`engine/bridge/conversationLoop.ts:1263`)')
  })
})
