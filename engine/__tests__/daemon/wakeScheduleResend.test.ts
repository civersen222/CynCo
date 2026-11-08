import { describe, expect, it } from 'bun:test'
import { WakePublisher } from '../../daemon/wakeSchedule.js'

describe('WakePublisher periodic resend (review #7)', () => {
  it('re-sends an unchanged list after resendEveryMs so a restarted doorman learns it again', async () => {
    let t = Date.parse('2026-11-08T20:00:00Z')
    let sends = 0
    const p = new WakePublisher({ url: 'http://doorman:9170', target: 'main', fetchImpl: (async () => { sends++; return new Response('{"ok":true}') }) as any, now: () => new Date(t), resendEveryMs: 600_000 })
    const ledgers = [{ state: { nextFire: { a: '2026-11-08T23:00:00.000Z' } } }]
    expect(await p.publishIfChanged(ledgers)).toBe('sent')
    t += 300_000
    expect(await p.publishIfChanged(ledgers)).toBe('unchanged')
    t += 301_000
    expect(await p.publishIfChanged(ledgers)).toBe('sent')
    expect(sends).toBe(2)
  })
})
