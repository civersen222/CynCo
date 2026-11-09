import { describe, expect, it } from 'bun:test'
import { WakePublisher, collectNextFires } from '../../daemon/wakeSchedule.js'

const NOW = new Date('2026-11-08T20:00:00Z')
const L = (nextFire: Record<string, string>) => ({ state: { nextFire } })

describe('collectNextFires', () => {
  it('merges every mission, drops past times, sorts and de-duplicates', () => {
    const times = collectNextFires([
      L({ a: '2026-11-08T21:00:00.000Z', b: '2026-11-08T19:00:00.000Z' }),
      L({ c: '2026-11-08T20:30:00.000Z', d: '2026-11-08T21:00:00.000Z' }),
    ], NOW)
    expect(times).toEqual(['2026-11-08T20:30:00.000Z', '2026-11-08T21:00:00.000Z'])
  })
  it('ignores unparsable entries', () => {
    expect(collectNextFires([L({ a: 'garbage', b: '2026-11-08T22:00:00.000Z' })], NOW)).toEqual(['2026-11-08T22:00:00.000Z'])
  })
})

describe('WakePublisher', () => {
  function make(url: string | undefined, fetchImpl: typeof fetch) {
    const logs: string[] = []
    const p = new WakePublisher({ url, target: 'main', fetchImpl, log: (s) => logs.push(s), now: () => NOW })
    return { p, logs }
  }
  const ledgers = [L({ a: '2026-11-08T21:00:00.000Z' })]

  it('skips when no doorman URL is configured', async () => {
    let fetched = 0
    const { p } = make(undefined, (async () => { fetched++; return new Response('{}') }) as any)
    expect(await p.publishIfChanged(ledgers)).toBe('skipped')
    expect(fetched).toBe(0)
  })

  it('posts the full list once, then reports unchanged, then posts again when it changes', async () => {
    const bodies: any[] = []
    const { p } = make('http://100.110.117.10:9170', (async (url: string, init: any) => { bodies.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }) }) as any)
    expect(await p.publishIfChanged(ledgers)).toBe('sent')
    expect(bodies[0]).toEqual({ url: 'http://100.110.117.10:9170/schedule', body: { target: 'main', times: ['2026-11-08T21:00:00.000Z'] } })
    expect(await p.publishIfChanged(ledgers)).toBe('unchanged')
    expect(bodies.length).toBe(1)
    expect(await p.publishIfChanged([L({ a: '2026-11-08T22:00:00.000Z' })])).toBe('sent')
    expect(bodies.length).toBe(2)
  })

  it('a failed send is retried on the next call with the same list, and never throws', async () => {
    let fail = true
    let calls = 0
    const { p, logs } = make('http://doorman:9170', (async () => { calls++; if (fail) throw new Error('ECONNREFUSED'); return new Response('{"ok":true}') }) as any)
    expect(await p.publishIfChanged(ledgers)).toBe('failed')
    expect(logs.some(l => l.includes('ECONNREFUSED'))).toBe(true)
    fail = false
    expect(await p.publishIfChanged(ledgers)).toBe('sent')
    expect(calls).toBe(2)
  })

  it('a non-2xx reply counts as failed', async () => {
    const { p } = make('http://doorman:9170', (async () => new Response('{"error":"no such target"}', { status: 404 })) as any)
    expect(await p.publishIfChanged(ledgers)).toBe('failed')
  })
})

describe('collectNextFires allowedIds', () => {
  it('publishes only the allowed trigger ids (disabled and stale ids are left out)', () => {
    const ledger = L({ poll: '2026-11-08T21:00:00.000Z', news: '2026-11-08T22:00:00.000Z', 'june-old': '2026-11-09T09:00:00.000Z' })
    expect(collectNextFires([ledger], NOW, new Set(['poll']))).toEqual(['2026-11-08T21:00:00.000Z'])
    expect(collectNextFires([ledger], NOW)).toHaveLength(3)
  })
})
