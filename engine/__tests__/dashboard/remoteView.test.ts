// The phone-sized remote view (wakefulness slice 4): which tabs a remote page
// shows, where it lands, how the Away list renders, and what the Brain tab says
// when the brain or the lens is off. Pure page functions, lifted by text.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
function scripts(): string {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1])
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
function lift<T>(name: string, deps: string[] = []): T {
  const src = deps.map(fnSource).join('\n') + '\n' + fnSource(name)
  return new Function(`${src}; return ${name};`)() as T
}

describe('remoteTabSet', () => {
  const remoteTabSet = lift<(r: boolean) => string[]>('remoteTabSet')
  it('a phone sees Chat, Projects, Away and Missions only', () => {
    expect(remoteTabSet(true)).toEqual(['chat', 'projects', 'away', 'missions'])
  })
  it('the desk keeps its tabs and gains Missions', () => {
    expect(remoteTabSet(false)).toEqual(['chat', 'governance', 'brain', 'history', 'config', 'projects', 'missions'])
  })
})

describe('initialHashFor', () => {
  const initialHashFor = lift<(r: boolean, h: string) => string>('initialHashFor')
  it('a phone with no hash lands in Projects', () => { expect(initialHashFor(true, '')).toBe('#projects') })
  it('a phone that already has a projects hash keeps it', () => { expect(initialHashFor(true, '#projects/fantasy-football')).toBe('#projects/fantasy-football') })
  it('a phone opened on #missions stays on Missions', () => { expect(initialHashFor(true, '#missions')).toBe('#missions') })
  it('the desk keeps whatever it had', () => { expect(initialHashFor(false, '')).toBe(''); expect(initialHashFor(false, '#x')).toBe('#x') })
})

describe('renderAwayRows', () => {
  const renderAwayRows = lift<(runs: any[]) => string>('renderAwayRows', ['escHtml'])
  it('says so when nothing ran', () => {
    expect(renderAwayRows([])).toContain('nothing ran while you were away')
  })
  it('shows time, mission, trigger, outcome and an escaped summary', () => {
    const out = renderAwayRows([{ ts: '2026-11-08T20:15:10Z', mission: 'fantasy-digest', triggerId: 'digest-tin-card', ok: false, summary: 'snapshot <b>UNREADABLE</b>' }])
    expect(out).toContain('fantasy-digest')
    expect(out).toContain('digest-tin-card')
    expect(out).toContain('FAILED')
    expect(out).toContain('&lt;b&gt;UNREADABLE&lt;/b&gt;')
    expect(out).not.toContain('<b>UNREADABLE')
  })
  it('marks a good run ok', () => {
    expect(renderAwayRows([{ ts: '2026-11-08T19:45:29Z', mission: 'm', triggerId: 't', ok: true, summary: 's' }])).toContain('>ok<')
  })
})

describe('brainOffNotice', () => {
  const brainOffNotice = lift<(brain: boolean, lens: boolean) => string | null>('brainOffNotice')
  it('is silent when both run', () => { expect(brainOffNotice(true, true)).toBeNull() })
  it('names the brain switch when the brain is off', () => { expect(brainOffNotice(false, false)).toContain('LOCALCODE_BRAIN') })
  it('names the lens switch when only the lens is off', () => {
    const n = brainOffNotice(true, false)
    expect(n).toContain('LOCALCODE_JLENS=on')
    expect(n).not.toContain('LOCALCODE_BRAIN')
  })
})

describe('remoteRouteOnce', () => {
  const remoteRouteOnce = lift<(state: { routed: boolean }) => boolean>('remoteRouteOnce')
  it('routes on the first open only: a reconnect must not close the chat the phone is in', () => {
    const state = { routed: false }
    expect(remoteRouteOnce(state)).toBe(true)
    expect(remoteRouteOnce(state)).toBe(false)
    expect(remoteRouteOnce(state)).toBe(false)
  })
})

describe('wiring', () => {
  it('applyRemoteLayout asks remoteRouteOnce before it touches the hash or switches tabs', () => {
    const src = fnSource('applyRemoteLayout')
    const gate = src.indexOf('remoteRouteOnce(remoteState)')
    expect(gate).toBeGreaterThan(-1)
    expect(src.indexOf('initialHashFor(')).toBeGreaterThan(gate)
    expect(src.indexOf("switchTab('projects')")).toBeGreaterThan(gate)
  })
  it('the page applies the remote layout at boot and fills the Away tab from /api/away', () => {
    const js = scripts()
    expect(js).toContain('applyRemoteLayout()')
    expect(js).toContain("fetch('/api/away')")
    expect(html).toContain('id="tab-away"')
    expect(html).toMatch(/body\.remote/)
  })
})
