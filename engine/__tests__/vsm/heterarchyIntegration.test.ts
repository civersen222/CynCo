import { describe, expect, it } from 'bun:test'
import { HeterarchyIntegration } from '../../vsm/heterarchyIntegration.js'

describe('HeterarchyIntegration', () => {
  it('S3 commands in normal context', () => {
    const h = new HeterarchyIntegration()
    expect(h.whoCommands('normal')).toBe('S3')
  })

  it('S5 commands in crisis context', () => {
    const h = new HeterarchyIntegration()
    expect(h.whoCommands('crisis')).toBe('S5')
  })

  it('S4 commands in exploration context', () => {
    const h = new HeterarchyIntegration()
    expect(h.whoCommands('exploration')).toBe('S4')
  })

  it('S1 commands in routine context', () => {
    const h = new HeterarchyIntegration()
    expect(h.whoCommands('routine')).toBe('S1')
  })

  it('S4 commands when stuck', () => {
    const h = new HeterarchyIntegration()
    expect(h.whoCommands('stuck')).toBe('S4')
  })

  it('has redundancy in all contexts', () => {
    const h = new HeterarchyIntegration()
    expect(h.hasRedundancy('normal')).toBe(true)
    expect(h.hasRedundancy('crisis')).toBe(true)
    expect(h.hasRedundancy('exploration')).toBe(true)
    expect(h.hasRedundancy('routine')).toBe(true)
    expect(h.hasRedundancy('stuck')).toBe(true)
  })

  it('preference graph has healthy cycles (heterarchy)', () => {
    const h = new HeterarchyIntegration()
    expect(h.isHealthyHeterarchy()).toBe(true)
  })

  it('classifies crisis when algedonic critical', () => {
    const h = new HeterarchyIntegration()
    expect(h.classifyContext(0, true, false, 0)).toBe('crisis')
  })

  it('classifies stuck when 3+ stuck turns', () => {
    const h = new HeterarchyIntegration()
    expect(h.classifyContext(3, false, false, 0)).toBe('stuck')
  })

  it('classifies exploration for new task types', () => {
    const h = new HeterarchyIntegration()
    expect(h.classifyContext(0, false, true, 0)).toBe('exploration')
  })
})
