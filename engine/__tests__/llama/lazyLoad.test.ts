import { afterEach, describe, expect, it, vi } from 'bun:test'
import { ActivityRegistry } from '../../power/activity.js'
import { IdleUnloader, createLazyEnsureReady, lazySettings } from '../../llama/lazyLoad.js'
import { LlamaCppProvider } from '../../llama/provider.js'
import { ProcessManager } from '../../llama/processManager.js'

function fakeTimers() {
  const timers = new Map<number, { at: number; fn: () => void }>()
  let id = 0, t = 0
  return {
    setTimer: ((fn: () => void, ms: number) => { timers.set(++id, { at: t + ms, fn }); return id as any }) as typeof setTimeout,
    clearTimer: ((h: any) => { timers.delete(h) }) as typeof clearTimeout,
    advance(ms: number) { t += ms; for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn() } },
    pending: () => timers.size,
  }
}

describe('lazySettings', () => {
  it('defaults keep today\'s behaviour: not lazy, never unload, 30 min wait', () => {
    expect(lazySettings({})).toEqual({ lazy: false, idleUnloadMs: 0, lazyWaitMs: 1_800_000 })
  })
  it('reads the three switches', () => {
    expect(lazySettings({ LOCALCODE_LLAMA_LAZY: 'true', LOCALCODE_LLAMA_IDLE_UNLOAD_MS: '900000', LOCALCODE_LLAMA_LAZY_WAIT_MS: '60000' }))
      .toEqual({ lazy: true, idleUnloadMs: 900_000, lazyWaitMs: 60_000 })
  })
  it('ignores garbage values', () => {
    expect(lazySettings({ LOCALCODE_LLAMA_LAZY: 'yes', LOCALCODE_LLAMA_IDLE_UNLOAD_MS: '-5', LOCALCODE_LLAMA_LAZY_WAIT_MS: 'abc' }))
      .toEqual({ lazy: false, idleUnloadMs: 0, lazyWaitMs: 1_800_000 })
  })
})

describe('IdleUnloader', () => {
  function make(idleMs = 1000, running = true) {
    const registry = new ActivityRegistry()
    const ft = fakeTimers()
    const unloads: number[] = []
    const u = new IdleUnloader({ registry, isRunning: () => running, unload: async () => { unloads.push(1) }, idleMs, setTimer: ft.setTimer, clearTimer: ft.clearTimer })
    return { registry, ft, unloads, u, setRunning: (v: boolean) => { running = v } }
  }

  it('unloads after idleMs with nothing open', () => {
    const { ft, unloads, u } = make(1000)
    u.start()
    ft.advance(999); expect(unloads.length).toBe(0)
    ft.advance(1); expect(unloads.length).toBe(1)
  })

  it('does not unload while an activity is open (a tool call mid-turn), and re-arms when it closes', () => {
    const { registry, ft, unloads, u } = make(1000)
    u.start()
    const end = registry.begin('turn')
    ft.advance(5000); expect(unloads.length).toBe(0)
    end()
    ft.advance(999); expect(unloads.length).toBe(0)
    ft.advance(1); expect(unloads.length).toBe(1)
  })

  it('never unloads when the server is not running', () => {
    const { ft, unloads, u } = make(1000, false)
    u.start(); ft.advance(5000)
    expect(unloads.length).toBe(0)
  })

  it('idleMs 0 never arms a timer', () => {
    const { ft, u } = make(0)
    u.start()
    expect(ft.pending()).toBe(0)
  })

  it('stop cancels the timer', () => {
    const { ft, unloads, u } = make(1000)
    u.start(); u.stop(); ft.advance(5000)
    expect(unloads.length).toBe(0)
  })
})

describe('createLazyEnsureReady', () => {
  it('runs ensureRunningLazy once for concurrent callers and again after it settles', async () => {
    let calls = 0
    let release!: () => void
    const pm = {
      ensureRunningLazy: async () => { calls++; await new Promise<void>(r => { release = r }) },
      isPortOccupied: async () => false,
    }
    const ready = createLazyEnsureReady(pm as any, { readBusy: () => null, maxWaitMs: 1000 })
    const a = ready(); const b = ready()
    expect(calls).toBe(1)
    release(); await a; await b
    const c = ready(); release(); await c
    expect(calls).toBe(2)
  })

  // F204. The fake wait ends only the way the real one does: it resolves when released and rejects when its signal aborts.
  function waitingPm() {
    const seen: { calls: number; signal: AbortSignal | undefined; release: () => void } = { calls: 0, signal: undefined, release: () => {} }
    const pm = {
      ensureRunningLazy: (deps: { signal?: AbortSignal }) => new Promise<void>((resolve, reject) => {
        seen.calls++; seen.signal = deps.signal; seen.release = resolve
        deps.signal?.addEventListener('abort', () => reject(new Error('the wait was cancelled')))
      }),
      isPortOccupied: async () => false,
    }
    return { seen, ready: createLazyEnsureReady(pm as any, { readBusy: () => null, maxWaitMs: 1000 }) }
  }

  it('a caller whose signal aborts leaves at once, and the wait goes on for the caller still there', async () => {
    const { seen, ready } = waitingPm()
    const a = new AbortController(), b = new AbortController()
    const pa = ready(a.signal), pb = ready(b.signal)
    a.abort()
    await expect(pa).rejects.toHaveProperty('name', 'AbortError')
    expect(seen.signal!.aborted).toBe(false)
    seen.release(); await pb
    expect(seen.calls).toBe(1)
  })

  it('cancels the wait when the last caller has stopped: nobody is asking for the model', async () => {
    const { seen, ready } = waitingPm()
    const a = new AbortController(), b = new AbortController()
    const pa = ready(a.signal), pb = ready(b.signal)
    a.abort(); b.abort()
    await expect(pa).rejects.toHaveProperty('name', 'AbortError')
    await expect(pb).rejects.toHaveProperty('name', 'AbortError')
    expect(seen.signal!.aborted).toBe(true)
    // The next request starts a wait of its own.
    await new Promise(r => setTimeout(r, 0))
    const pc = ready(); seen.release(); await pc
    expect(seen.calls).toBe(2)
  })

  it('a caller with no signal keeps the wait alive when the others stop', async () => {
    const { seen, ready } = waitingPm()
    const a = new AbortController()
    const pa = ready(a.signal), pc = ready()
    a.abort()
    await expect(pa).rejects.toHaveProperty('name', 'AbortError')
    expect(seen.signal!.aborted).toBe(false)
    seen.release(); await pc
  })

  it('a request that arrives behind a cancelled load that is already spawning can itself be stopped', async () => {
    // A load inside startProcess ignores the cancel and runs to its end.
    let calls = 0
    let release!: () => void
    const pm = { ensureRunningLazy: () => { calls++; return new Promise<void>(r => { release = r }) }, isPortOccupied: async () => false }
    const ready = createLazyEnsureReady(pm as any, { readBusy: () => null, maxWaitMs: 1000 })
    const a = new AbortController(), b = new AbortController()
    const pa = ready(a.signal); a.abort()
    await expect(pa).rejects.toHaveProperty('name', 'AbortError')
    const pb = ready(b.signal); b.abort()
    await expect(pb).rejects.toHaveProperty('name', 'AbortError')
    // One that is not stopped asks afresh once that load is done.
    const pc = ready(); release()
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toBe(2)
    release(); await pc
  })

  it('starts nothing for a signal that is already aborted', async () => {
    const { seen, ready } = waitingPm()
    const a = new AbortController(); a.abort()
    await expect(ready(a.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(seen.calls).toBe(0)
  })
})

describe('LlamaCppProvider lazy gate', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('awaits ensureReady before the first fetch and holds a request activity for the call', async () => {
    const order: string[] = []
    const registry = new ActivityRegistry()
    let countDuringFetch = -1
    vi.stubGlobal('fetch', async () => { order.push('fetch'); countDuringFetch = registry.count(); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} }), { status: 200 }) })
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081', modelName: 'm', modelsDir: '/fake',
      ensureReady: async () => { order.push('ready') },
      activity: registry,
    })
    await p.complete({ model: 'm', messages: [] } as any)
    expect(order).toEqual(['ready', 'fetch'])
    expect(countDuringFetch).toBe(1)
    expect(registry.count()).toBe(0)
  })

  it('releases the request activity when the fetch throws', async () => {
    const registry = new ActivityRegistry()
    vi.stubGlobal('fetch', async () => { throw new Error('boom') })
    const p = new LlamaCppProvider({ primaryUrl: 'http://127.0.0.1:8081', modelName: 'm', modelsDir: '/fake', activity: registry })
    await expect(p.complete({ model: 'm', messages: [] } as any)).rejects.toThrow('boom')
    expect(registry.count()).toBe(0)
  })

  it('hands the request signal to ensureReady, for complete and for stream', async () => {
    const got: (AbortSignal | undefined)[] = []
    vi.stubGlobal('fetch', async () => { throw new Error('boom') })
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081', modelName: 'm', modelsDir: '/fake',
      ensureReady: async (signal?: AbortSignal) => { got.push(signal) },
    })
    const ac = new AbortController()
    await p.complete({ model: 'm', messages: [], signal: ac.signal } as any).catch(() => {})
    await (async () => { for await (const _ of p.stream({ model: 'm', messages: [], signal: ac.signal } as any)) { /* drain */ } })().catch(() => {})
    expect(got).toEqual([ac.signal, ac.signal])
  })

  it('a token count waiting for the model port ends on Stop with the heuristic and leaves the wait', async () => {
    const pm = new ProcessManager({ binaryPath: '/bin/llama-server', modelPath: '/models/qwen.gguf', port: 8081 })
    let starts = 0, fetched = 0
    ;(pm as any).startProcess = async () => { starts++ }
    const busy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: new Date().toISOString(), timeoutMs: 600_000, pid: 7 }
    vi.stubGlobal('fetch', async () => { fetched++; throw new Error('no request should be made') })
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081', modelName: 'm', modelsDir: '/fake',
      ensureReady: createLazyEnsureReady(pm, { readBusy: () => busy, maxWaitMs: 60_000, pollMs: 10_000 }),
    })
    const ac = new AbortController()
    const count = p.countTokens('x'.repeat(40), ac.signal)
    await new Promise(r => setTimeout(r, 20))
    expect(pm.modelState()).toBe('waiting')
    ac.abort()
    expect(await count).toBe(10)
    await new Promise(r => setTimeout(r, 20))
    expect(pm.modelState()).toBe('cold')
    expect(starts).toBe(0)
    expect(fetched).toBe(0)
  })

  // F204, the real pieces together: a one-shot holds the GPU, a turn waits for the port, the owner presses Stop.
  it('Stop during the wait for the model port ends the request, loads nothing and leaves the model cold', async () => {
    const pm = new ProcessManager({ binaryPath: '/bin/llama-server', modelPath: '/models/qwen.gguf', port: 8081 })
    let starts = 0, fetched = 0
    ;(pm as any).startProcess = async () => { starts++ }
    const busy = { task: 'fantasy-digest', triggerId: 'digest-espn', startedAt: new Date().toISOString(), timeoutMs: 600_000, pid: 7 }
    const registry = new ActivityRegistry()
    vi.stubGlobal('fetch', async () => { fetched++; throw new Error('no request should be made') })
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081', modelName: 'm', modelsDir: '/fake', activity: registry,
      ensureReady: createLazyEnsureReady(pm, { readBusy: () => busy, maxWaitMs: 60_000, pollMs: 10_000 }),
    })
    const ac = new AbortController()
    const turn = (async () => { for await (const _ of p.stream({ model: 'm', messages: [], signal: ac.signal } as any)) { /* drain */ } })()
    turn.catch(() => {})
    await new Promise(r => setTimeout(r, 20))
    expect(pm.modelState()).toBe('waiting')
    ac.abort()
    await expect(turn).rejects.toHaveProperty('name', 'AbortError')
    await new Promise(r => setTimeout(r, 20))
    expect(pm.modelState()).toBe('cold')
    expect(starts).toBe(0)
    expect(fetched).toBe(0)
    expect(registry.count()).toBe(0)
  })
})
