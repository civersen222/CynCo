/**
 * The phone app wakes this PC when it does not answer (engine/dashboard/wake.ts, F256).
 *
 * From 2026-11-11 the phone opened CynCo at this PC's own HTTPS name. A PC asleep answered nothing
 * there, and nothing knocked on the doorman, so nothing woke it. Pinned here: the wake address is
 * https or nothing; `/sw.js` and `/waking` answer without a token only while it is set; the remote
 * page carries it and the desk page does not; the service worker answers a page load the PC does not
 * answer with the waking page and knocks; the waking page tells asleep from awake, knocks only while
 * nothing answers and leaves past the worker's cut-off; the open page holds a message while it wakes
 * the PC, sends it only into the chat it was typed in, and stops knocking when a wake gives up; and a
 * knock never carries the page's token.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import {
  parseWakeUrl, wakeAssets, scriptLiteral, SERVICE_WORKER_PATH, WAKING_PAGE_PATH,
  NAV_TIMEOUT_MS, POLL_EVERY_MS, KNOCK_EVERY_MS, GIVE_UP_MS,
} from '../../dashboard/wake.js'

const WAKE = 'https://doorman.tail05397a.ts.net/wake?target=main'
const APP = 'https://longdongsilver.tail05397a.ts.net'
const KNOCK_INIT = { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function scripts(): string {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1]!)
  return out.join('\n')
}
function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  const close = /\r?\n\}\r?\n/.exec(js.slice(start))
  expect(close).not.toBeNull()
  return js.slice(start, start + close!.index + close![0].length)
}
/** The page's "Waking the PC" section, whole: its constants, its state and its functions. */
function wakeSection(): string {
  const js = scripts()
  const start = js.indexOf('// ── Waking the PC')
  const end = js.indexOf('// ── What this page missed')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return js.slice(start, end)
}
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve() }
const asleep = () => Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'))

// ---------------------------------------------------------------------------

describe('parseWakeUrl: the doorman\'s https wake address, or nothing', () => {
  it('takes an https address and names its origin', () => {
    expect(parseWakeUrl(WAKE)).toEqual({ url: WAKE, origin: 'https://doorman.tail05397a.ts.net' })
    expect(parseWakeUrl(`  ${WAKE}  `)?.url).toBe(WAKE)
  })
  it('refuses anything a page on https could not fetch, or should not', () => {
    for (const bad of [undefined, null, '', '   ', 'http://100.110.117.10:9170/wake', 'javascript:alert(1)', 'ftp://doorman/wake',
      'https://user:secret@doorman.tail05397a.ts.net/wake', 'https://doorman.tail05397a.ts.net/wake#x', 'not an address']) {
      expect(parseWakeUrl(bad as string | undefined), String(bad)).toBeNull()
    }
  })
  it('the address it keeps cannot close a script tag', () => {
    expect(parseWakeUrl('https://doorman.example/</script><script>alert(1)')?.url).not.toMatch(/</)
  })
})

describe('scriptLiteral', () => {
  it('reads back as the same value and has no < in it', () => {
    for (const v of ['</script><b>', 'a b c', null, WAKE]) {
      const lit = scriptLiteral(v)
      expect(lit).not.toMatch(/</)
      expect(new Function(`return ${lit}`)()).toBe(v)
    }
  })
})

// ---------------------------------------------------------------------------

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop(); vi.useRealTimers() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function start(peer: string, wakeUrl: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-wake-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => peer }, proxyPort: null, wakeUrl })
  servers.push(server)
  await new Promise(r => setTimeout(r, 50))
  return { tokens, base: `http://127.0.0.1:${server.getPort()}` }
}
const PHONE = '100.119.113.27'
const DESK = '127.0.0.1'

describe('the two routes, with a wake address', () => {
  it('/sw.js and /waking answer without a token, on the desk and off it, and carry no secret of any scope', async () => {
    for (const peer of [DESK, PHONE]) {
      const { tokens, base } = await start(peer, WAKE)
      const secrets = (['inference', 'management', 'bridge'] as const).map(s => tokens.tokenFor(s)).filter(Boolean) as string[]
      expect(secrets.length).toBe(3)
      const sw = await fetch(base + SERVICE_WORKER_PATH)
      expect(sw.status, peer).toBe(200)
      expect(sw.headers.get('content-type')).toMatch(/^text\/javascript/)
      expect(sw.headers.get('cache-control')).toBe('no-cache')
      const swText = await sw.text()
      expect(swText).toContain(JSON.stringify(WAKE))
      const page = await fetch(base + WAKING_PAGE_PATH)
      expect(page.status, peer).toBe(200)
      expect(page.headers.get('content-type')).toMatch(/^text\/html/)
      const pageText = await page.text()
      for (const s of secrets) { expect(swText).not.toContain(s); expect(pageText).not.toContain(s) }
    }
  })

  it('the waking page may run its own script and reach only this origin and the doorman', async () => {
    const { base } = await start(PHONE, WAKE)
    const res = await fetch(base + WAKING_PAGE_PATH)
    const csp = res.headers.get('content-security-policy') ?? ''
    const body = await res.text()
    const script = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(body)![1]!
    const style = /<style\b[^>]*>([\s\S]*?)<\/style\b[^>]*>/i.exec(body)![1]!
    const hash = (t: string) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src ${hash(script)}`)
    expect(csp).toContain(`style-src ${hash(style)}`)
    expect(csp).toContain("connect-src 'self' https://doorman.tail05397a.ts.net")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('the Host check still stands in front of them', async () => {
    const { base } = await start(PHONE, WAKE)
    const http = await import('http')
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base + SERVICE_WORKER_PATH)
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(421)
  })
})

describe('without a wake address', () => {
  it('neither route answers before the token check, like any unknown path', async () => {
    for (const peer of [DESK, PHONE]) {
      const { base } = await start(peer, null)
      for (const path of [SERVICE_WORKER_PATH, WAKING_PAGE_PATH]) expect((await fetch(base + path)).status, `${peer} ${path}`).toBe(401)
    }
  })
  it('a malformed or http address is no address', async () => {
    const { base } = await start(PHONE, 'http://100.110.117.10:9170/wake')
    expect((await fetch(base + SERVICE_WORKER_PATH)).status).toBe(401)
    expect(await (await fetch(base + '/')).text()).toContain('window.__CYNCO_WAKE_URL = null;')
  })
})

describe('the page says where to knock to a phone only', () => {
  it('remote: the address; the desk: null', async () => {
    const phone = await start(PHONE, WAKE)
    expect(await (await fetch(phone.base + '/')).text()).toContain(`window.__CYNCO_WAKE_URL = ${JSON.stringify(WAKE)};`)
    const desk = await start(DESK, WAKE)
    expect(await (await fetch(desk.base + '/')).text()).toContain('window.__CYNCO_WAKE_URL = null;')
    const none = await start(PHONE, null)
    expect(await (await fetch(none.base + '/')).text()).toContain('window.__CYNCO_WAKE_URL = null;')
  })

  it('a knock through the injected fetch never carries the device token; a same-origin ask does', async () => {
    const phone = await start(PHONE, WAKE)
    const page = await (await fetch(phone.base + '/')).text()
    const prelude = /<head><script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(page)![1]!
    const seen: Array<{ url: string; auth: string | null }> = []
    const win: Record<string, any> = {
      fetch: (input: string, init?: { headers?: HeadersInit }) => { seen.push({ url: input, auth: new Headers(init?.headers).get('Authorization') }); return Promise.resolve({ status: 200 }) },
    }
    const storage = { getItem: () => 'device-secret-for-test', removeItem: () => {} }
    new Function('window', 'localStorage', 'sessionStorage', 'location', 'Headers', prelude)(win, storage, storage, { origin: APP, replace: () => {} }, Headers)
    await win.fetch(WAKE, { mode: 'no-cors' })
    await win.fetch('/manifest.webmanifest', { cache: 'no-store' })
    expect(seen).toEqual([{ url: WAKE, auth: null }, { url: '/manifest.webmanifest', auth: 'Bearer device-secret-for-test' }])
  })
})

// ---------------------------------------------------------------------------

type Listener = (event: any) => void

/** The service worker in a fake worker scope: its listeners, a cache, and a fetch the test controls. */
function worker(wakeUrl = WAKE) {
  const body = wakeAssets(parseWakeUrl(wakeUrl)!).worker.body
  const listeners: Record<string, Listener> = {}
  const stores = new Map<string, Map<string, unknown>>([['cynco-wake-old', new Map()], ['someone-elses', new Map()]])
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const s = stores.get(name)!
      return { add: async (req: { url: string; cache?: string }) => { s.set(req.url, { page: true, cache: req.cache }) }, match: async (path: string) => s.get(path) }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }
  const fetches: Array<{ url: string; init?: Record<string, unknown> }> = []
  let answer: (req: any) => Promise<unknown> = () => new Promise(() => {})
  const fakeFetch = (input: any, init?: Record<string, unknown>) => { fetches.push({ url: typeof input === 'string' ? input : input.url, init }); return typeof input === 'string' ? Promise.resolve({ opaque: true }) : answer(input) }
  class FakeRequest { url: string; cache?: string; constructor(url: string, init?: { cache?: string }) { this.url = url; this.cache = init?.cache } }
  const self = { addEventListener: (type: string, fn: Listener) => { listeners[type] = fn }, location: { origin: APP }, skipWaiting: vi.fn(async () => {}), clients: { claim: vi.fn(async () => {}) } }
  new Function('self', 'caches', 'fetch', 'Request', 'URL', 'console', 'setTimeout', 'clearTimeout', body)(
    self, caches, fakeFetch, FakeRequest, URL, { log: () => {} }, globalThis.setTimeout, globalThis.clearTimeout)
  const navigate = (path: string, opts: { mode?: string; method?: string; origin?: string } = {}) => {
    let responded: Promise<unknown> | null = null
    listeners.fetch!({ request: { url: (opts.origin ?? APP) + path, mode: opts.mode ?? 'navigate', method: opts.method ?? 'GET' }, respondWith: (p: Promise<unknown>) => { responded = p } })
    return responded as Promise<unknown> | null
  }
  const install = async () => {
    let installed: Promise<unknown> = Promise.resolve()
    listeners.install!({ waitUntil: (p: Promise<unknown>) => { installed = p } })
    await installed
  }
  return { self, listeners, stores, fetches, navigate, install, setAnswer: (fn: typeof answer) => { answer = fn }, knocks: () => fetches.filter(f => f.url === wakeUrl) }
}
const WAKING = { page: true, cache: 'no-store' }

describe('the service worker', () => {
  it('install keeps the waking page, fetched fresh; activate drops its own old copies only', async () => {
    const w = worker()
    await w.install()
    const mine = [...w.stores.keys()].find(k => k.startsWith('cynco-wake-') && k !== 'cynco-wake-old')!
    expect(w.stores.get(mine)!.get(WAKING_PAGE_PATH)).toEqual(WAKING)
    expect(w.self.skipWaiting).toHaveBeenCalled()
    let activated: Promise<unknown> = Promise.resolve()
    w.listeners.activate!({ waitUntil: (p: Promise<unknown>) => { activated = p } })
    await activated
    expect([...w.stores.keys()].sort()).toEqual([mine, 'someone-elses'].sort())
    expect(w.self.clients.claim).toHaveBeenCalled()
  })

  it('leaves alone what is not a GET page load of this origin, the waking page itself, and the way back in (direct=1)', () => {
    const w = worker()
    expect(w.navigate('/api/session', { mode: 'cors' })).toBeNull()
    expect(w.navigate('/manifest.webmanifest', { mode: 'no-cors' })).toBeNull()
    expect(w.navigate('/', { method: 'POST' })).toBeNull()
    expect(w.navigate('/', { origin: 'https://elsewhere.example' })).toBeNull()
    expect(w.navigate(WAKING_PAGE_PATH)).toBeNull()
    expect(w.navigate('/?direct=1')).toBeNull()
    expect(w.navigate('/pair?revoked=1&direct=1')).toBeNull()
    expect(w.fetches).toEqual([])
  })

  it('a PC that answers in time is the answer, however slowly within the cut-off, and nobody is knocked on', async () => {
    vi.useFakeTimers()
    const w = worker()
    w.setAnswer(() => new Promise(r => setTimeout(() => r({ the: 'dashboard', status: 200 }), NAV_TIMEOUT_MS - 500)))
    const res = w.navigate('/')!
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS + 1000)
    expect(await res).toEqual({ the: 'dashboard', status: 200 })
    expect(w.knocks()).toEqual([])
  })

  it('a PC that does not answer: no knock before NAV_TIMEOUT_MS, then one knock and the waking page', async () => {
    vi.useFakeTimers()
    const w = worker()
    await w.install()
    const res = w.navigate('/#projects')!
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 100)
    expect(w.knocks()).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(w.knocks()).toEqual([{ url: WAKE, init: KNOCK_INIT }])
    expect(await res).toEqual(WAKING)
  })

  it('a network error is answered with the waking page at once, with one knock', async () => {
    const w = worker()
    await w.install()
    w.setAnswer(asleep)
    expect(await w.navigate('/')!).toEqual(WAKING)
    expect(w.knocks()).toHaveLength(1)
  })

  it('a 502, 503 or 504 (the PC awake, CynCo not) is answered with the waking page and no knock', async () => {
    for (const status of [502, 503, 504]) {
      const w = worker()
      await w.install()
      w.setAnswer(() => Promise.resolve({ status }))
      expect(await w.navigate('/')!, String(status)).toEqual(WAKING)
      expect(w.knocks()).toEqual([])
    }
    const w = worker()
    await w.install()
    w.setAnswer(() => Promise.resolve({ status: 404, the: 'answer' }))
    expect(await w.navigate('/')!).toEqual({ status: 404, the: 'answer' })
  })

  it('with no stored page (the browser cleared it) it waits for the network, as if it were not there', async () => {
    vi.useFakeTimers()
    const w = worker()
    let fail!: (e: unknown) => void
    w.setAnswer(() => new Promise((_, reject) => { fail = reject }))
    const failed = w.navigate('/')!
    await flush()
    fail(new TypeError('NetworkError'))
    await expect(failed).rejects.toThrow('NetworkError')
    let late!: (r: unknown) => void
    w.setAnswer(() => new Promise(r => { late = r }))
    const slow = w.navigate('/')!
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS + 100)
    late({ the: 'dashboard', status: 200 })
    expect(await slow).toEqual({ the: 'dashboard', status: 200 })
  })

  it('a new wake address is a new worker, so a phone picks it up', () => {
    const a = wakeAssets(parseWakeUrl(WAKE)!)
    const b = wakeAssets(parseWakeUrl('https://doorman2.tail05397a.ts.net/wake?target=main')!)
    expect(a.worker.body).not.toBe(b.worker.body)
    expect(wakeAssets(parseWakeUrl(WAKE)!).worker.body).toBe(a.worker.body)
  })
})

// ---------------------------------------------------------------------------

/** The waking page's script against a fake document, location and fetch. */
function wakingPage(manifest: () => Promise<{ ok: boolean; status?: number }>, loc: { pathname?: string; search?: string; hash?: string } = {}) {
  const body = wakeAssets(parseWakeUrl(WAKE)!).page.body
  const script = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/i.exec(body)![1]!
  const els: Record<string, any> = { title: { textContent: '' }, msg: { textContent: '' }, t: { textContent: '' }, retry: { hidden: true, textContent: 'Try again', onclick: null } }
  const location = { pathname: loc.pathname ?? '/', search: loc.search ?? '', hash: loc.hash ?? '', replace: vi.fn() }
  const asked: Array<{ url: string; init: Record<string, unknown> }> = []
  const fakeFetch = (url: string, init: Record<string, unknown>) => {
    asked.push({ url, init })
    return url === WAKE ? Promise.resolve({ type: 'opaque' }) : manifest()
  }
  new Function('document', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'AbortController', 'console', script)(
    { getElementById: (id: string) => els[id] }, location, fakeFetch,
    globalThis.setInterval, globalThis.clearInterval, globalThis.setTimeout, globalThis.clearTimeout, AbortController, { log: () => {} })
  return { els, location, asked, knocks: () => asked.filter(a => a.url === WAKE), asks: () => asked.filter(a => a.url === '/manifest.webmanifest') }
}

describe('the waking page', () => {
  it('asks first, and knocks once nothing answers, without credentials or a referrer', async () => {
    vi.useFakeTimers()
    const p = wakingPage(asleep)
    await flush()
    expect(p.asks()).toHaveLength(1)
    expect(p.asks()[0]!.init.cache).toBe('no-store')
    expect(p.knocks()).toEqual([{ url: WAKE, init: KNOCK_INIT }])
    expect(p.els.title.textContent).toMatch(/Waking CynCo's PC/)
  })

  it('opens CynCo past the worker\'s cut-off once the PC answers, keeping the address it was on', async () => {
    vi.useFakeTimers()
    let up = false
    const p = wakingPage(() => (up ? Promise.resolve({ ok: true }) : asleep()), { pathname: '/', hash: '#projects/garden' })
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS * 3)
    expect(p.location.replace).not.toHaveBeenCalled()
    up = true
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS)
    expect(p.location.replace).toHaveBeenCalledTimes(1)
    expect(p.location.replace).toHaveBeenCalledWith('/?direct=1#projects/garden')
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS * 4)
    expect(p.location.replace).toHaveBeenCalledTimes(1)
  })

  it('keeps a query the page had, and never marks it twice', async () => {
    const a = wakingPage(() => Promise.resolve({ ok: true }), { pathname: '/pair', search: '?revoked=1' })
    await flush()
    expect(a.location.replace).toHaveBeenCalledWith('/pair?revoked=1&direct=1')
    const b = wakingPage(() => Promise.resolve({ ok: true }), { pathname: '/', search: '?direct=1' })
    await flush()
    expect(b.location.replace).toHaveBeenCalledWith('/?direct=1')
  })

  it('a PC that answers but is not CynCo yet (502) is awake: no knock, and it opens CynCo when CynCo answers', async () => {
    vi.useFakeTimers()
    let ready = false
    const p = wakingPage(() => Promise.resolve(ready ? { ok: true } : { ok: false, status: 502 }))
    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS * 2)
    expect(p.knocks()).toEqual([])
    expect(p.els.title.textContent).toBe("CynCo's PC is awake")
    ready = true
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS)
    expect(p.location.replace).toHaveBeenCalledTimes(1)
  })

  it('knocks every KNOCK_EVERY_MS while nothing answers, and gives up after GIVE_UP_MS with a button', async () => {
    vi.useFakeTimers()
    const p = wakingPage(asleep)
    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS * 2 + POLL_EVERY_MS)
    expect(p.knocks().length).toBe(3)
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS)
    expect(p.els.title.textContent).toBe('Still asleep')
    expect(p.els.retry.hidden).toBe(false)
    const asksAtGiveUp = p.asks().length
    const knocksAtGiveUp = p.knocks().length
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS * 20)
    expect(p.asks().length).toBe(asksAtGiveUp)
    expect(p.knocks().length).toBe(knocksAtGiveUp)
    p.els.retry.onclick()
    await flush()
    expect(p.asks().length).toBe(asksAtGiveUp + 1)
    expect(p.knocks().length).toBe(knocksAtGiveUp + 1)
    expect(p.els.retry.hidden).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('the open page: registerWakeWorker and wakeNeedsAsk', () => {
  const registerWakeWorker = new Function(`${fnSource('registerWakeWorker')}; return registerWakeWorker;`)() as
    (nav: any, loc: any, remote: boolean, wake: string | null, cacheStore?: any) => string
  const wakeNeedsAsk = new Function(`var WAKE_QUIET_MS = 45000; ${fnSource('wakeNeedsAsk')}; return wakeNeedsAsk;`)() as (now: number, last: number, readyState: number) => boolean
  const https = { protocol: 'https:' }
  const nav = (regs: any[] = []) => ({ serviceWorker: { register: vi.fn(() => Promise.resolve({})), getRegistrations: vi.fn(() => Promise.resolve(regs)) } })

  it('registers /sw.js at the root on a phone\'s https page with a wake address, and nowhere else', () => {
    const yes = nav()
    expect(registerWakeWorker(yes, https, true, WAKE)).toBe('registered')
    expect(yes.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    for (const [n, loc, remote] of [[nav(), https, false], [nav(), { protocol: 'http:' }, true]] as const) {
      expect(registerWakeWorker(n, loc, remote, WAKE)).toBe('none')
      expect(n.serviceWorker.register).not.toHaveBeenCalled()
      expect(n.serviceWorker.getRegistrations).not.toHaveBeenCalled()
    }
    expect(registerWakeWorker({}, https, true, WAKE)).toBe('none')
  })

  it('with no wake address any more, a phone\'s page removes the worker and its stored page, and nothing else', async () => {
    const mine = { active: { scriptURL: `${APP}/sw.js` }, unregister: vi.fn() }
    const other = { active: { scriptURL: `${APP}/someone-else.js` }, unregister: vi.fn() }
    const n = nav([mine, other])
    const deleted: string[] = []
    const cacheStore = { keys: () => Promise.resolve(['cynco-wake-abc', 'not-ours']), delete: (k: string) => { deleted.push(k); return Promise.resolve(true) } }
    expect(registerWakeWorker(n, https, true, null, cacheStore)).toBe('removed')
    await flush()
    expect(n.serviceWorker.register).not.toHaveBeenCalled()
    expect(mine.unregister).toHaveBeenCalled()
    expect(other.unregister).not.toHaveBeenCalled()
    expect(deleted).toEqual(['cynco-wake-abc'])
    const desk = nav([mine])
    expect(registerWakeWorker(desk, https, false, null, cacheStore)).toBe('none')
    expect(desk.serviceWorker.getRegistrations).not.toHaveBeenCalled()
  })

  it('a socket that is not open, or quiet for 45 s, is asked about first', () => {
    expect(wakeNeedsAsk(100_000, 99_000, 1)).toBe(false)
    expect(wakeNeedsAsk(100_000, 55_000, 1)).toBe(true)
    for (const state of [0, 2, 3]) expect(wakeNeedsAsk(100_000, 99_999, state)).toBe(true)
  })
})

/**
 * The page's real connectWS and its whole "Waking the PC" section, with a WebSocket, a fetch and the
 * page's other parts stubbed. A socket opens when the test says so, or fails on its own (`failSockets`),
 * in which case its real onclose runs, as a browser's would.
 */
function openPage(opts: { configured?: boolean } = {}) {
  const banner = { textContent: 'Reconnecting to engine...', classList: { add: vi.fn(), remove: vi.fn() } }
  const input = { value: '' }
  const env: Record<string, any> = {
    sockets: [] as any[], sends: [] as string[], lines: [] as string[], fetched: [] as Array<{ url: string; init: any }>,
    manifest: 'up' as 'up' | 'awake' | 'asleep', failSockets: false, connectThrows: false, unsettledCalls: 0,
    projectsState: { active: null as any, reconciled: true, connectSeq: 0, rebind: null },
  }
  function FakeSocket(this: any, url: string) {
    if (env.connectThrows) throw new Error('no socket for you')
    this.url = url; this.readyState = 0; this.close = vi.fn(() => { this.readyState = 3 })
    env.sockets.push(this)
    const self = this
    if (env.failSockets) setTimeout(() => { self.readyState = 3; if (self.onclose) self.onclose() }, 10)
  }
  const window = { __CYNCO_REMOTE: opts.configured !== false, __CYNCO_WAKE_URL: opts.configured !== false ? WAKE : null, __CYNCO_TOKEN: 'device-test' }
  const document = { getElementById: (id: string) => (id === 'chatInput' ? input : banner), visibilityState: 'visible' }
  const fetch = (url: string, init: any) => {
    env.fetched.push({ url, init })
    if (url === WAKE) return Promise.resolve({ type: 'opaque' })
    if (url === '/manifest.webmanifest') {
      if (env.manifest === 'up') return Promise.resolve({ ok: true, status: 200 })
      if (env.manifest === 'awake') return Promise.resolve({ ok: false, status: 502 })
      return asleep()
    }
    return Promise.resolve({ ok: true, status: 200 })
  }
  const api = new Function('env', 'window', 'document', 'fetch', 'WebSocket', 'location', 'state', 'render', 'console',
    'fetchSessionState', 'genuiRecheckImages', 'handleEvent',
    `var ws = null, reconnectTimer = null, reconnectDelay = 8000;
     var projectsState = env.projectsState;
     function sendChatMessage() { env.sends.push(document.getElementById('chatInput').value); }
     function projectChatUnsettled() { env.unsettledCalls++; env.lines.push('Reconnecting the project chat'); return false; }
     function appendChatMsg(kind, text) { env.lines.push(text); }
     ${fnSource('wsUrl')}
     ${fnSource('connectWS')}
     ${wakeSection()}
     return {
       setSocket: function (s) { ws = s; }, socket: function () { return ws; }, delay: function () { return reconnectDelay; },
       wakeHoldsSend: wakeHoldsSend, wakeIfAsleep: wakeIfAsleep, wakeState: wakeState,
     };`)(env, window, document, fetch, FakeSocket, { protocol: 'https:', host: 'longdongsilver.tail05397a.ts.net' },
    { connected: false }, () => {}, { log: () => {} }, () => {}, () => {}, () => {})
  const makeSocket = (readyState: number) => ({ readyState, close: vi.fn(), onopen: () => {}, onmessage: () => {}, onclose: () => {}, onerror: () => {} })
  const open = (s: any) => { s.readyState = 1; s.onopen() }
  return { api, env, input, banner, document, makeSocket, open, knocks: () => env.fetched.filter((f: any) => f.url === WAKE) }
}

describe('the open page wakes the PC before it trusts a quiet socket', () => {
  it('not configured (the desk, or no doorman): nothing is held and nothing is asked', () => {
    const p = openPage({ configured: false })
    p.api.setSocket(p.makeSocket(3))
    expect(p.api.wakeHoldsSend('hello')).toBe(false)
    expect(p.env.fetched).toEqual([])
  })

  it('an open socket that carried a frame lately: sent at once', () => {
    const p = openPage()
    p.api.setSocket(p.makeSocket(1))
    p.api.wakeState.lastFrameAt = Date.now()
    expect(p.api.wakeHoldsSend('hello')).toBe(false)
    expect(p.env.fetched).toEqual([])
  })

  it('a quiet socket to a PC that answers: held for one ask, then sent, and no knock', async () => {
    const p = openPage()
    p.api.setSocket(p.makeSocket(1))
    p.api.wakeState.lastFrameAt = Date.now() - 60_000
    p.input.value = 'hello'
    expect(p.api.wakeHoldsSend('hello')).toBe(true)
    await flush(12)
    expect(p.knocks()).toEqual([])
    expect(p.env.sends).toEqual(['hello'])
    expect(p.api.wakeState.pendingText).toBeNull()
  })

  it('a PC asleep: the socket is let go, the doorman knocked, a new socket opened when it answers, the text sent then', async () => {
    vi.useFakeTimers()
    const p = openPage()
    const dead = p.makeSocket(1)
    p.api.setSocket(dead)
    p.api.wakeState.lastFrameAt = Date.now() - 20 * 60_000
    p.env.manifest = 'asleep'
    p.input.value = 'are you there'
    expect(p.api.wakeHoldsSend('are you there')).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(dead.close).toHaveBeenCalled()
    expect(dead.onclose).toBeNull()
    expect(p.knocks()).toHaveLength(1)
    expect(p.knocks()[0]!.init).toEqual(KNOCK_INIT)
    expect(p.banner.textContent).toMatch(/asleep\. Waking it/)
    expect(p.banner.textContent).toMatch(/Your message goes when it answers/)
    expect(p.env.sends).toEqual([])
    // A second press while it wakes is held too, and sends nothing twice.
    expect(p.api.wakeHoldsSend('are you there')).toBe(true)
    p.env.manifest = 'up'
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.env.sockets).toHaveLength(1)
    expect(p.api.delay()).toBe(1000)
    p.open(p.api.socket())
    expect(p.banner.textContent).toBe('Reconnecting to engine...')
    await vi.advanceTimersByTimeAsync(500)
    expect(p.env.sends).toEqual(['are you there'])
    expect(p.env.unsettledCalls).toBe(0)
  })

  it('text edited while the PC woke is left in the box for the owner to send', async () => {
    vi.useFakeTimers()
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'asleep'
    p.input.value = 'first'
    p.api.wakeHoldsSend('first')
    await vi.advanceTimersByTimeAsync(100)
    p.input.value = 'first, and more'
    p.env.manifest = 'up'
    await vi.advanceTimersByTimeAsync(3000)
    p.open(p.api.socket())
    await vi.advanceTimersByTimeAsync(500)
    expect(p.env.sends).toEqual([])
    expect(p.api.wakeState.pendingText).toBeNull()
  })

  it('a held message goes only into the chat it was typed in, and the wait writes nothing to the chat', async () => {
    vi.useFakeTimers()
    const p = openPage()
    p.env.projectsState.active = { slug: 'garden', chat: 'chat-1.json' }
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'asleep'
    p.input.value = 'water the tomatoes?'
    p.api.wakeHoldsSend('water the tomatoes?')
    await vi.advanceTimersByTimeAsync(100)
    p.env.manifest = 'up'
    await vi.advanceTimersByTimeAsync(3000)
    // The engine restarted meanwhile and could not re-open the chat: the reconnect unbinds the pane.
    p.open(p.api.socket())
    p.env.projectsState.reconciled = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.env.lines).toEqual([])
    expect(p.env.unsettledCalls).toBe(0)
    p.env.projectsState.active = null
    p.env.projectsState.reconciled = true
    await vi.advanceTimersByTimeAsync(500)
    expect(p.env.sends).toEqual([])
    expect(p.input.value).toBe('water the tomatoes?')
    expect(p.env.lines).toEqual(["This pane is another chat now than the one the message was typed in; it is still in the box."])
  })

  it('a chat that was new when the message was typed and is named after the reconnect is the same chat', async () => {
    vi.useFakeTimers()
    const p = openPage()
    p.env.projectsState.active = { slug: 'garden', chat: undefined }
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'asleep'
    p.input.value = 'and the beans'
    p.api.wakeHoldsSend('and the beans')
    await vi.advanceTimersByTimeAsync(100)
    p.env.manifest = 'up'
    await vi.advanceTimersByTimeAsync(3000)
    p.env.projectsState.active = { slug: 'garden', chat: 'chat-9.json' }
    p.open(p.api.socket())
    p.env.projectsState.reconciled = true // what reconcileProjectBinding does once /api/session names the chat
    await vi.advanceTimersByTimeAsync(500)
    expect(p.env.sends).toEqual(['and the beans'])
  })

  it('a PC that answers but is not CynCo (502, an engine restarting) is awake: no drop, no knock, its backoff kept', async () => {
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'awake'
    await p.api.wakeIfAsleep(false)
    expect(p.knocks()).toEqual([])
    expect(p.env.sockets).toHaveLength(0)
    await p.api.wakeIfAsleep(true)
    expect(p.knocks()).toEqual([])
    expect(p.env.sockets).toHaveLength(1)
  })

  it('a socket that comes back during a slow ask is kept, not dropped for a sleeping PC', async () => {
    vi.useFakeTimers()
    const p = openPage()
    const sock = p.makeSocket(1)
    p.api.setSocket(sock)
    p.api.wakeState.lastFrameAt = Date.now() - 60_000
    p.env.manifest = 'asleep'
    const done = p.api.wakeIfAsleep(true)
    p.api.wakeState.lastFrameAt = Date.now() + 1 // a frame arrived while the ask ran
    await vi.advanceTimersByTimeAsync(10)
    expect(await done).toBe(true)
    expect(sock.close).not.toHaveBeenCalled()
    expect(p.knocks()).toEqual([])
  })

  it('a socket that closed while the page is in view and the PC is awake keeps its backoff (no reconnect storm)', async () => {
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    await p.api.wakeIfAsleep(false)
    expect(p.env.sockets).toHaveLength(0)
    expect(p.knocks()).toEqual([])
    await p.api.wakeIfAsleep(true)
    expect(p.env.sockets).toHaveLength(1)
  })

  it('two asks at once (the page came into view, and Send) open one socket, not two', async () => {
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    await Promise.all([p.api.wakeIfAsleep(true), p.api.wakeIfAsleep(true)])
    expect(p.env.sockets).toHaveLength(1)
  })

  it('a wake that fails before a send does not hold every later send', async () => {
    vi.useFakeTimers()
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'asleep'
    p.input.value = 'hello'
    expect(p.api.wakeHoldsSend('hello')).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    p.env.connectThrows = true
    p.env.manifest = 'up'
    await vi.advanceTimersByTimeAsync(3000)
    expect(p.api.wakeState.pendingText).toBeNull()
    expect(p.env.sends).toEqual([])
    expect(p.input.value).toBe('hello')
  })

  it('a wake that gives up stops knocking: the sockets that keep failing start no new wake until the owner acts', async () => {
    vi.useFakeTimers()
    const p = openPage()
    p.api.setSocket(p.makeSocket(3))
    p.env.manifest = 'asleep'
    p.env.failSockets = true
    const done = p.api.wakeIfAsleep(true)
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS + 5000)
    expect(await done).toBe(false)
    expect(p.banner.textContent).toMatch(/did not wake/)
    const knocksAtGiveUp = p.knocks().length
    expect(knocksAtGiveUp).toBeGreaterThanOrEqual(Math.floor(GIVE_UP_MS / KNOCK_EVERY_MS))
    // Five more minutes of sockets failing on their own backoff: each close runs the real onclose.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(p.env.sockets.length).toBeGreaterThan(1)
    expect(p.knocks().length).toBe(knocksAtGiveUp)
    // The owner comes back to the page: a new wake starts (not awaited: it runs for minutes).
    void p.api.wakeIfAsleep(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(p.knocks().length).toBe(knocksAtGiveUp + 1)
  })
})

describe('the wiring, as text', () => {
  it('the socket stamps its frames, the open resets the wake, and a close waits for a wake in progress', () => {
    const connect = fnSource('connectWS')
    const onopen = connect.slice(connect.indexOf('ws.onopen = function()'), connect.indexOf('ws.onclose'))
    expect(onopen).toContain("if (typeof wakeOnOpen === 'function') wakeOnOpen();")
    const onclose = connect.slice(connect.indexOf('ws.onclose = function()'), connect.indexOf('ws.onerror'))
    expect(onclose.indexOf('wakeState.waking) return;')).toBeGreaterThan(-1)
    expect(onclose.indexOf('wakeState.waking) return;')).toBeLessThan(onclose.indexOf('setTimeout(connectWS'))
    expect(onclose).toContain('wakeIfAsleep(false)')
    expect(connect.slice(connect.indexOf('ws.onmessage'))).toContain('wakeState.lastFrameAt = Date.now()')
  })
  it('a message is held before the box is cleared', () => {
    const send = fnSource('sendChatMessage')
    expect(send.indexOf('wakeHoldsSend(text)')).toBeGreaterThan(-1)
    expect(send.indexOf('wakeHoldsSend(text)')).toBeLessThan(send.indexOf("input.value = '';"))
  })
  it('coming into view asks first on a phone with a doorman; the worker is registered (or removed) at start; the way back in is not kept', () => {
    const js = scripts()
    expect(js).toMatch(/if \(wakeConfigured\(\)\) \{ wakeIfAsleep\(true\); return; \}/)
    expect(js).toContain("registerWakeWorker(navigator, location, window.__CYNCO_REMOTE, window.__CYNCO_WAKE_URL, typeof caches !== 'undefined' ? caches : null);")
    expect(js).toContain("if (/[?&]direct=1(&|$)/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);")
  })
})
