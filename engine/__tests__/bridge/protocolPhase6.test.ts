import { describe, expect, it } from 'bun:test'
import { serializeEvent, PROTOCOL_VERSION } from '../../bridge/protocol.js'
import type { FileDiffEvent, SessionReadyEvent } from '../../bridge/protocol.js'

describe('Phase 6 protocol additions', () => {
  it('exports a numeric PROTOCOL_VERSION', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number')
  })
  it('serializes a file.diff event with structured hunks', () => {
    const ev: FileDiffEvent = {
      type: 'file.diff', path: 'a.ts', changeType: 'modify',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
                lines: [{ kind: 'context', text: 'x' }, { kind: 'add', text: 'y' }] }],
    }
    const json = JSON.parse(serializeEvent(ev))
    expect(json.hunks[0].lines[1].kind).toBe('add')
  })
  it('session.ready carries protocolVersion', () => {
    const ev: SessionReadyEvent = { type: 'session.ready', model: 'm', contextLength: 1, protocolVersion: PROTOCOL_VERSION }
    expect(ev.protocolVersion).toBe(PROTOCOL_VERSION)
  })
})
