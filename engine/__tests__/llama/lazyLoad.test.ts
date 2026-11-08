import { afterEach, describe, expect, it, vi } from 'bun:test'
import { ActivityRegistry } from '../../power/activity.js'
import { IdleUnloader, createLazyEnsureReady, lazySettings } from '../../llama/lazyLoad.js'
import { LlamaCppProvider } from '../../llama/provider.js'

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
})
