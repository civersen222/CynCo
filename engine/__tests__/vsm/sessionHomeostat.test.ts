import { describe, it, expect } from 'bun:test'
import { SessionHomeostat } from '../../vsm/sessionHomeostat.js'
import { EssentialVariableRegistry } from '../../vsm/essentialVariables.js'

describe('SessionHomeostat', () => {
  it('reports viable when all measurements in bounds', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const result = sh.update({ tool_error_rate: 0.1, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 })
    expect(result.viable).toBe(true)
    expect(result.perturbed).toBe(false)
    expect(sh.getPerturbationCount()).toBe(0)
  })

  it('perturbs with small magnitude when 1 variable breached', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const result = sh.update({ tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 })
    expect(result.viable).toBe(false)
    expect(result.perturbed).toBe(true)
    expect(result.magnitude).toBeCloseTo(0.1, 1)
    expect(sh.getPerturbationCount()).toBe(1)
  })

  it('perturbs with medium magnitude when 2 variables breached', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const result = sh.update({ tool_error_rate: 0.6, context_utilization: 0.95, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 })
    expect(result.magnitude).toBeCloseTo(0.3, 1)
  })

  it('perturbs with full magnitude when 3+ variables breached', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const result = sh.update({ tool_error_rate: 0.6, context_utilization: 0.95, stuck_turns: 5, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 })
    expect(result.magnitude).toBeCloseTo(1.0, 1)
  })

  it('stops perturbing after max perturbations reached', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg, 3)
    const bad = { tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    sh.update(bad)
    sh.update(bad)
    sh.update(bad)
    const result = sh.update(bad)
    expect(result.perturbed).toBe(false)
    expect(result.maxReached).toBe(true)
    expect(sh.getPerturbationCount()).toBe(3)
  })

  it('tracks viability ratio across session', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const good = { tool_error_rate: 0.1, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    const bad = { tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    sh.update(good)
    sh.update(good)
    sh.update(bad)
    sh.update(good)
    expect(sh.getViabilityRatio()).toBeCloseTo(0.75, 1)
  })

  it('classifies session outcome: viable when >80% turns viable', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const good = { tool_error_rate: 0.1, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    for (let i = 0; i < 9; i++) sh.update(good)
    sh.update({ tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 })
    expect(sh.getSessionOutcome()).toBe('viable')
  })

  it('classifies session outcome: marginal when recovered from perturbation', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const good = { tool_error_rate: 0.1, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    const bad = { tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    sh.update(bad)
    sh.update(bad)
    sh.update(bad)
    for (let i = 0; i < 7; i++) sh.update(good)
    expect(sh.getSessionOutcome()).toBe('marginal')
  })

  it('classifies session outcome: non-viable when <50% viable', () => {
    const reg = new EssentialVariableRegistry()
    const sh = new SessionHomeostat(reg)
    const good = { tool_error_rate: 0.1, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    const bad = { tool_error_rate: 0.6, context_utilization: 0.5, stuck_turns: 0, token_efficiency: 1.0, reflection_frequency: 8, s4_composite: 7 }
    for (let i = 0; i < 6; i++) sh.update(bad)
    for (let i = 0; i < 4; i++) sh.update(good)
    expect(sh.getSessionOutcome()).toBe('non-viable')
  })
})
