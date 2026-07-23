import { describe, expect, it } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

describe('CyberneticsGovernance.setSessionId', () => {
  it('overrides the auto-generated session id used for outcome persistence', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('session-canonical-123')
    expect(gov.getSessionId()).toBe('session-canonical-123')
  })

  it('is idempotent and takes the last value', () => {
    const gov = new CyberneticsGovernance()
    gov.setSessionId('a')
    gov.setSessionId('b')
    expect(gov.getSessionId()).toBe('b')
  })
})
