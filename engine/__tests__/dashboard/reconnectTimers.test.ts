// engine/__tests__/dashboard/reconnectTimers.test.ts
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * The page's socket closes whenever a phone locks, a laptop sleeps or the engine
 * restarts, and `ws.onopen` runs `fetchSessionState` again on every reconnect.
 * That function used to start its timers each time it ran and never kept or
 * cleared one: after N reconnects, N+1 copies of each poll were running (F234
 * follow-up (e), which named three; there were five). A phone left paired for a
 * day asked `/api/governance` every 3 s once per reconnect it had been through.
 *
 * The page's real `connectWS` and `fetchSessionState`, lifted by text like the
 * other dashboard tests, run here against stubs that count.
 */
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'index.html'), 'utf-8')

function scripts(): string {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[2])
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

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)) }

function page() {
  const js = scripts()
  const optional = (name: string) => (js.indexOf(`function ${name}(`) >= 0 ? fnSource(name) : '')
  const timers: Array<{ ms: number; fn: () => void }> = []
  const asked: string[] = []
  const els: Record<string, any> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', value: '', readOnly: true, style: {}, innerHTML: '', appendChild() {},
    classList: { add() {}, remove() {}, contains() { return false } } })
  let sock: any = null
  function WebSocketStub(this: any) { this.readyState = 1; this.send = () => {}; sock = this }
  const projectsState: Record<string, any> = { active: null, renderedChat: null, names: {}, paths: {}, codingCwd: '', connectSeq: 0, reconciled: true, rebind: null }
  const make = new Function('WebSocket', 'location', 'window', 'document', 'state', 'projectsState', 'fetch', 'setInterval', 'setTimeout',
    'render', 'genuiRecheckImages', 'handleEvent', 'appendChatMsg', 'setSlider', 'activateSession', 'clearChatCitations', 'brainViz', 'console',
    'fetchPredictions', 'fetchContracts', 'fetchTrainingData', 'renderToolFeed', 'renderSubsystems', 'escHtml',
    'var ws = null; var reconnectDelay = 1000; var reconnectTimer = null;\n' + optional('wsUrl') + fnSource('connectWS') + fnSource('fetchSessionState') +
    optional('seedSessionCounters') + optional('showConnProject') + optional('setCodingCwd') +
    optional('reconcileProjectBinding') + optional('projectChatUnsettled') +
    '\nconnectWS(); return {};')
  make(WebSocketStub, { protocol: 'http:', hostname: 'localhost', port: '9161', host: 'localhost:9161' }, { __CYNCO_TOKEN: 't' },
    { getElementById: el, body: el('body'), createElement: () => el('made') }, { connected: false, turnCount: 0, context: null, toolFeed: [] }, projectsState,
    (path: string) => { asked.push(path); return Promise.resolve({ json: () => null }) },
    (fn: () => void, ms: number) => { timers.push({ ms, fn }); return timers.length },
    () => 0, () => {}, () => {}, () => {}, () => {},
    () => {}, () => {}, () => {}, { setActive: () => {} }, { warn: () => {}, log: () => {} },
    () => {}, () => {}, () => { asked.push('training') }, () => {}, () => {}, (t: string) => String(t))
  return {
    timers, asked,
    /** The socket opens: the first connect, or a reconnect on the socket `onclose` made. */
    open: async () => { sock.onopen(); await flush() },
  }
}

describe('dashboard: a reconnect starts no second copy of a poll', () => {
  it('the first connect starts each timer once', async () => {
    const p = page()
    await p.open()
    expect(p.timers.map(t => t.ms).sort((a, b) => a - b)).toEqual([1000, 3000, 10000, 10000, 30000])
  })

  it('three reconnects later the same five timers are the only ones', async () => {
    const p = page()
    await p.open()
    for (let i = 0; i < 3; i++) await p.open()
    expect(p.timers.map(t => t.ms).sort((a, b) => a - b)).toEqual([1000, 3000, 10000, 10000, 30000])
  })

  it('every connect still reads the state at once: only the repeating copies are held back', async () => {
    const p = page()
    await p.open()
    const first = p.asked.filter(a => a === '/api/governance').length
    await p.open()
    await p.open()
    expect(first).toBe(1)
    expect(p.asked.filter(a => a === '/api/governance')).toHaveLength(3)
    expect(p.asked.filter(a => a === '/api/session')).toHaveLength(3)
    expect(p.asked.filter(a => a === 'training')).toHaveLength(3)
  })

  it('a timer that fires after a reconnect still polls', async () => {
    const p = page()
    await p.open()
    await p.open()
    const before = p.asked.filter(a => a === '/api/governance').length
    p.timers.find(t => t.ms === 3000)!.fn()
    expect(p.asked.filter(a => a === '/api/governance')).toHaveLength(before + 1)
  })
})
