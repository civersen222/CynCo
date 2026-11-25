/**
 * Wave 15 (NOW.md:57): the integrity latch on the desk and on the phone. `/api/session` carries
 * `integrity: { state, summary }` (deskIntegrity, engine/integrity.ts: the latch's public summary, no
 * path), and the Missions tab, which the phone shows too, draws it above the daemon's line with the
 * words that a queued command will not run under it. The page function is lifted out of index.html by
 * brace matching and run for real. The guard folders are this file's own temp folders.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardServer, type DashboardDeps } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { deskIntegrity, LATCH_FILE } from '../../integrity.js'

const made: string[] = []
const tmp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `cynco-desk-latch-${label}-`)); made.push(d); return d }
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const tokenDir = tmp('tokens')
const tokens = loadOrCreateTokens(tokenDir)
const INFERENCE = tokens.tokenFor('inference')!

async function start(deps: DashboardDeps): Promise<{ server: DashboardServer; base: string }> {
  const server = new DashboardServer({ port: 0, tokens, deps })
  const deadline = Date.now() + 2000
  while (server.getPort() === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  return { server, base: `http://localhost:${server.getPort()}` }
}
const session = async (base: string) => (await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${INFERENCE}` } })).json()

/** A guard folder outside the fake home, with or without a latch record. */
function guardWith(latch: object | string | null) {
  const base = tmp('g')
  const guard = join(base, 'guard')
  const home = join(base, 'home')
  for (const d of [guard, home]) mkdirSync(d)
  if (latch !== null) writeFileSync(join(guard, LATCH_FILE), typeof latch === 'string' ? latch : JSON.stringify(latch))
  return { guard, home }
}

describe('deskIntegrity: the latch in words the phone may show', () => {
  it('clear, latched (public summary, when and by whom, no path), a record that cannot be read, a folder that cannot be used', () => {
    let g = guardWith(null)
    expect(deskIntegrity(g.guard, g.home, { sandboxRoot: null })).toEqual({ state: 'clear', summary: 'no integrity latch' })
    g = guardWith({
      schema: 1, at: '2026-11-24T20:00:00.000Z', by: 'engine-tripwire', pid: 1, host: 'h', run: 'r', reason: 'presence-lost', detail: 'C:\\Users\\x\\.config gone',
      campaignId: null, wave: null, cwd: 'C:\\work', summary: '1 change(s); first: PRESENCE C:\\Users\\x/.config gone', publicSummary: '1 change(s) in protected folders (first: PRESENCE)',
      changeCount: 1, changes: [], baseline: null,
    })
    const latched = deskIntegrity(g.guard, g.home, { sandboxRoot: null })
    expect(latched).toEqual({
      state: 'latched', at: '2026-11-24T20:00:00.000Z',
      summary: '1 change(s) in protected folders (first: PRESENCE); set 2026-11-24T20:00:00.000Z by engine-tripwire (presence-lost). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear',
    })
    expect(latched.summary).not.toMatch(/[A-Za-z]:\\/)
    g = guardWith('{ torn')
    expect(deskIntegrity(g.guard, g.home, { sandboxRoot: null })).toEqual({
      state: 'latched', at: null,
      summary: 'the integrity latch is set, and its record cannot be read. No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear',
    })
    const missing = join(tmp('m'), 'no-guard-here')
    const u = deskIntegrity(missing, g.home, { sandboxRoot: null })
    expect(u).toEqual({ state: 'unusable', summary: 'the guard folder cannot be used, so no unattended run starts; bun scripts/cynco-guard.mjs status says why' })
  })
})

describe('GET /api/session carries the latch', () => {
  it('when the engine wires it, as { state, summary }; an engine that does not sends no field', async () => {
    let v: any = { state: 'latched', summary: 'x; set t by y (z). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear', at: 't' }
    const s = await start({ getIntegrity: () => v })
    const bare = await start({})
    try {
      expect((await session(s.base)).integrity).toEqual(v)
      v = { state: 'clear', summary: 'no integrity latch' }
      expect((await session(s.base)).integrity).toEqual({ state: 'clear', summary: 'no integrity latch' })
      expect('integrity' in (await session(bare.base))).toBe(false)
    } finally { s.server.stop(); bare.server.stop() }
  })

  // Wave 15b (check P1-C6): the entry scripts cannot be imported, so the wiring that feeds the desk and the box
  // reporter is pinned as text; without it the dashboard and the watcher show no latch at all.
  it('the engine wires the dashboard\'s latch, and the box reporter reads the same answer', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const engineMain = readFileSync(join(here, '..', '..', 'main.ts'), 'utf-8')
    expect(engineMain).toContain('getIntegrity: () => deskIntegrity(),')
    const reporterMain = readFileSync(join(here, '..', '..', 'power', 'reporter', 'main.ts'), 'utf-8')
    expect(reporterMain).toContain('integrity: async () => { const d = deskIntegrity(); return { state: d.state, summary: d.summary } },')
  })
})

describe('the Missions tab draws the latch (desk and phone)', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  function extractFunction(src: string, name: string): string {
    const start = src.indexOf('function ' + name + '(')
    if (start < 0) throw new Error('function ' + name + ' not found in index.html')
    let depth = 0
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
    }
    throw new Error('unbalanced braces for ' + name)
  }
  const lift = <T,>(name: string, deps: string[]): T =>
    new Function(`${[...deps, name].map(n => extractFunction(html, n)).join('\n')}\nreturn ${name};`)() as T
  const header = lift<(view: any, nowIso: string, integrity?: any) => string>('missionsHeaderHtml', ['escHtml', 'pad2', 'clockText', 'whenText'])
  const NOW = new Date(2026, 10, 24, 21, 0).toISOString()

  it('a latch is the first line, in words, with its summary; clear or unknown draws nothing more', () => {
    const view = { paused: { paused: false }, missions: [] }
    const latched = header(view, NOW, { state: 'latched', summary: '1 change(s) in protected folders (first: PRESENCE); set t by d (presence-lost). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear' })
    expect(latched.startsWith('<div class="mt-msg err mt-latch">Integrity latch: 1 change(s) in protected folders (first: PRESENCE); set t by d (presence-lost). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear</div>')).toBe(true)
    const unusable = header(view, NOW, { state: 'unusable', summary: 'the guard folder cannot be used, so no unattended run starts; bun scripts/cynco-guard.mjs status says why' })
    expect(unusable).toContain('<div class="mt-msg err mt-latch">Integrity: the guard folder cannot be used')
    expect(header(view, NOW, { state: 'clear', summary: 'no integrity latch' })).toBe(header(view, NOW))
    expect(header(view, NOW, undefined)).not.toContain('mt-latch')
  })

  it('the tab asks /api/session for the latch each time it loads the missions', () => {
    const load = extractFunction(html, 'loadMissions')
    expect(load).toContain("fetch('/api/session')")
    expect(load).toContain('missionsState.integrity')
    expect(extractFunction(html, 'renderMissions')).toContain('missionsHeaderHtml(view, now, missionsState.integrity)')
  })
})
