import { describe, expect, it, beforeEach } from 'bun:test'
import { TestDrivenGovernor } from '../../vsm/testDrivenGov.js'

describe('TestDrivenGovernor', () => {
  let gov: TestDrivenGovernor
  beforeEach(() => { gov = new TestDrivenGovernor() })

  it('does not force tests when under threshold', () => {
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    expect(gov.shouldForceTests()).toBe(false)
  })

  it('forces tests after 3 consecutive edits', () => {
    gov.recordToolCall('Edit')
    gov.recordToolCall('Write')
    gov.recordToolCall('Edit')
    expect(gov.shouldForceTests()).toBe(true)
  })

  it('resets counter after Bash call', () => {
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    gov.recordToolCall('Bash')
    expect(gov.shouldForceTests()).toBe(false)
  })

  it('returns tools to remove when forcing', () => {
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    const blocked = gov.getBlockedTools()
    expect(blocked).toContain('Edit')
    expect(blocked).toContain('Write')
    expect(blocked).not.toContain('Bash')
  })

  it('tracks Read calls without counting as edits', () => {
    gov.recordToolCall('Read')
    gov.recordToolCall('Read')
    gov.recordToolCall('Read')
    expect(gov.shouldForceTests()).toBe(false)
  })

  it('generates test directive message', () => {
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    gov.recordToolCall('Edit')
    const msg = gov.getTestDirective()
    expect(msg).toContain('test')
  })
})
