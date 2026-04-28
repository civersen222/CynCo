/**
 * EventBus integration — backbone for all cybernetics domain events.
 *
 * Every VSM module emits domain events through this bus. The bus provides
 * append-only logging, replay for debugging, and drain for audit.
 *
 * Behavioral effect: Event log becomes the audit trail. S3* audit
 * consumes it to spot-check system behavior.
 */

import { events } from '../cybernetics-core/src/index.js'

// Singleton event bus for the entire governance system
let _globalBus: InstanceType<typeof events.EventBus> | null = null

/**
 * Get the global EventBus singleton.
 * Creates one if it doesn't exist.
 */
export function getEventBus(): InstanceType<typeof events.EventBus> {
  if (!_globalBus) {
    _globalBus = new events.EventBus()
  }
  return _globalBus
}

/**
 * Reset the global EventBus (for testing).
 */
export function resetEventBus(): void {
  _globalBus = new events.EventBus()
}

/**
 * Get recent events as a summary string for governance.status emission.
 * Returns last N events formatted for TUI display.
 */
export function getEventSummary(maxEvents: number = 10): string[] {
  const bus = getEventBus()
  const all = bus.replay()
  const recent = all.slice(-maxEvents)
  return recent.map(e => {
    const kind = e.payload.kind
    const ts = e.timestamp.toMillis ? e.timestamp.toMillis() : Date.now()
    return `[${e.seq}] ${kind}`
  })
}

// Re-export DomainEvent for convenience
export { events }
export type DomainEvent = InstanceType<typeof events.DomainEvent>
