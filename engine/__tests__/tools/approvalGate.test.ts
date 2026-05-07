import { describe, expect, it } from 'bun:test'
import { shouldAutoApprove } from '../../tools/approvalGate.js'

describe('approvalGate', () => {
  it('auto-approves read-tier tools with no profile override', () => {
    expect(shouldAutoApprove('Read', undefined)).toBe(true)
    expect(shouldAutoApprove('Glob', undefined)).toBe(true)
    expect(shouldAutoApprove('Grep', undefined)).toBe(true)
    expect(shouldAutoApprove('WebFetch', undefined)).toBe(true)
    expect(shouldAutoApprove('ImageView', undefined)).toBe(true)
    expect(shouldAutoApprove('SubAgent', undefined)).toBe(true)
  })

  it('requires approval for write-tier tools with no profile override', () => {
    expect(shouldAutoApprove('Write', undefined)).toBe(false)
    expect(shouldAutoApprove('Edit', undefined)).toBe(false)
    expect(shouldAutoApprove('Bash', undefined)).toBe(false)
    expect(shouldAutoApprove('Git', undefined)).toBe(false)
  })

  it('respects profile trust overrides', () => {
    const trust = { Bash: 'auto' as const, Write: 'auto' as const }
    expect(shouldAutoApprove('Bash', { trust })).toBe(true)
    expect(shouldAutoApprove('Write', { trust })).toBe(true)
    expect(shouldAutoApprove('Edit', { trust })).toBe(false)
  })

  it('respects deny list', () => {
    const profile = { deny: ['WebFetch'] }
    expect(shouldAutoApprove('WebFetch', profile)).toBe(false)
  })

  it('approve-all mode auto-approves everything', () => {
    expect(shouldAutoApprove('Bash', undefined, true)).toBe(true)
    expect(shouldAutoApprove('Edit', undefined, true)).toBe(true)
  })
})
