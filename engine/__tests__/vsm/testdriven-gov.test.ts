/**
 * C4 wiring tests — shouldNudgeTests gates the TDD-governance nudge.
 *
 * Soft + opt-in contract: nudge only when the flag is on, no formal workflow
 * is active, and the governor would force tests. Never a hard block.
 */

import { describe, expect, it } from 'vitest'
import { TestDrivenGovernor, shouldNudgeTests } from '../../vsm/testDrivenGov.js'

const editedThrice = () => {
  const gov = new TestDrivenGovernor()
  gov.recordToolCall('Edit')
  gov.recordToolCall('Write')
  gov.recordToolCall('Edit')
  return gov
}

describe('shouldNudgeTests', () => {
  it('nudges when flag on, no workflow, and edits exceed threshold', () => {
    expect(shouldNudgeTests(editedThrice(), { flagOn: true, workflowActive: false })).toBe(true)
  })

  it('does not nudge when the flag is off (default)', () => {
    expect(shouldNudgeTests(editedThrice(), { flagOn: false, workflowActive: false })).toBe(false)
  })

  it('does not nudge when a workflow is active (workflow owns test phases)', () => {
    expect(shouldNudgeTests(editedThrice(), { flagOn: true, workflowActive: true })).toBe(false)
  })

  it('does not nudge below the edit threshold', () => {
    const gov = new TestDrivenGovernor()
    gov.recordToolCall('Edit')
    expect(shouldNudgeTests(gov, { flagOn: true, workflowActive: false })).toBe(false)
  })

  it('stops nudging after a Bash (test) run resets the streak', () => {
    const gov = editedThrice()
    gov.recordToolCall('Bash')
    expect(shouldNudgeTests(gov, { flagOn: true, workflowActive: false })).toBe(false)
  })
})
