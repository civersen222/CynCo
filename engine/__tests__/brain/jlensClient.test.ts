import { describe, it, expect } from 'vitest'
import { JlensClient } from '../../brain/jlensClient.js'

const okFetch = (payload: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(payload), { status: 200 })) as any

describe('JlensClient', () => {
  it('health true when sidecar responds ok', async () => {
    const c = new JlensClient('http://x', okFetch({ ok: true, layers: [24, 32] }))
    expect(await c.health()).toEqual({ ok: true, layers: [24, 32] })
  })
  it('health null on network failure (degradation, no throw)', async () => {
    const c = new JlensClient('http://x', (async () => { throw new Error('down') }) as any)
    expect(await c.health()).toBeNull()
  })
  it('readout returns top list', async () => {
    const c = new JlensClient('http://x', okFetch({ top: [{ token: 'Paris', p: 0.4 }] }))
    expect(await c.readout(40, new Float32Array(4))).toEqual([{ token: 'Paris', p: 0.4 }])
  })
  it('readout null on HTTP error', async () => {
    const c = new JlensClient('http://x', (async () => new Response('bad', { status: 400 })) as any)
    expect(await c.readout(40, new Float32Array(4))).toBeNull()
  })
})
