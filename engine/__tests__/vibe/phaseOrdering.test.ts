import { describe, expect, it } from 'bun:test'
import { orderPhasesByEntailment, type Phase } from '../../vibe/phaseOrdering.js'

describe('orderPhasesByEntailment', () => {
  it('orders prerequisites before dependents', () => {
    const phases: Phase[] = [
      { name: 'testing', requires: ['implementation'] },
      { name: 'implementation', requires: ['design'] },
      { name: 'design', requires: [] },
    ]
    const ordered = orderPhasesByEntailment(phases).map(p => p.name)
    expect(ordered.indexOf('design')).toBeLessThan(ordered.indexOf('implementation'))
    expect(ordered.indexOf('implementation')).toBeLessThan(ordered.indexOf('testing'))
  })
  it('is a no-op when phases declare no prerequisites', () => {
    const phases: Phase[] = [{ name: 'a', requires: [] }, { name: 'b', requires: [] }]
    expect(orderPhasesByEntailment(phases).map(p => p.name)).toEqual(['a', 'b'])
  })
  it('detects cycles and returns the input order unchanged', () => {
    const phases: Phase[] = [{ name: 'a', requires: ['b'] }, { name: 'b', requires: ['a'] }]
    expect(orderPhasesByEntailment(phases).map(p => p.name)).toEqual(['a', 'b'])
  })
})
