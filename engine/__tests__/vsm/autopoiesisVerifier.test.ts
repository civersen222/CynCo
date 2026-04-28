import { describe, it, expect } from 'bun:test'
import { AutopoiesisVerifier } from '../../vsm/autopoiesisVerifier.js'

describe('AutopoiesisVerifier', () => {
  it('builds the production network with all components', () => {
    const v = new AutopoiesisVerifier()
    expect(v.getComponentCount()).toBeGreaterThanOrEqual(6)
  })

  it('verifies organizational closure', () => {
    const v = new AutopoiesisVerifier()
    const result = v.verifyClosure()
    expect(result.closed).toBe(true)
    expect(result.gaps).toEqual([])
  })

  it('detects a gap when an external component is added', () => {
    const v = new AutopoiesisVerifier()
    v.addExternalComponent('hand_coded_rule')
    const result = v.verifyClosure()
    expect(result.closed).toBe(false)
    expect(result.gaps).toContain('hand_coded_rule')
  })

  it('checks all six autopoiesis criteria', () => {
    const v = new AutopoiesisVerifier()
    const assessment = v.assess({ populationExists: true, registryEvolvable: true, identityGuardActive: true })
    expect(assessment.hasBoundary).toBe(true)
    expect(assessment.boundarySelfProduced).toBe(true)
    expect(assessment.internalProduction).toBe(true)
    expect(assessment.circularProduction).toBe(true)
    expect(assessment.organizationallyClosed).toBe(true)
    expect(assessment.organizationMaintained).toBe(true)
    expect(assessment.isAutopoietic).toBe(true)
  })

  it('fails autopoiesis when identity guard is not active', () => {
    const v = new AutopoiesisVerifier()
    const assessment = v.assess({ populationExists: true, registryEvolvable: true, identityGuardActive: false })
    expect(assessment.organizationMaintained).toBe(false)
    expect(assessment.isAutopoietic).toBe(false)
  })

  it('fails autopoiesis when population does not exist', () => {
    const v = new AutopoiesisVerifier()
    const assessment = v.assess({ populationExists: false, registryEvolvable: true, identityGuardActive: true })
    expect(assessment.hasBoundary).toBe(false)
    expect(assessment.isAutopoietic).toBe(false)
  })

  it('reports missing criteria', () => {
    const v = new AutopoiesisVerifier()
    const assessment = v.assess({ populationExists: false, registryEvolvable: false, identityGuardActive: false })
    expect(assessment.missingCriteria.length).toBeGreaterThan(0)
  })
})
