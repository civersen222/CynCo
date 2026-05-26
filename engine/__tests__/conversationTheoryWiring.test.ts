import { describe, it, expect } from 'vitest'
import { ConversationTheoryIntegration } from '../vsm/conversationTheory.js'

describe('conversation theory wiring', () => {
  it('confirmed exchanges increase agreement', () => {
    const ct = new ConversationTheoryIntegration()
    ct.recordExchange('topic1', 'I will edit the file', 'yes perfect')
    ct.recordExchange('topic2', 'Adding tests now', 'ok got it')
    expect(ct.getAgreementRatio()).toBeGreaterThan(0.5)
  })

  it('confused exchanges decrease agreement', () => {
    const ct = new ConversationTheoryIntegration()
    ct.recordExchange('topic1', 'I will refactor', 'what? no that is wrong')
    ct.recordExchange('topic2', 'Deleting the file', 'huh? do not understand')
    expect(ct.getAgreementRatio()).toBeLessThanOrEqual(0.5)
  })
})
