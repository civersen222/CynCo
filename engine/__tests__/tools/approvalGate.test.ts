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

  it('an override that is not "auto" withholds approval from a tool that would have had it', () => {
    // `Edit` above is absent from the map, so it reaches the tier check and
    // proves nothing about the override. This is the case that does: a tool
    // whose own tier is `auto`, named in the profile at a tier that is not.
    const trust = { Read: 'approval' as const, Grep: 'always' as const }
    expect(shouldAutoApprove('Read', { trust })).toBe(false)
    expect(shouldAutoApprove('Grep', { trust })).toBe(false)
  })

  it('a tool that does not exist is never auto-approved', () => {
    // Models name tools that were never registered. Whatever is done with such
    // a call, it must not be done unattended.
    expect(shouldAutoApprove('Read_file', undefined)).toBe(false)
    expect(shouldAutoApprove('', undefined)).toBe(false)
    expect(shouldAutoApprove('DeleteEverything', { trust: { Read: 'auto' } })).toBe(false)
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
