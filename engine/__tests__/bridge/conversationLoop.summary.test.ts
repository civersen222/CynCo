import { describe, expect, it } from 'bun:test'
import { shouldInjectSummary, buildSummaryInjectionMessage } from '../../bridge/summaryInjection.js'

/**
 * Integration-style tests that exercise the decision logic and message-building
 * helpers in the exact sequence they're called from runModelLoop().
 *
 * Full loop execution against a live provider is covered by existing
 * integration.test.ts; here we verify the injection contract stays consistent.
 */

describe('summary injection contract', () => {
  it('tools-used accumulator survives multiple iterations', () => {
    const toolsUsedInSession: string[] = []
    toolsUsedInSession.push('Edit')
    toolsUsedInSession.push('Bash', 'Bash')
    expect(shouldInjectSummary('', 'end_turn', toolsUsedInSession, false)).toBe(true)
  })

  it('message format consumable as Message type', () => {
    const msg = buildSummaryInjectionMessage(['Edit', 'Read'])
    expect(msg.role).toBe('user')
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0].type).toBe('text')
  })

  it('end-to-end: first exit triggers, second exit does not', () => {
    const toolsUsedInSession = ['Edit']
    let alreadyInjected = false
    expect(shouldInjectSummary('', 'end_turn', toolsUsedInSession, alreadyInjected)).toBe(true)
    alreadyInjected = true
    expect(shouldInjectSummary('', 'end_turn', toolsUsedInSession, alreadyInjected)).toBe(false)
  })
})
