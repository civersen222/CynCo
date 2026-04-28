import { describe, expect, it, beforeEach } from 'bun:test'
import { getEventBus, resetEventBus, getEventSummary } from '../../vsm/eventBus.js'
import { events, NodeId } from '../../cybernetics-core/src/index.js'

describe('EventBus integration', () => {
  beforeEach(() => {
    resetEventBus()
  })

  it('getEventBus returns a singleton', () => {
    const bus1 = getEventBus()
    const bus2 = getEventBus()
    expect(bus1).toBe(bus2)
  })

  it('resetEventBus creates a new empty bus', () => {
    const bus1 = getEventBus()
    bus1.emit(events.DomainEvent.nodeHalted(new NodeId(), 'test'))
    expect(bus1.len()).toBe(1)

    resetEventBus()
    const bus2 = getEventBus()
    expect(bus2.len()).toBe(0)
    expect(bus2).not.toBe(bus1)
  })

  it('emits and replays domain events', () => {
    const bus = getEventBus()
    const nodeId = new NodeId()
    bus.emit(events.DomainEvent.nodeHalted(nodeId, 'test halt'))
    bus.emit(events.DomainEvent.nodeResumed(nodeId, 'test resume'))

    const all = bus.replay()
    expect(all).toHaveLength(2)
    expect(all[0].payload.kind).toBe('NodeHalted')
    expect(all[1].payload.kind).toBe('NodeResumed')
  })

  it('drain empties the bus and returns events', () => {
    const bus = getEventBus()
    bus.emit(events.DomainEvent.nodeHalted(new NodeId(), 'drain test'))
    expect(bus.len()).toBe(1)

    const drained = bus.drain()
    expect(drained).toHaveLength(1)
    expect(bus.len()).toBe(0)
  })

  it('getEventSummary returns formatted recent events', () => {
    const bus = getEventBus()
    const nodeId = new NodeId()
    bus.emit(events.DomainEvent.nodeHalted(nodeId, 'test'))
    bus.emit(events.DomainEvent.killSwitchActivated(nodeId, 'critical'))

    const summary = getEventSummary(5)
    expect(summary).toHaveLength(2)
    expect(summary[0]).toContain('NodeHalted')
    expect(summary[1]).toContain('KillSwitchActivated')
  })

  it('getEventSummary limits to maxEvents', () => {
    const bus = getEventBus()
    const nodeId = new NodeId()
    for (let i = 0; i < 20; i++) {
      bus.emit(events.DomainEvent.nodeHalted(nodeId, `event ${i}`))
    }

    const summary = getEventSummary(5)
    expect(summary).toHaveLength(5)
  })
})
