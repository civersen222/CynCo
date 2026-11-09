import { describe, expect, it } from 'bun:test'
import type { LookClient, LookResult } from '../../vision/lookClient.js'
import { LookRunner, PENDING_REASON } from '../../vision/lookRunner.js'
import type { IngestEvent } from '../../projects/ingest.js'
import type { LookInput } from '../../projects/extract/types.js'

const look = { text: 't', state: 's', description: 'd', model: 'qwen3-vl:8b-instruct', ms: 1500 }
const bytes = new Uint8Array([1, 2, 3])

/** A client whose answers the test releases by hand. */
function fakeClient() {
  const waiting: Array<(r: LookResult) => void> = []
  let calls = 0
  const client = { look: () => { calls++; return new Promise<LookResult>(res => waiting.push(res)) } } as unknown as LookClient
  return { client, calls: () => calls, release: (r: LookResult) => waiting.shift()!(r) }
}
function rig(opts: { recentCap?: number } = {}) {
  const c = fakeClient()
  const finished: Array<{ slug: string; rel: string; input: LookInput }> = []
  const logs: string[] = []
  const runner = new LookRunner({
    client: c.client,
    finish: async (slug, rel, input) => { finished.push({ slug, rel, input }); return { slug, filePath: `knowledge/${rel}`, kind: 'knowledge', indexed: 'look' in input, chunks: 2 } as IngestEvent },
    log: (l) => logs.push(l),
    ...(opts.recentCap !== undefined ? { recentCap: opts.recentCap } : {}),
  })
  return { ...c, runner, finished, logs }
}

describe('LookRunner', () => {
  it('start → pending; completion → finish with the look, pending cleared, recent serves it', async () => {
    const r = rig()
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg')
    const p = r.runner.pending('p', 'a.jpg')
    expect(p).not.toBeNull()
    expect(r.runner.recent('p', 'a.jpg')).toBeNull()
    r.release({ ok: true, look })
    const ev = await p!
    expect(ev.indexed).toBe(true)
    expect(r.finished).toEqual([{ slug: 'p', rel: 'a.jpg', input: { look } }])
    expect(r.runner.pending('p', 'a.jpg')).toBeNull()
    expect(r.runner.recent('p', 'a.jpg')).toEqual(look)
    expect(r.logs.some(l => /looked at p\/a\.jpg/.test(l))).toBe(true)
  })
  it('a second start on a pending key is a no-op; two different keys both complete', async () => {
    const r = rig()
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg')
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg')
    r.runner.start('p', 'b.png', bytes, 'image/png')
    expect(r.calls()).toBe(2)
    r.release({ ok: true, look }); r.release({ ok: true, look })
    await Promise.all([r.runner.pending('p', 'a.jpg'), r.runner.pending('p', 'b.png')])
    expect(r.finished.map(f => f.rel).sort()).toEqual(['a.jpg', 'b.png'])
  })
  it('a failed look finishes with the failure reason and remembers nothing', async () => {
    const r = rig()
    r.runner.start('p', 'dark.jpg', bytes, 'image/jpeg')
    r.release({ ok: false, reason: 'image box did not answer: timed out' })
    const ev = await r.runner.pending('p', 'dark.jpg')!
    expect(ev.indexed).toBe(false)
    expect(r.finished[0].input).toEqual({ failure: 'image box did not answer: timed out' })
    expect(r.runner.recent('p', 'dark.jpg')).toBeNull()
  })
  it('recent keeps only the last N looks', async () => {
    const r = rig({ recentCap: 2 })
    for (const n of ['1', '2', '3']) { r.runner.start('p', `${n}.jpg`, bytes, 'image/jpeg'); r.release({ ok: true, look }); await r.runner.pending('p', `${n}.jpg`) }
    expect(r.runner.recent('p', '1.jpg')).toBeNull()
    expect(r.runner.recent('p', '3.jpg')).toEqual(look)
  })
  it('the same bytes attached again after a look are not looked at twice: the recent look is reused and finish runs again', async () => {
    const r = rig()
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg'); r.release({ ok: true, look }); await r.runner.pending('p', 'a.jpg')
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg')
    await r.runner.pending('p', 'a.jpg')
    expect(r.calls()).toBe(1)
    expect(r.finished).toHaveLength(2)
  })
  it('different bytes under the same name while a look is in flight: a new look starts and the stale one never finishes the file', async () => {
    const r = rig()
    r.runner.start('p', 'a.jpg', bytes, 'image/jpeg')
    const other = new Uint8Array([9, 9, 9])
    r.runner.start('p', 'a.jpg', other, 'image/jpeg')
    expect(r.calls()).toBe(2)
    const stale = { ...look, description: 'STALE' }
    r.release({ ok: true, look: stale }); r.release({ ok: true, look })
    await r.runner.pending('p', 'a.jpg')
    await new Promise(res => setTimeout(res, 5))
    expect(r.finished.map(f => ('look' in f.input ? f.input.look.description : 'failure'))).toEqual(['d'])
    expect(r.runner.recent('p', 'a.jpg')).toEqual(look)
    expect(r.logs.some(l => /superseded/.test(l))).toBe(true)
  })
  it('names the pending reason the upload route records', () => {
    expect(PENDING_REASON).toBe('looking at the picture…')
  })
})
