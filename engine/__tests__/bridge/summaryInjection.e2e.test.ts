import { describe, expect, it } from 'bun:test'
import {
  shouldInjectSummary,
  buildSummaryInjectionMessage,
} from '../../bridge/summaryInjection.js'
import type { SummaryInjectedEvent, EngineEvent } from '../../bridge/protocol.js'

describe('Phase A integration', () => {
  it('summary.injected event type is in the EngineEvent union', () => {
    const evt: SummaryInjectedEvent = { type: 'summary.injected', toolsUsed: ['Edit'] }
    const asUnion: EngineEvent = evt
    expect(asUnion.type).toBe('summary.injected')
  })

  it('full flow: detect → build message → construct event', () => {
    const toolsUsed = ['Edit', 'Bash']
    const shouldInject = shouldInjectSummary('', 'end_turn', toolsUsed, false)
    expect(shouldInject).toBe(true)

    const message = buildSummaryInjectionMessage(toolsUsed)
    expect(message.role).toBe('user')

    const event: SummaryInjectedEvent = {
      type: 'summary.injected',
      toolsUsed: Array.from(new Set(toolsUsed)),
    }
    expect(event.toolsUsed).toEqual(['Edit', 'Bash'])
  })

  it('re-entry is blocked after first injection', () => {
    const toolsUsed = ['Edit']
    expect(shouldInjectSummary('', 'end_turn', toolsUsed, false)).toBe(true)
    expect(shouldInjectSummary('', 'end_turn', toolsUsed, true)).toBe(false)
  })
})
