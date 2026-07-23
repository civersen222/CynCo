import { describe, it, expect } from 'bun:test'
import { LoadedToolSet } from '../../tools/loadedToolSet.js'
import { getCoreTools } from '../../tools/registry.js'

describe('LoadedToolSet', () => {
  it('seeds with the given core tool names', () => {
    const s = new LoadedToolSet(getCoreTools().map(t => t.name))
    expect(s.has('Read')).toBe(true)
    expect(s.has('WebFetch')).toBe(false)
  })

  it('surface() appends, is idempotent, and never drops', () => {
    const s = new LoadedToolSet(['Read'])
    s.surface(['WebFetch', 'WebFetch'])
    expect(s.has('WebFetch')).toBe(true)
    s.surface(['Bash'])
    expect(s.names().sort()).toEqual(['Bash', 'Read', 'WebFetch'])
  })

  it('surface() reports which names were newly added (for the availability block)', () => {
    const s = new LoadedToolSet(['Read'])
    expect(s.surface(['Read', 'Bash']).sort()).toEqual(['Bash'])
    expect(s.surface(['Bash']).length).toBe(0)
  })

  it('snapshot() returns a stable-sorted copy that does not mutate internal state', () => {
    const s = new LoadedToolSet(['Read', 'Bash'])
    const snap = s.snapshot()
    expect(snap).toEqual(['Bash', 'Read'])
    snap.push('X')
    expect(s.has('X')).toBe(false)
  })
})
