import { describe, it, expect } from 'vitest'
import { events, NodeId, VarietyBalance } from '../../cybernetics-core/src/index.js'

/**
 * `EventBus.replayForNode` in the vendored cybernetics core compared
 * `eventNodeId(e.payload).value === nodeId.value`. `NodeId` has no `value`
 * (its API is `equals`/`toString`), so both sides were `undefined` and the
 * filter returned every event for every node. Found by the strict type-check
 * (A1) through the engine's import; the upstream copy in
 * C:/Users/civer/cybernetics/cybernetics-ts has the same line.
 */
describe('EventBus.replayForNode', () => {
  it('returns only the events of the node asked for', () => {
    const bus = new events.EventBus()
    const a = new NodeId()
    const b = new NodeId()
    bus.emit(events.DomainEvent.varietyRecalculated(a, 1, 1, VarietyBalance.Balanced))
    bus.emit(events.DomainEvent.varietyRecalculated(b, 1, 1, VarietyBalance.Balanced))
    bus.emit(events.DomainEvent.varietyRecalculated(a, 2, 2, VarietyBalance.Balanced))
    const forA = bus.replayForNode(a)
    expect(forA).toHaveLength(2)
    expect(forA.every(e => events.eventNodeId(e.payload).equals(a))).toBe(true)
    expect(bus.replayForNode(new NodeId())).toHaveLength(0)
  })
})
