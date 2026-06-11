// engine/__tests__/daemon/scheduler.test.ts
import { describe, expect, it } from 'bun:test'
import { computeNextFire, evaluateTrigger } from '../../daemon/scheduler.js'
import type { TriggerSpec } from '../../daemon/types.js'

const interval = (mins: number): TriggerSpec => ({
  id: 'i', kind: 'interval', everyMinutes: mins, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})
const daily = (at: string): TriggerSpec => ({
  id: 'd', kind: 'daily', at, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})
const weekly = (day: TriggerSpec['day'], at: string): TriggerSpec => ({
  id: 'w', kind: 'weekly', day, at, precheck: 'none', missedPolicy: 'skip', prompt: 'p',
})

describe('computeNextFire', () => {
  it('interval: from + everyMinutes', () => {
    const from = new Date(2026, 5, 11, 12, 0, 0) // Jun 11 2026 12:00 local
    expect(computeNextFire(interval(90), from).getTime()).toBe(from.getTime() + 90 * 60000)
  })

  it('daily: later today if at is still ahead', () => {
    const from = new Date(2026, 5, 11, 6, 0, 0)
    const next = computeNextFire(daily('08:00'), from)
    expect(next.getDate()).toBe(11)
    expect(next.getHours()).toBe(8)
  })

  it('daily: tomorrow if at already passed', () => {
    const from = new Date(2026, 5, 11, 9, 0, 0)
    const next = computeNextFire(daily('08:00'), from)
    expect(next.getDate()).toBe(12)
    expect(next.getHours()).toBe(8)
  })

  it('weekly: next occurrence of day+at', () => {
    // Jun 11 2026 is a Thursday
    const from = new Date(2026, 5, 11, 12, 0, 0)
    const next = computeNextFire(weekly('tue', '03:00'), from)
    expect(next.getDay()).toBe(2) // Tuesday
    expect(next.getHours()).toBe(3)
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000)
  })

  it('weekly: same day fires today when at is ahead', () => {
    const from = new Date(2026, 5, 11, 1, 0, 0) // Thursday 01:00
    const next = computeNextFire(weekly('thu', '08:00'), from)
    expect(next.getDate()).toBe(11)
  })
})

describe('evaluateTrigger', () => {
  const t = interval(60)
  const now = new Date(2026, 5, 11, 12, 0, 0)

  it('wait when nextFire is in the future', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() + 60000).toISOString(), now)
    expect(r.action).toBe('wait')
  })

  it('fire when nextFire just passed (within grace)', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() - 30000).toISOString(), now)
    expect(r.action).toBe('fire')
    if (r.action === 'fire') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })

  it('missed long ago + skip policy → skip and reschedule', () => {
    const r = evaluateTrigger(t, new Date(now.getTime() - 3 * 3600 * 1000).toISOString(), now)
    expect(r.action).toBe('skip')
    if (r.action === 'skip') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })

  it('missed long ago + run-once-on-startup policy → fire', () => {
    const t2: TriggerSpec = { ...t, missedPolicy: 'run-once-on-startup' }
    const r = evaluateTrigger(t2, new Date(now.getTime() - 3 * 3600 * 1000).toISOString(), now)
    expect(r.action).toBe('fire')
  })

  it('no persisted nextFire → initialize (wait with next set)', () => {
    const r = evaluateTrigger(t, undefined, now)
    expect(r.action).toBe('init')
    if (r.action === 'init') expect(r.next.getTime()).toBe(now.getTime() + 60 * 60000)
  })
})
