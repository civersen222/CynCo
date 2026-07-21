import { describe, it, expect, vi } from 'vitest'
import { ActivationsConsumer, decodeB64Floats } from '../../brain/activationsConsumer.js'

const entry = (cursor: number, layer: number, pos: number) => ({
  cursor, layer, pos, token: 42,
  values_b64: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer).toString('base64'),
})

describe('ActivationsConsumer', () => {
  it('decodeB64Floats roundtrips fp32', () => {
    const f = decodeB64Floats(Buffer.from(new Float32Array([1.5, -2]).buffer).toString('base64'))
    expect(Array.from(f)).toEqual([1.5, -2])
  })

  it('polls, filters to selected layer, batches every Nth position, broadcasts workspace', async () => {
    const fetched = { cursor: 3, n_embd: 4, entries: [entry(1, 40, 10), entry(2, 40, 11), entry(3, 24, 10)] }
    const fetchFn = (async () => new Response(JSON.stringify(fetched), { status: 200 })) as any
    const readout = vi.fn(async () => [{ token: 'Paris', p: 0.4 }])
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x', fetchFn,
      jlens: { readout, health: async () => ({ ok: true, layers: [24, 40] }) } as any,
      broadcast, layer: 40, stride: 1,
    })
    await c.pollOnce()
    expect(readout).toHaveBeenCalledTimes(2)                       // layer-40 entries only
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'brain.workspace', layer: 40, pos: 10,
      top: [{ token: 'Paris', p: 0.4 }],
    }))
    expect(c.cursor).toBe(3)                                       // advances even past skipped layers
  })

  it('tap down -> pollOnce returns false, no throw, no broadcast', async () => {
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => { throw new Error('refused') }) as any,
      jlens: { readout: vi.fn(), health: async () => null } as any,
      broadcast: vi.fn(), layer: 40, stride: 1,
    })
    expect(await c.pollOnce()).toBe(false)
  })

  it('readout null (sidecar down) -> still advances cursor, no broadcast', async () => {
    const fetched = { cursor: 1, n_embd: 4, entries: [entry(1, 40, 10)] }
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(fetched), { status: 200 })) as any,
      jlens: { readout: async () => null, health: async () => ({ ok: true, layers: [40] }) } as any,
      broadcast, layer: 40, stride: 1,
    })
    await c.pollOnce()
    expect(broadcast).not.toHaveBeenCalled()
    expect(c.cursor).toBe(1)
  })
})
