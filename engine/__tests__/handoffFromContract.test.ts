import { describe, it, expect } from 'bun:test'
import { handoffFromContract, formatHandoffForPrompt } from '../memory/handoff.js'
import { ContractState } from '../tools/contract.js'

describe('formatHandoffForPrompt', () => {
  it('includes goal, status, now and next_steps', () => {
    const out = formatHandoffForPrompt({
      goal: 'Implement login',
      now: 'wiring handler',
      status: 'in_progress',
      what_was_done: ['write handler'],
      next_steps: ['add tests', 'commit'],
    })
    expect(out).toContain('## Previous Session Context')
    expect(out).toContain('Implement login')
    expect(out).toContain('in_progress')
    expect(out).toContain('wiring handler')
    expect(out).toContain('add tests')
    expect(out).toContain('commit')
    expect(out).toContain('write handler')
  })

  it('omits sections that are absent', () => {
    const out = formatHandoffForPrompt({ goal: 'G', now: 'N', status: 'complete' })
    expect(out).not.toContain('Next steps')
    expect(out).not.toContain('What failed')
    expect(out).not.toContain('Files modified')
  })
})

describe('handoffFromContract', () => {
  it('maps passed→what_was_done, failed→what_failed, pending→next_steps', () => {
    const c = new ContractState()
    c.create('Implement login', 'add login feature', ['write handler', 'add tests', 'commit'])
    c.assertPass(0, 'handler.ts created')
    c.assertFail(1, 'tests failing')
    // index 2 stays pending

    const h = handoffFromContract(c.snapshot(), { utilization: 0.42 })

    expect(h.goal).toBe('Implement login')
    expect(h.status).toBe('in_progress')
    expect(h.context_at_exit).toBe(0.42)
    expect(h.what_was_done).toContain('write handler — handler.ts created')
    expect(h.what_failed).toContain('add tests — tests failing')
    expect(h.next_steps).toContain('commit')
  })

  it('uses the brief as the "now" line when present', () => {
    const c = new ContractState()
    c.create('Goal', 'currently wiring the broker', ['a'])
    const h = handoffFromContract(c.snapshot(), {})
    expect(h.now).toBe('currently wiring the broker')
  })

  it('sets status complete when every assertion is passed or skipped', () => {
    const c = new ContractState()
    c.create('T', '', ['a', 'b'])
    c.assertPass(0)
    c.assertSkip(1, 'n/a')
    const h = handoffFromContract(c.snapshot(), {})
    expect(h.status).toBe('complete')
  })

  it('passes through model and files_modified when provided', () => {
    const c = new ContractState()
    c.create('T', '', ['a'])
    const h = handoffFromContract(c.snapshot(), {
      model: 'qwen3.6:27b',
      filesModified: ['src/a.ts', 'src/b.ts'],
    })
    expect(h.model).toBe('qwen3.6:27b')
    expect(h.files_modified).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('omits empty assertion arrays rather than emitting empty lists', () => {
    const c = new ContractState()
    c.create('T', '', ['a'])
    c.assertPass(0)
    const h = handoffFromContract(c.snapshot(), {})
    // all passed → no failures, no pending
    expect(h.what_failed).toBeUndefined()
    expect(h.next_steps).toBeUndefined()
    expect(h.what_was_done).toEqual(['a'])
  })
})
