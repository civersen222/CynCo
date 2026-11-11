// Wakefulness slice 2b: while a daemon one-shot owns the 5090, a lazy phone
// engine answers on the secondary box's Ollama (qwen3:14b on the 4070 Ti Super)
// instead of waiting. Pure routing, fake providers.
import { describe, expect, it } from 'bun:test'
import type { CompletionRequest, Provider } from '../../provider.js'
import type { GpuBusy } from '../../daemon/gpuBusyFile.js'
import { BusyFallbackProvider, fallbackSettings } from '../../llama/busyFallback.js'

function fakeProvider(name: string, withCount = false) {
  const calls: CompletionRequest[] = []
  const p: Provider & { calls: CompletionRequest[]; processManager?: unknown } = {
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

const busy: GpuBusy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: new Date().toISOString(), timeoutMs: 600_000, pid: 1 }

function rig(opts: { busy?: GpuBusy | null; warm?: boolean; healthy?: boolean } = {}) {
  const primary = fakeProvider('llama-cpp', true)
  primary.processManager = { tag: 'pm' }
  const fallback = fakeProvider('ollama')
  const notices: string[] = []
  const logs: string[] = []
  let healthAsked = 0
  const p = new BusyFallbackProvider({
    primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: '192.168.0.47:11434',
    readBusy: () => (opts.busy === undefined ? busy : opts.busy),
    remainingMs: () => 240_000,
    primaryWarm: () => opts.warm ?? false,
    fallbackHealthy: async () => { healthAsked++; return opts.healthy ?? true },
    notify: (m) => notices.push(m),
    log: (l) => logs.push(l),
  })
  return { p, primary, fallback, notices, logs, healthAsked: () => healthAsked }
}

const req: CompletionRequest = { model: 'Qwen3.8-27B', messages: [] }

describe('fallbackSettings', () => {
  it('is off unless LOCALCODE_FALLBACK_URL is set; the model defaults to qwen3:14b', () => {
    expect(fallbackSettings({})).toEqual({ url: null, model: 'qwen3:14b' })
    expect(fallbackSettings({ LOCALCODE_FALLBACK_URL: '  ' })).toEqual({ url: null, model: 'qwen3:14b' })
  })
  it('reads both switches and drops a trailing slash', () => {
    expect(fallbackSettings({ LOCALCODE_FALLBACK_URL: 'http://192.168.0.47:11434/', LOCALCODE_FALLBACK_MODEL: 'qwen3:8b' }))
      .toEqual({ url: 'http://192.168.0.47:11434', model: 'qwen3:8b' })
  })
})

describe('BusyFallbackProvider', () => {
  it('GPU free: the primary answers, the fallback is not even asked for health', async () => {
    const r = rig({ busy: null })
    await r.p.complete(req)
    expect(r.primary.calls.map(c => c.model)).toEqual(['Qwen3.8-27B'])
    expect(r.fallback.calls).toEqual([])
    expect(r.healthAsked()).toBe(0)
    expect(r.notices).toEqual([])
  })

  it('GPU busy but our own server is warm: the primary answers', async () => {
    const r = rig({ warm: true })
    await r.p.complete(req)
    expect(r.primary.calls.length).toBe(1)
    expect(r.fallback.calls).toEqual([])
  })

  it('GPU busy and the fallback does not answer: the primary waits as before, and the log says why', async () => {
    const r = rig({ healthy: false })
    await r.p.complete(req)
    expect(r.primary.calls.length).toBe(1)
    expect(r.fallback.calls).toEqual([])
    expect(r.logs.some(l => /fallback/.test(l) && /not answering|unreachable/.test(l))).toBe(true)
  })

  it('GPU busy and the fallback answers: the request goes there with the fallback model, and the chat is told once per one-shot', async () => {
    const r = rig()
    await r.p.complete(req)
    for await (const _ of r.p.stream(req)) { /* drain */ }
    expect(r.primary.calls).toEqual([])
    expect(r.fallback.calls.map(c => c.model)).toEqual(['qwen3:14b', 'qwen3:14b'])
    expect(r.notices.length).toBe(1)
    expect(r.notices[0]).toContain('digest-espn')
    expect(r.notices[0]).toContain('qwen3:14b')
    expect(r.notices[0]).toContain('192.168.0.47:11434')
    expect(r.notices[0]).toMatch(/4 min/)
  })

  it('a new one-shot gets a new notice', async () => {
    let current: GpuBusy | null = busy
    const primary = fakeProvider('llama-cpp'), fallback = fakeProvider('ollama')
    const notices: string[] = []
    const p = new BusyFallbackProvider({
      primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: 'box',
      readBusy: () => current, remainingMs: () => null, primaryWarm: () => false,
      fallbackHealthy: async () => true, notify: (m) => notices.push(m), log: () => {},
    })
    await p.complete(req); await p.complete(req)
    current = { ...busy, triggerId: 'transaction-watch' }
    await p.complete(req)
    expect(notices.length).toBe(2)
    expect(notices[1]).toContain('transaction-watch')
  })

  it('countTokens follows the route: the primary tokenizer would wait on the busy GPU, so the fallback counts (heuristic when it has none)', async () => {
    const r = rig()
    expect(await r.p.countTokens('abcdefgh')).toBe(2)
    const free = rig({ busy: null })
    expect(await free.p.countTokens('abcdefgh')).toBe(800)
  })

  it('keeps the primary identity main.ts relies on: name and processManager', () => {
    const r = rig()
    expect(r.p.name).toBe('llama-cpp')
    expect((r.p as any).processManager).toEqual({ tag: 'pm' })
    expect('processManager' in r.p).toBe(true)
  })
})

// F205: Stop pressed while a one-shot holds the GPU and the fallback box is down. Every call after it
// still asked the box whether it was up and sat out the 2 s health timeout: 6.2 s from Stop to the
// turn's end on the live engine, and more with a longer history.
describe('BusyFallbackProvider and a stopped turn', () => {
  const stopped = () => { const ac = new AbortController(); ac.abort(); return ac.signal }

  it('a token count for a stopped turn is the heuristic at once: neither box is asked', async () => {
    const r = rig({ healthy: false })
    expect(await r.p.countTokens!('x'.repeat(40), stopped())).toBe(10)
    expect(r.healthAsked()).toBe(0)
  })

  it('a request for a stopped turn ends with the abort error at once, for stream and for complete', async () => {
    const r = rig({ healthy: false })
    const signal = stopped()
    await expect((async () => { for await (const _ of r.p.stream({ ...req, signal })) { /* drain */ } })()).rejects.toHaveProperty('name', 'AbortError')
    await expect(r.p.complete({ ...req, signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(r.healthAsked()).toBe(0)
    expect(r.primary.calls).toEqual([])
    expect(r.fallback.calls).toEqual([])
  })

  it('a turn that is not stopped is routed as before', async () => {
    const r = rig({ healthy: false })
    expect(await r.p.countTokens!('abc', new AbortController().signal)).toBe(300)
    expect(r.healthAsked()).toBe(1)
  })
})
