/**
 * The Projects view on the 9161 page (projects mode, Task 9).
 *
 * The page has no DOM harness, so this is a string-level check on the page the
 * server actually SERVES (`GET /`, token injected) — the ids, functions, event
 * cases, routes and the responsive block the view is built from. A view that
 * loses one of these still serves 200 and still renders its shell, so nothing
 * downstream would notice. `dashboardScriptParses.test.ts` checks the script
 * parses; `eventCoverage.test.ts` checks the older event cases survive.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const _tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-projects-view-'))
const _tokens = loadOrCreateTokens(_tokenDir)
const _ADMIN = _tokens.tokenFor('management')!
process.on('exit', () => rmSync(_tokenDir, { recursive: true, force: true }))

function authFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${_ADMIN}` } })
}

let server: DashboardServer
let html = ''

beforeAll(async () => {
  server = new DashboardServer({ port: 0, tokens: _tokens })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const port = server.getPort()
    if (port > 0) {
      try { await authFetch(`http://localhost:${port}/`); break } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 10))
  }
  const res = await authFetch(`http://localhost:${server.getPort()}/`)
  expect(res.status).toBe(200)
  html = await res.text()
})

afterAll(() => { server.stop() })

/** Every inline <script> body, joined — event names must live in script, not prose. */
function scripts(): string {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[2])
  return out.join('\n')
}

const IDS = [
  'tab-projects', 'projectsSearch', 'projectsSearchResults', 'projectsList', 'projectNewForm',
  'projectView', 'projectInstructions', 'projectTabs', 'projectSearch', 'knowledgePaste',
  'knowledgeUpload', 'knowledgeList', 'artifactsList', 'planView', 'historyList',
  'projectChats', 'projectChatOpen', 'chatCitations',
]

describe('dashboard: the Projects view', () => {
  it('has a Projects tab button', () => {
    expect(html).toMatch(/<button class="tab-btn"[^>]*onclick="switchTab\('projects'\)"[^>]*>Projects<\/button>/)
  })

  for (const id of IDS) {
    it(`has #${id}`, () => {
      expect(html).toContain(`id="${id}"`)
    })
  }

  it('has the five project tabs', () => {
    for (const t of ['chats', 'knowledge', 'artifacts', 'plan', 'history']) {
      expect(html).toContain(`data-ptab="${t}"`)
    }
  })

  it('defines the view functions', () => {
    const js = scripts()
    for (const fn of ['projectsRoute', 'openProject', 'openProjectChat', 'leaveProject', 'saveAsArtifact']) {
      expect(js).toContain(`function ${fn}(`)
    }
    expect(js).toContain("addEventListener('hashchange', projectsRoute)")
  })

  it('handles the three project events inside a <script>', () => {
    const js = scripts()
    for (const t of ['project.opened', 'project.citations', 'project.ingest']) {
      expect(js).toContain(`case '${t}'`)
    }
  })

  it('opens and leaves a project over the socket', () => {
    const js = scripts()
    expect(js).toContain("type: 'project.open'")
    expect(js).toContain('slug: null')
    expect(js).toContain('using SaveArtifact.')
  })

  /** One top-level `function name(` … `}` from the served script, as source. */
  function fnSource(name: string): string {
    const js = scripts()
    const start = js.indexOf(`function ${name}(`)
    expect(start, `function ${name} not found`).toBeGreaterThan(-1)
    const close = /\r?\n\}\r?\n/.exec(js.slice(start))
    expect(close).not.toBeNull()
    return js.slice(start, start + close!.index + close![0].length)
  }

  /** openProjectChat + renderTranscript run against stubs; returns what it sent, drew and fetched. */
  function openHarness(transcript: unknown | Error) {
    const sent: Record<string, unknown>[] = []
    const drawn: string[] = []
    const fetched: string[] = []
    const run = new Function('ws', 'projectsState', 'projStatus', 'appendChatMsg', 'appendChatTool', 'switchTab',
      'clearChatPane', 'projFetch', 'projUrl', 'summarizeInput',
      fnSource('openProjectChat') + fnSource('renderTranscript') + '\nreturn openProjectChat;')
    const open = run(
      { readyState: 1, send: (s: string) => { drawn.push('SEND'); sent.push(JSON.parse(s)) } },
      { names: {} },
      () => {},
      (role: string, text: string) => drawn.push(`${role}: ${text}`),
      (name: string, _t: string, status: string) => drawn.push(`tool ${name} ${status}`),
      () => {},
      () => drawn.push('CLEAR'),
      (path: string) => { fetched.push(path); return transcript instanceof Error ? Promise.reject(transcript) : Promise.resolve(transcript) },
      (slug: string) => '/api/projects/' + encodeURIComponent(slug),
      () => '',
    )
    return { open, sent, drawn, fetched }
  }

  it('a new chat omits `chat` from the project.open frame (the command schema refuses chat: null)', () => {
    // Found in the hand check: `chat: null` was refused as "chat must be a
    // transcript file name", and the next message went to the coding session.
    const h = openHarness({ messages: [] })
    h.open('harbor', null)
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'harbor' }])
    expect(h.fetched).toEqual([])
  })

  it('reopening a chat fetches its transcript and draws it BEFORE sending project.open', async () => {
    expect(scripts()).toContain("projUrl(slug) + '/chats/' + encodeURIComponent(file)")
    const h = openHarness({
      header: { kind: 'chat', title: 'Crane' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What colour is the crane?' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'tool_use', id: 't1', name: 'ProjectSearch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'rust red', is_error: false }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Rust red [1].' }] },
      ],
    })
    await h.open('harbor', '2026-10-06-chat.jsonl')
    expect(h.fetched).toEqual(['/api/projects/harbor/chats/2026-10-06-chat.jsonl'])
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'harbor', chat: '2026-10-06-chat.jsonl' }])
    const after = h.drawn.slice(h.drawn.lastIndexOf('CLEAR') + 1)
    expect(after).toEqual(['user: What colour is the crane?', 'tool ProjectSearch success', 'assistant: Rust red [1].', 'SEND'])
  })

  it('a transcript that will not load is said so, and the chat still opens', async () => {
    const h = openHarness(new Error('no such chat'))
    await h.open('harbor', 'ghost.jsonl')
    expect(h.drawn).toContain('system: Could not load the earlier messages of ghost.jsonl: no such chat')
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'harbor', chat: 'ghost.jsonl' }])
  })

  it('calls the project routes', () => {
    const js = scripts()
    expect(js).toContain('/api/project-search?q=')
    expect(js).toContain('/api/projects')
    for (const part of ['/knowledge', '/artifacts/', '/promote', '/chats', '/rescan', '/search?q=']) {
      expect(js).toContain(part)
    }
  })

  it('names a file that was kept but not indexed', () => {
    expect(html).toContain('kept but not indexed')
  })

  it('is responsive: the first @media block collapses at 720px', () => {
    const first = html.indexOf('@media')
    expect(first).toBeGreaterThan(-1)
    expect(html.slice(first, first + '@media (max-width: 720px)'.length)).toBe('@media (max-width: 720px)')
    const block = html.slice(first, html.indexOf('</style>', first))
    expect(block).toContain('flex-wrap: wrap')
    expect(block).toContain('grid-template-columns: 1fr')
    expect(block).toContain('font-size: 14px')
  })

  it('has no empty catch in the projects script', () => {
    const js = scripts()
    const start = js.indexOf('Projects view (projects mode)')
    expect(start).toBeGreaterThan(-1)
    expect(js.slice(start)).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/)
  })

  it("leaves eventCoverage's MUST_RENDER list untouched", () => {
    const guard = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'eventCoverage.test.ts'), 'utf-8')
    for (const t of ['session.ready', 'tool.start', 'tool.complete', 'file.diff', 'approval.request', 'governance.status', 'context.status']) {
      expect(guard).toContain(`'${t}',`)
      expect(html).toContain(`case '${t}'`)
    }
  })
})
