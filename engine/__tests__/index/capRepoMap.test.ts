import { describe, expect, it } from 'bun:test'
import { capRepoMap } from '../../index/indexer.js'

describe('capRepoMap', () => {
  it('returns short maps unchanged', () => {
    const m = 'line1\nline2\nline3'
    expect(capRepoMap(m, 2000)).toBe(m)
  })

  it('truncates to roughly the token budget and appends a marker', () => {
    const m = Array.from({ length: 5000 }, (_, i) => `symbol_${i} in file_${i}.ts`).join('\n')
    const capped = capRepoMap(m, 2000)
    // ~4 chars/token → ~8000 chars budget; capped must be well under the input
    expect(capped.length).toBeLessThan(m.length)
    expect(capped.length).toBeLessThanOrEqual(2000 * 4 + 64)
    expect(capped).toContain('[repo map truncated')
  })
})
