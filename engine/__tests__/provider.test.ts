import { describe, expect, it } from 'bun:test'
import type {
  Provider, ModelCapabilities, CapabilityTier,
  ToolUseCapability, ThinkingCapability,
} from '../provider.js'
import { deriveTier } from '../provider.js'

describe('deriveTier', () => {
  it('native tool use = advanced', () => {
    expect(deriveTier('native', 'native')).toBe('advanced')
    expect(deriveTier('native', 'none')).toBe('advanced')
  })
  it('simulated tool use = standard', () => {
    expect(deriveTier('simulated', 'none')).toBe('standard')
    expect(deriveTier('simulated', 'simulated')).toBe('standard')
  })
  it('no tool use = basic', () => {
    expect(deriveTier('none', 'none')).toBe('basic')
    expect(deriveTier('none', 'native')).toBe('basic')
  })

  it('exports ToolUseCapability and ThinkingCapability type aliases', () => {
    const t: ToolUseCapability = 'native'
    expect(t).toBe('native')
    const th: ThinkingCapability = 'simulated'
    expect(th).toBe('simulated')
  })
})
