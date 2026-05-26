import { describe, it, expect } from 'vitest'
import { HeterarchyIntegration } from '../vsm/heterarchyIntegration.js'

describe('heterarchy wiring', () => {
  it('whoCommands returns S5 in crisis', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('crisis')).toBe('S5')
  })
  it('whoCommands returns S3 in normal', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('normal')).toBe('S3')
  })
  it('whoCommands returns S4 in exploration', () => {
    const het = new HeterarchyIntegration()
    expect(het.whoCommands('exploration')).toBe('S4')
  })
  it('classifyContext returns crisis for algedonic critical', () => {
    const het = new HeterarchyIntegration()
    expect(het.classifyContext(0, true, false, 5)).toBe('crisis')
  })
  it('classifyContext returns stuck for 3+ turns', () => {
    const het = new HeterarchyIntegration()
    expect(het.classifyContext(3, false, false, 5)).toBe('stuck')
  })
})
