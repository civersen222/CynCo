import { describe, it, expect } from 'bun:test'
import { EssentialVariableRegistry, type EssentialVariable } from '../../vsm/essentialVariables.js'

describe('EssentialVariableRegistry', () => {
  it('initializes with default variables', () => {
    const reg = new EssentialVariableRegistry()
    const vars = reg.getAll()
    expect(vars.length).toBe(6)
    expect(vars.map(v => v.name)).toContain('tool_error_rate')
    expect(vars.map(v => v.name)).toContain('context_utilization')
    expect(vars.map(v => v.name)).toContain('stuck_turns')
    expect(vars.map(v => v.name)).toContain('token_efficiency')
    expect(vars.map(v => v.name)).toContain('reflection_frequency')
    expect(vars.map(v => v.name)).toContain('s4_composite')
  })

  it('checks viability — all in bounds returns true', () => {
    const reg = new EssentialVariableRegistry()
    const measurements = {
      tool_error_rate: 0.2,
      context_utilization: 0.5,
      stuck_turns: 1,
      token_efficiency: 1.0,
      reflection_frequency: 8, s4_composite: 7,
    }
    expect(reg.checkViability(measurements)).toEqual({ viable: true, breached: [] })
  })

  it('checks viability — out of bounds returns breached list', () => {
    const reg = new EssentialVariableRegistry()
    const measurements = {
      tool_error_rate: 0.6,
      context_utilization: 0.9,
      stuck_turns: 1,
      token_efficiency: 1.0,
      reflection_frequency: 8, s4_composite: 7,
    }
    const result = reg.checkViability(measurements)
    expect(result.viable).toBe(false)
    expect(result.breached).toContain('tool_error_rate')
    expect(result.breached).toContain('context_utilization')
  })

  it('evolves bounds from observed data', () => {
    const reg = new EssentialVariableRegistry()
    const observations = Array.from({ length: 10 }, () => ({
      tool_error_rate: 0.35 + Math.random() * 0.1,
    }))
    reg.evolveBounds(observations)
    const v = reg.get('tool_error_rate')!
    expect(v.bounds[1]).toBeGreaterThan(0.4)
    expect(v.bounds[1]).toBeLessThanOrEqual(1.0)
  })

  it('refuses to evolve bounds beyond meta-bounds', () => {
    const reg = new EssentialVariableRegistry()
    const observations = Array.from({ length: 10 }, () => ({
      tool_error_rate: 0.99,
    }))
    reg.evolveBounds(observations)
    const v = reg.get('tool_error_rate')!
    expect(v.bounds[1]).toBeLessThanOrEqual(1.0)
  })

  it('adds a new variable', () => {
    const reg = new EssentialVariableRegistry()
    reg.addVariable({
      name: 'tool_diversity',
      bounds: [1, 5],
      metaBounds: [0, 20],
      neverBreachedCount: 0,
    })
    expect(reg.getAll().length).toBe(7)
    expect(reg.get('tool_diversity')).toBeDefined()
  })

  it('retires a variable that never constrains', () => {
    const reg = new EssentialVariableRegistry()
    const v = reg.get('stuck_turns')!
    v.neverBreachedCount = 10
    v.bounds = [...v.metaBounds]
    const retired = reg.retireCandidates()
    expect(retired).toContain('stuck_turns')
  })

  it('serializes and deserializes to JSON', () => {
    const reg = new EssentialVariableRegistry()
    const json = reg.toJSON()
    const reg2 = EssentialVariableRegistry.fromJSON(json)
    expect(reg2.getAll().length).toBe(6)
    expect(reg2.get('tool_error_rate')!.bounds).toEqual(reg.get('tool_error_rate')!.bounds)
  })
})
