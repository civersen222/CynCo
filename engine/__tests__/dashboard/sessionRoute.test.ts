/**
 * GET /api/session and the Governance tab after a reload (projects-fix-1 D).
 *
 * The first live project session, reloaded, showed `Turns: 0`, `0 / 0 tokens`
 * and the Mission and Campaign panels with no mission running: the page built
 * its counters only from live events. /api/session now carries the live
 * conversation's counters and the bound project; the page seeds from it on
 * every socket open and hides the Mission/Campaign panels when nothing is
 * active.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DashboardServer, countUserTurns, type DashboardDeps } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const _tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-session-'))
const _tokens = loadOrCreateTokens(_tokenDir)
const _INFERENCE = _tokens.tokenFor('inference')!
process.on('exit', () => rmSync(_tokenDir, { recursive: true, force: true }))

async function start(deps: DashboardDeps): Promise<{ server: DashboardServer; base: string }> {
  const server = new DashboardServer({ port: 0, tokens: _tokens, deps })
  const deadline = Date.now() + 2000
  while (server.getPort() === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  return { server, base: `http://localhost:${server.getPort()}` }
}

const get = (base: string, token: string | null = _INFERENCE) =>
  fetch(`${base}/api/session`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})

describe('GET /api/session', () => {
  let bound: { slug: string; chat: string | null; title: string | null } | null = null
  let counters: { turns: number; contextUsed: number | null } = { turns: 0, contextUsed: null }
  let wired: { server: DashboardServer; base: string }
  let bare: { server: DashboardServer; base: string }

  beforeAll(async () => {
    wired = await start({
      getSessionInfo: () => ({ model: 'qwen.gguf', contextLength: 65536, tier: 'advanced', projectPath: 'C:/code' } as any),
      getRunState: () => ({ processing: true, toolCalls: 7 }),
      getSessionCounters: () => counters,
      currentProject: () => bound,
    })
    bare = await start({})
  })
  afterAll(() => { wired.server.stop(); bare.server.stop() })

  it('answers the live conversation in one read', async () => {
    counters = { turns: 3, contextUsed: 12000 }
    bound = null
    const res = await get(wired.base)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model: 'qwen.gguf', contextLength: 65536, tier: 'advanced', projectPath: 'C:/code',
      processing: true, toolCalls: 7, turns: 3, contextUsed: 12000, project: null,
    })
  })

  it('names the bound project chat', async () => {
    bound = { slug: 'front-yard-diorama', chat: '2026-10-08-diorama.jsonl', title: 'Diorama' }
    const body = await (await get(wired.base)).json()
    expect(body.project).toEqual({ slug: 'front-yard-diorama', chat: '2026-10-08-diorama.jsonl', title: 'Diorama' })
    bound = null
  })

  it('contextUsed is null before any turn is measured, never 0 (F16)', async () => {
    counters = { turns: 0, contextUsed: null }
    const body = await (await get(wired.base)).json()
    expect(body.contextUsed).toBeNull()
    expect(body.turns).toBe(0)
  })

  it('an engine that wired nothing answers nulls, not zeros', async () => {
    expect(await (await get(bare.base)).json()).toEqual({
      model: null, contextLength: null, processing: null, toolCalls: null, turns: null, contextUsed: null, project: null,
    })
  })

  it('is behind the inference token gate', async () => {
    expect((await get(wired.base, null)).status).toBe(401)
    expect((await get(wired.base, 'not-a-token')).status).toBe(401)
  })
})

describe('countUserTurns', () => {
  it('counts what the user said, not the tool results the loop appends', () => {
    expect(countUserTurns([])).toBe(0)
    expect(countUserTurns([
      { role: 'user', content: 'plan a diorama' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ProjectSearch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'What scale?' }] },
      { role: 'user', content: [{ type: 'text', text: '1:24' }] },
    ])).toBe(2)
  })
})

describe('dashboard page: seeded from /api/session, idle panels hidden', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  const js = (() => {
    const out: string[] = []
    const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) out.push(m[2])
    return out.join('\n')
  })()
  function fnSource(name: string): string {
    const start = js.indexOf(`function ${name}(`)
    expect(start, `function ${name} not found`).toBeGreaterThan(-1)
    const close = /\r?\n\}\r?\n/.exec(js.slice(start))
    return js.slice(start, start + close!.index + close![0].length)
  }

  it('fetches /api/session on every socket open and seeds the counters from it', () => {
    expect(fnSource('fetchSessionState')).toContain("fetch('/api/session')")
    expect(fnSource('fetchSessionState')).toContain('seedSessionCounters(data)')
    const onopen = js.slice(js.indexOf('ws.onopen = function()'), js.indexOf('ws.onclose'))
    expect(onopen).toContain('fetchSessionState()')
  })

  it('hides the Mission panel on active:false and the Campaign panel only when no campaign exists', () => {
    expect(html).toContain('<div class="panel hidden" id="panelMission">')
    expect(html).toContain('<div class="panel full-width hidden" id="panelCampaign">')
    expect(html).toContain('.panel.hidden')
    expect(js).toMatch(/if \(!m \|\| !m\.active\) \{\s*document\.body\.classList\.remove\('mission-mode'\);\s*document\.getElementById\('panelMission'\)\.classList\.add\('hidden'\);/)
    expect(js).toContain("if (!data || !data.campaigns || !data.campaigns.length) { panel.classList.add('hidden'); return; }")
    // between waves no campaign is active, and the panel must still show
    expect(js).not.toContain('!data.active || !data.campaigns')
  })

  function seedHarness(stateIn: Record<string, any>, projectsState: Record<string, any> = { names: {}, active: null }) {
    const els: Record<string, any> = {}
    const el = (id: string) => (els[id] ??= { textContent: '', cls: new Set<string>(['hidden']),
      classList: { add(c: string) { els[id].cls.add(c) }, remove(c: string) { els[id].cls.delete(c) } } })
    const seed = new Function('document', 'state', 'projectsState',
      fnSource('seedSessionCounters') + fnSource('showConnProject') + '\nreturn seedSessionCounters;')
    const run = seed({ getElementById: el }, stateIn, projectsState)
    return { run, el, state: stateIn }
  }

  it('a reload seeds Turns, the context gauge and the Project row', () => {
    const h = seedHarness({ turnCount: 0, context: null })
    h.run({ turns: 4, contextUsed: 16384, contextLength: 65536, project: { slug: 'yard', chat: 'c.jsonl', title: 'Diorama' } })
    expect(h.state.turnCount).toBe(4)
    expect(h.state.context).toEqual({ estimatedTokens: 16384, contextLength: 65536, utilization: 0.25, action: 'proceed' })
    expect(h.el('connProject').textContent).toBe('yard › Diorama')
    expect(h.el('connProjectRow').cls.has('hidden')).toBe(false)
    expect(h.el('chatProjectLabel').textContent).toBe('Project: yard › Diorama')
    expect(h.el('chatProjectStrip').cls.has('visible')).toBe(true)
  })

  it('unmeasured context leaves the gauge empty; a live context.status is never overwritten; no project hides the row', () => {
    const h = seedHarness({ turnCount: 9, context: null })
    h.run({ turns: 2, contextUsed: null, contextLength: 65536, project: null })
    expect(h.state.turnCount).toBe(9)
    expect(h.state.context).toBeNull()
    expect(h.el('connProjectRow').cls.has('hidden')).toBe(true)
    const live = { estimatedTokens: 1, contextLength: 2, utilization: 0.5, action: 'proceed' }
    const h2 = seedHarness({ turnCount: 0, context: live })
    h2.run({ turns: 1, contextUsed: 500, contextLength: 65536, project: null })
    expect(h2.state.context).toBe(live)
  })
})
