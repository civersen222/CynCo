import { describe, expect, it, beforeEach } from 'bun:test'
import { ConversationTheoryIntegration } from '../../vsm/conversationTheory.js'

describe('ConversationTheoryIntegration', () => {
  let ct: ConversationTheoryIntegration

  beforeEach(() => {
    ct = new ConversationTheoryIntegration()
  })

  it('records confirmed exchanges as verified', () => {
    ct.recordExchange('test-topic', 'I will edit the file', 'ok got it')
    expect(ct.getAgreementRatio()).toBe(1.0)
  })

  it('records confused exchanges as divergent', () => {
    ct.recordExchange('test-topic', 'I will refactor the database', 'what? no that is wrong')
    expect(ct.getDivergentCount()).toBe(1)
    expect(ct.getAgreementRatio()).toBe(0.0)
  })

  it('tracks agreement depth', () => {
    ct.recordExchange('topic-a', 'explanation', 'yes perfect')
    ct.recordExchange('topic-b', 'explanation', 'ok thanks')
    expect(ct.getAgreementDepth()).toBeGreaterThan(0)
  })

  it('entailment mesh tracks prerequisites', () => {
    ct.addPrerequisite('testing', 'implementation')
    ct.addPrerequisite('implementation', 'design')
    const unmet = ct.checkPrerequisites('testing', new Set(['design']))
    expect(unmet).toContain('implementation')
    expect(unmet).not.toContain('design')
  })

  it('prerequisites all met returns empty', () => {
    ct.addPrerequisite('testing', 'implementation')
    const unmet = ct.checkPrerequisites('testing', new Set(['implementation']))
    expect(unmet).toHaveLength(0)
  })

  it('mixed exchanges produce partial agreement', () => {
    ct.recordExchange('a', 'explanation', 'yes got it')
    ct.recordExchange('b', 'explanation', 'huh what do you mean')
    expect(ct.getAgreementRatio()).toBe(0.5)
  })
})
