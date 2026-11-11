// The small-model fallback answers behind another engine's server too (F213).
//
// `BusyFallbackProvider` answered only while `gpu-busy.json` named a one-shot. A
// dispatched mission's engine, or a second engine, holds the model port with no
// such file: the lazy wait sat behind it for up to 30 minutes and the chat got
// no answer at all. The rule is now the lazy wait's own: whatever it would wait
// on, the fallback answers behind.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CompletionRequest, Provider } from '../../provider.js'
import type { GpuBusy } from '../../daemon/gpuBusyFile.js'
import { BusyFallbackProvider, portHolderReader, type PortHolder } from '../../llama/busyFallback.js'
import type { PortOwner } from '../../llama/portOwner.js'

function fakeProvider(name: string, withCount = false) {
  const calls: CompletionRequest[] = []
  const p: Provider & { calls: CompletionRequest[] } = {
    name,
    calls,
    listModels: async () => [],
    probeCapabilities: async () => ({ toolUse: 'native', thinking: 'none', tier: 'advanced' } as any),
    healthCheck: async () => true,
    complete: async (r) => { calls.push(r); return { content: [{ type: 'text', text: name }] } as any },
    stream: async function* (r) { calls.push(r); yield { type: 'message_stop', provider: name } as any },
    ...(withCount ? { countTokens: async (t: string) => t.length * 100 } : {}),
  }
  return p
}

const oneShot: GpuBusy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: new Date().toISOString(), timeoutMs: 600_000, pid: 1 }
const missionServer: PortHolder = { key: 'pid 4242', says: 'another CynCo engine\'s model server (pid 4242 (llama-server.exe), the child of a running bun.exe)' }
const req: CompletionRequest = { model: 'Qwen3.8-27B', messages: [] }

function rig(opts: { busy?: GpuBusy | null; holder?: PortHolder | null | (() => PortHolder | null); warm?: boolean; healthy?: boolean } = {}) {
  const primary = fakeProvider('llama-cpp', true)
  const fallback = fakeProvider('ollama')
  const notices: string[] = []
  const logs: string[] = []
  let holderAsked = 0
  const p = new BusyFallbackProvider({
    primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: '192.168.0.47:11434',
    readBusy: () => opts.busy ?? null,
    remainingMs: () => 240_000,
    primaryWarm: () => opts.warm ?? false,
    readPortHolder: async () => { holderAsked++; return typeof opts.holder === 'function' ? opts.holder() : (opts.holder === undefined ? missionServer : opts.holder) },
    fallbackHealthy: async () => opts.healthy ?? true,
    notify: (m) => notices.push(m),
    log: (l) => logs.push(l),
  })
  return { p, primary, fallback, notices, logs, holderAsked: () => holderAsked }
}

describe('BusyFallbackProvider behind another engine\'s server', () => {
  it('no one-shot, another engine\'s server on the port: the fallback answers, and the chat is told once who holds the GPU', async () => {
    const r = rig()
    await r.p.complete(req)
    for await (const _ of r.p.stream(req)) { /* drain */ }
    expect(r.primary.calls).toEqual([])
    expect(r.fallback.calls.map(c => c.model)).toEqual(['qwen3:14b', 'qwen3:14b'])
    expect(r.notices.length).toBe(1)
    expect(r.notices[0]).toContain('another CynCo engine\'s model server (pid 4242')
    expect(r.notices[0]).toContain('qwen3:14b')
    expect(r.notices[0]).toContain('192.168.0.47:11434')
    // Nobody knows when a mission ends: no minutes are promised.
    expect(r.notices[0]).not.toMatch(/min left/)
  })

  it('nothing holds the port: the primary answers', async () => {
    const r = rig({ holder: null })
    await r.p.complete(req)
    expect(r.primary.calls.length).toBe(1)
    expect(r.fallback.calls).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('our own server is warm: the primary answers and the port is not asked about', async () => {
    const r = rig({ warm: true })
    await r.p.complete(req)
    expect(r.primary.calls.length).toBe(1)
    expect(r.holderAsked()).toBe(0)
  })

  it('a one-shot holds the GPU: the busy file is the answer and the port is not asked about', async () => {
    const r = rig({ busy: oneShot })
    await r.p.complete(req)
    expect(r.fallback.calls.length).toBe(1)
    expect(r.holderAsked()).toBe(0)
    expect(r.notices[0]).toContain('digest-espn')
  })

  it('the fallback box is down: the primary waits as before, and the log names the holder', async () => {
    const r = rig({ healthy: false })
    await r.p.complete(req)
    expect(r.primary.calls.length).toBe(1)
    expect(r.fallback.calls).toEqual([])
    expect(r.logs.some(l => /pid 4242/.test(l) && /not answering/.test(l))).toBe(true)
  })

  it('a different holder gets a new notice; the same one does not', async () => {
    let current: PortHolder | null = missionServer
    const r = rig({ holder: () => current })
    await r.p.complete(req); await r.p.complete(req)
    current = { key: 'pid 5151', says: 'another CynCo engine\'s model server (pid 5151 (llama-server.exe), the child of a running bun.exe)' }
    await r.p.complete(req)
    expect(r.notices.length).toBe(2)
    expect(r.notices[1]).toContain('pid 5151')
  })

  it('countTokens follows the route: the primary tokenizer would wait behind the other server', async () => {
    const r = rig()
    expect(await r.p.countTokens('abcdefgh')).toBe(2)
    expect(await rig({ holder: null }).p.countTokens('abcdefgh')).toBe(800)
  })

  it('a stopped turn asks nobody', async () => {
    const r = rig()
    const stopped = new AbortController(); stopped.abort()
    expect(await r.p.countTokens('abcdefgh', stopped.signal)).toBe(2)
    await expect(r.p.complete({ ...req, signal: stopped.signal })).rejects.toThrow()
    expect(r.holderAsked()).toBe(0)
  })

  it('a provider built without the reader behaves as before: only a one-shot routes to the fallback', async () => {
    const primary = fakeProvider('llama-cpp'), fallback = fakeProvider('ollama')
    const p = new BusyFallbackProvider({
      primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: 'box',
      readBusy: () => null, remainingMs: () => null, primaryWarm: () => false,
      fallbackHealthy: async () => true, notify: () => {}, log: () => {},
    })
    await p.complete(req)
    expect(primary.calls.length).toBe(1)
  })
})

describe('portHolderReader: what the lazy wait would wait on', () => {
  function reader(opts: { ownServer?: boolean; occupied?: boolean; healthy?: boolean; owner?: PortOwner; ttlMs?: number } = {}) {
    const asked = { occupied: 0, healthy: 0, owner: 0 }
    let t = 0
    const read = portHolderReader({
      port: 8081,
      ownServerUp: () => opts.ownServer ?? false,
      isPortOccupied: async () => { asked.occupied++; return opts.occupied ?? true },
      isHealthy: async () => { asked.healthy++; return opts.healthy ?? true },
      portOwner: async () => { asked.owner++; return opts.owner ?? { owner: 'engine', detail: 'pid 4242 (llama-server.exe), the child of a running bun.exe' } },
      now: () => t,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    })
    return { read, asked, advance: (ms: number) => { t += ms } }
  }

  it('another engine\'s healthy server: a holder that names it', async () => {
    const r = reader()
    const h = await r.read()
    expect(h?.says).toBe('another CynCo engine\'s model server (pid 4242 (llama-server.exe), the child of a running bun.exe)')
    expect(h?.key).toContain('pid 4242')
  })

  it('a server whose owner cannot be read is waited on too, so it is a holder', async () => {
    const h = await reader({ owner: { owner: 'unknown', detail: 'port ownership is read on Windows only' } }).read()
    expect(h?.says).toMatch(/a model server on port 8081 whose owner could not be read/)
  })

  it('a server that is not CynCo\'s is not a holder: the lazy path takes the port from it', async () => {
    expect(await reader({ owner: { owner: 'foreign', detail: 'pid 9 (python.exe), started by bash.exe' } }).read()).toBeNull()
  })

  it('our own server, loading or warm, is never a holder, and nothing is asked', async () => {
    const r = reader({ ownServer: true })
    expect(await r.read()).toBeNull()
    expect(r.asked).toEqual({ occupied: 0, healthy: 0, owner: 0 })
  })

  it('a free port: null, and the owner is not read', async () => {
    const r = reader({ occupied: false })
    expect(await r.read()).toBeNull()
    expect(r.asked.owner).toBe(0)
  })

  it('a bound port that does not answer /health is stale, not a holder: the lazy path kills it', async () => {
    const r = reader({ healthy: false })
    expect(await r.read()).toBeNull()
    expect(r.asked.owner).toBe(0)
  })

  it('the owner is read once per five seconds, not once per call: a turn asks for every message it counts', async () => {
    const r = reader()
    for (let i = 0; i < 20; i++) await r.read()
    expect(r.asked.owner).toBe(1)
    r.advance(5001)
    await r.read()
    expect(r.asked.owner).toBe(2)
  })

  it('a holder that has gone is noticed at the next call, whatever was remembered', async () => {
    let occupied = true
    let t = 0
    const read = portHolderReader({
      port: 8081, ownServerUp: () => false, isPortOccupied: async () => occupied, isHealthy: async () => true,
      portOwner: async () => ({ owner: 'engine', detail: 'pid 4242 (llama-server.exe)' }), now: () => t,
    })
    expect(await read()).not.toBeNull()
    occupied = false
    expect(await read()).toBeNull()
  })
})

describe('wiring', () => {
  it('bootstrapProvider gives the fallback provider the reader, built on the process manager\'s own probes', () => {
    const src = readFileSync('engine/bootstrapProvider.ts', 'utf-8')
    expect(src).toMatch(/readPortHolder:\s*portHolderReader\(\{/)
    expect(src).toMatch(/ownServerUp:\s*\(\)\s*=>\s*processManager\.isRunning\(\)/)
  })
})
