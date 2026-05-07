import { describe, it, expect, beforeEach } from 'bun:test'
import { registerEngine, getEngine, getAllEngines, getHealthyEngines, resetEngines } from '../../../research/engines/registry.js'
import type { SearchEngine } from '../../../research/types.js'

function mockEngine(name: string, healthy: boolean): SearchEngine {
  return {
    name,
    description: `Mock ${name}`,
    domains: ['test'],
    search: async () => [],
    healthCheck: async () => healthy,
  }
}

describe('Engine registry', () => {
  beforeEach(() => resetEngines())

  it('registers and retrieves engines', () => {
    const engine = mockEngine('test', true)
    registerEngine(engine)
    expect(getEngine('test')).toBe(engine)
  })
  it('returns undefined for unknown engine', () => {
    expect(getEngine('nonexistent')).toBeUndefined()
  })
  it('lists all registered engines', () => {
    registerEngine(mockEngine('a', true))
    registerEngine(mockEngine('b', true))
    expect(getAllEngines().length).toBe(2)
  })
  it('filters to healthy engines', async () => {
    registerEngine(mockEngine('healthy', true))
    registerEngine(mockEngine('unhealthy', false))
    const healthy = await getHealthyEngines()
    expect(healthy.length).toBe(1)
    expect(healthy[0].name).toBe('healthy')
  })
})
