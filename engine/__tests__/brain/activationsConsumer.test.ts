import { describe, it, expect, vi } from 'vitest'
import { ActivationsConsumer, decodeB64Floats, MAX_POSITIONS_PER_POLL } from '../../brain/activationsConsumer.js'

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

  it('start() broadcasts brain.tier with layers from jlens health', async () => {
    const fetched = { cursor: 0, n_embd: 4, entries: [] }
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(fetched), { status: 200 })) as any,
      jlens: { readout: vi.fn(), health: async () => ({ ok: true, layers: [24, 40, 56] }) } as any,
      broadcast, layer: 40, stride: 1,
    })
    const tier = await c.start()
    c.stop()
    expect(tier).toBe('live')
    expect(broadcast).toHaveBeenCalledWith({
      type: 'brain.tier', tier: 'live', tap: true, lens: true, tapConfigured: true,
      layers: [24, 40, 56], layer: 40,
    })
  })

  it('start() reports entropy-only when tapConfigured=false even if the route responds (patched binary, taps disabled)', async () => {
    // Without LLAMA_ACTIVATIONS_LAYERS the patched server still serves
    // /activations (empty forever) — a 200 must NOT count as tap up.
    const fetched = { cursor: 0, n_embd: 0, entries: [] }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fetched), { status: 200 })) as any
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x', fetchFn, tapConfigured: false,
      jlens: { readout: vi.fn(), health: async () => ({ ok: true, layers: [24, 40] }) } as any,
      broadcast, layer: 40, stride: 1,
    })
    const tier = await c.start()
    c.stop()
    expect(tier).toBe('entropy-only')
    expect(fetchFn).not.toHaveBeenCalled()   // no probe, no polling loop
    expect(broadcast).toHaveBeenCalledWith({
      type: 'brain.tier', tier: 'entropy-only', tap: false, lens: true, tapConfigured: false,
      layers: [24, 40], layer: 40,
    })
  })

  it('start() reports entropy-only with empty layers when both deps down', async () => {
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => { throw new Error('refused') }) as any,
      jlens: { readout: vi.fn(), health: async () => null } as any,
      broadcast, layer: 40, stride: 1,
    })
    const tier = await c.start()
    c.stop()
    expect(tier).toBe('entropy-only')
    expect(broadcast).toHaveBeenCalledWith({
      type: 'brain.tier', tier: 'entropy-only', tap: false, lens: false, tapConfigured: true,
      layers: [], layer: 40,
    })
  })

  it('promotes record-only -> live when the jlens sidecar comes up later', async () => {
    // The tier used to be latched at start(), so a sidecar started after the
    // engine never registered and the badge lied until the next restart.
    const fetched = { cursor: 0, n_embd: 4, entries: [] }
    const broadcast = vi.fn()
    let lensUp = false
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(fetched), { status: 200 })) as any,
      jlens: {
        readout: vi.fn(),
        health: async () => (lensUp ? { ok: true, layers: [24, 40] } : null),
      } as any,
      broadcast, layer: 40, stride: 1, reprobeMs: 5,
    })
    expect(await c.start()).toBe('record-only')

    lensUp = true
    await vi.waitFor(() => {
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'brain.tier', tier: 'live', lens: true, layers: [24, 40],
      }))
    }, { timeout: 1000 })
    c.stop()
  })

  it('announces the tier once, not on every re-probe', async () => {
    const fetched = { cursor: 0, n_embd: 4, entries: [] }
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(fetched), { status: 200 })) as any,
      jlens: { readout: vi.fn(), health: async () => ({ ok: true, layers: [40] }) } as any,
      broadcast, layer: 40, stride: 1, reprobeMs: 5,
    })
    await c.start()
    await new Promise(r => setTimeout(r, 60))       // ~12 re-probes
    c.stop()
    const tiers = broadcast.mock.calls.filter(([m]: any[]) => m.type === 'brain.tier')
    expect(tiers).toHaveLength(1)
  })
})

/**
 * Layer convergence (Phase 2, 2a-ii): the tap serves every probed layer, so a
 * position that arrives complete can be read out across all five and scored for
 * how early in depth the answer settled. Data only — nothing branches on it.
 *
 * The fake tap encodes the token the fake readout will report in h[0], so a
 * test can dictate per-(pos, layer) agreement without a tokenizer.
 */
const LAYERS = [24, 32, 40, 48, 56]

const coded = (cursor: number, layer: number, pos: number, code: number) => ({
  cursor, layer, pos, token: 42,
  values_b64: Buffer.from(new Float32Array([code, 0, 0, 0]).buffer).toString('base64'),
})

/** pos 0 agrees with layer 56 on 3 of its 4 shallower layers; pos 4 on none. */
function twoPositions(layers = LAYERS) {
  const codes: Record<number, Record<number, number>> = {
    0: { 24: 1, 32: 1, 40: 1, 48: 2, 56: 1 },
    4: { 24: 2, 32: 2, 40: 2, 48: 2, 56: 1 },
  }
  const entries: ReturnType<typeof coded>[] = []
  let cursor = 0
  for (const pos of [0, 4]) for (const l of layers) entries.push(coded(++cursor, l, pos, codes[pos][l]))
  return { cursor, n_embd: 4, entries }
}

const codedLens = () => ({
  readout: vi.fn(async (_layer: number, h: Float32Array) => [{ token: `t${h[0]}`, p: 0.9 }]),
  health: async () => ({ ok: true, layers: LAYERS }),
})

/** A consumer promoted to `live` by start(), with its timers already cleared. */
async function liveConsumer(jlens: any, broadcast: any, box: { batch: any }) {
  const c = new ActivationsConsumer({
    activationsUrl: 'http://x',
    fetchFn: (async () => new Response(JSON.stringify(box.batch), { status: 200 })) as any,
    jlens, broadcast, layer: 40, stride: 4,
  })
  expect(await c.start()).toBe('live')
  c.stop()
  return c
}

describe('ActivationsConsumer layer convergence', () => {
  it('reads out all five probed layers per complete position and accumulates convergence while live', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const lens = codedLens()
    const broadcast = vi.fn()
    const c = await liveConsumer(lens, broadcast, box)
    expect(c.tier()).toBe('live')

    box.batch = twoPositions()
    await c.pollOnce()

    expect(c.convergence()).toEqual({
      n: 2, meanAgree: 0.375, meanDepth: 40,
      byLayer: { '24': 0.5, '32': 0.5, '40': 0.5, '48': 0 },
    })
    // Five layers x two positions, and the selected layer is not read twice.
    expect(lens.readout).toHaveBeenCalledTimes(10)
    // The single-layer workspace broadcast is unchanged: one per selected-layer position.
    const ws = broadcast.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.type === 'brain.workspace')
    expect(ws).toHaveLength(2)
    expect(ws[0]).toMatchObject({ layer: 40, pos: 0, token: 42, top: [{ token: 't1', p: 0.9 }] })
    expect(ws[1]).toMatchObject({ layer: 40, pos: 4, top: [{ token: 't2', p: 0.9 }] })
  })

  it('skips a position that is missing a probed layer, and still broadcasts its workspace', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const lens = codedLens()
    const broadcast = vi.fn()
    const c = await liveConsumer(lens, broadcast, box)

    box.batch = twoPositions([24, 32, 40, 48])   // layer 56 never arrives
    await c.pollOnce()

    expect(c.convergence().n).toBe(0)
    expect(c.convergence().meanAgree).toBeNull()
    const ws = broadcast.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.type === 'brain.workspace')
    expect(ws).toHaveLength(2)
  })

  it('skips a position whose readout comes back null for one layer', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const lens = {
      readout: vi.fn(async (layer: number, h: Float32Array) => (layer === 32 ? null : [{ token: `t${h[0]}`, p: 0.9 }])),
      health: async () => ({ ok: true, layers: LAYERS }),
    }
    const c = await liveConsumer(lens, vi.fn(), box)

    box.batch = twoPositions()
    await c.pollOnce()

    expect(c.convergence().n).toBe(0)
  })

  it('does not accumulate below the live tier', async () => {
    // Never started: the tier is the constructed default, entropy-only.
    const lens = codedLens()
    const broadcast = vi.fn()
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(twoPositions()), { status: 200 })) as any,
      jlens: lens as any, broadcast, layer: 40, stride: 4,
    })
    expect(c.tier()).toBe('entropy-only')
    await c.pollOnce()
    expect(c.convergence().n).toBe(0)
    const ws = broadcast.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.type === 'brain.workspace')
    expect(ws).toHaveLength(2)
  })

  it('resetConvergence empties the window', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const c = await liveConsumer(codedLens(), vi.fn(), box)
    box.batch = twoPositions()
    await c.pollOnce()
    expect(c.convergence().n).toBe(2)

    c.resetConvergence()
    expect(c.convergence()).toEqual({
      n: 0, meanAgree: null, meanDepth: null,
      byLayer: { '24': null, '32': null, '40': null, '48': null },
    })
  })

  it('honours a stride: positions off the stride are neither read out nor accumulated', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const lens = codedLens()
    const c = await liveConsumer(lens, vi.fn(), box)
    const batch = twoPositions()
    // pos 4 -> pos 5, off a stride of 4.
    box.batch = { ...batch, entries: batch.entries.map(e => (e.pos === 4 ? { ...e, pos: 5 } : e)) }
    await c.pollOnce()
    expect(c.convergence().n).toBe(1)
    expect(lens.readout).toHaveBeenCalledTimes(5)
  })
})

describe('ActivationsConsumer readout budget', () => {
  it('does not fan out across five layers below the live tier', async () => {
    // record-only is the startup tier of every brain session, until the sidecar
    // has loaded its artifacts. Five readouts per position there are five calls
    // that could never be scored — each waiting out its own timeout.
    const lens = {
      readout: vi.fn(async (_layer: number, h: Float32Array) => [{ token: `t${h[0]}`, p: 0.9 }]),
      health: vi.fn(async () => null as { ok: boolean; layers: number[] } | null),
    }
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const c = new ActivationsConsumer({
      activationsUrl: 'http://x',
      fetchFn: (async () => new Response(JSON.stringify(box.batch), { status: 200 })) as any,
      jlens: lens as any, broadcast: vi.fn(), layer: 40, stride: 4,
    })
    expect(await c.start()).toBe('record-only')
    c.stop()

    box.batch = twoPositions()          // complete: every probed layer present
    lens.readout.mockClear()
    await c.pollOnce()

    expect(lens.readout).toHaveBeenCalledTimes(2)     // one per selected-layer position, not ten
    expect(lens.readout.mock.calls.every(([l]: any[]) => l === 40)).toBe(true)
    expect(c.convergence().n).toBe(0)
  })

  it('warns once when the lens does not carry every probed layer', async () => {
    // Three independent sources set the layer list; a disagreement leaves
    // layerConvergence null all session, and the re-probe timer would repeat
    // the warning every 10s.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const c = new ActivationsConsumer({
        activationsUrl: 'http://x',
        fetchFn: (async () => new Response(JSON.stringify({ cursor: 0, n_embd: 4, entries: [] }), { status: 200 })) as any,
        jlens: { readout: vi.fn(), health: async () => ({ ok: true, layers: [24, 32] }) } as any,
        broadcast: vi.fn(), layer: 40, stride: 4, layers: LAYERS,
      })
      await c.start()                    // evaluate() #1
      await (c as any).evaluate()        // evaluate() #2
      c.stop()
      const warnings = log.mock.calls
        .map(a => String(a[0]))
        .filter(m => m.includes('do not cover probed layers'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toBe('[brain] lens layers 24,32 do not cover probed layers 24,32,40,48,56 — layer convergence will stay null')
    } finally {
      log.mockRestore()
    }
  })

  it('caps the positions one drain reads out', async () => {
    const box = { batch: { cursor: 0, n_embd: 4, entries: [] as any[] } }
    const lens = codedLens()
    const c = await liveConsumer(lens, vi.fn(), box)

    // 20 complete positions, all on the stride.
    const entries: ReturnType<typeof coded>[] = []
    let cursor = 0
    for (let p = 0; p < 20; p++) for (const l of LAYERS) entries.push(coded(++cursor, l, p * 4, 1))
    box.batch = { cursor, n_embd: 4, entries }
    await c.pollOnce()

    expect(lens.readout).toHaveBeenCalledTimes(MAX_POSITIONS_PER_POLL * LAYERS.length)
    expect(c.convergence().n).toBe(MAX_POSITIONS_PER_POLL)
    expect(c.cursor).toBe(cursor)        // the dropped positions still advanced it
  })
})
