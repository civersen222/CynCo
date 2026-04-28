import { describe, expect, it, beforeEach } from 'bun:test'
import { AutopoiesisIntegration } from '../../vsm/autopoiesisIntegration.js'
import { resetEventBus, getEventBus } from '../../vsm/eventBus.js'
import { NodeId } from '../../cybernetics-core/src/index.js'
import { ProposalStatus } from '../../cybernetics-core/src/autopoiesis/index.js'

describe('AutopoiesisIntegration', () => {
  let auto: AutopoiesisIntegration

  beforeEach(() => {
    resetEventBus()
    auto = new AutopoiesisIntegration(new NodeId())
  })

  it('production network is initialized with LocalCode components', () => {
    expect(auto.productionNetwork.componentCount()).toBe(4)
    expect(auto.productionNetwork.productionCount()).toBe(5)
  })

  it('production network is closed (all components produced)', () => {
    const { closed, gaps } = auto.checkClosure()
    expect(closed).toBe(true)
    expect(gaps).toHaveLength(0)
  })

  it('identity score starts at 1.0 (all invariants present)', () => {
    expect(auto.getIdentityScore()).toBe(1.0)
  })

  it('proposeParameterChange within bounds → Applied', () => {
    const proposal = auto.proposeParameterChange('temperature', 0.5, { min: 0, max: 2 })
    expect(proposal.status).toBe(ProposalStatus.Applied)
  })

  it('proposeParameterChange out of bounds → Rejected', () => {
    const proposal = auto.proposeParameterChange('temperature', 5.0, { min: 0, max: 2 })
    expect(proposal.status).toBe(ProposalStatus.Rejected)
  })

  it('proposal emits domain events', () => {
    auto.proposeParameterChange('temperature', 0.5, { min: 0, max: 2 })
    const bus = getEventBus()
    const proposed = bus.replayFiltered(e => e.payload.kind === 'ModificationProposed')
    const decided = bus.replayFiltered(e => e.payload.kind === 'ModificationDecided')
    expect(proposed.length).toBe(1)
    expect(decided.length).toBe(1)
  })

  it('recordInteraction tracks structural coupling', () => {
    for (let i = 0; i < 10; i++) {
      auto.recordInteraction(i * 0.1, i * 0.1 + 0.05) // correlated
    }
    const score = auto.getCouplingScore()
    expect(score).toBeGreaterThan(0.5) // should be strongly correlated
  })

  it('proposal log tracks all proposals', () => {
    auto.proposeParameterChange('temp', 0.5, { min: 0, max: 2 })
    auto.proposeParameterChange('tokens', 99999, { min: 0, max: 8192 })
    expect(auto.getProposalLog()).toHaveLength(2)
  })
})
