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
      fnSource('openProjectChat') + fnSource('fetchTranscript') + fnSource('renderTranscript') + '\nreturn openProjectChat;')
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

  /**
   * onProjectOpened against a stub pane: `pane` is the #chatMessages node list
   * as text, `sent` every socket send, `fetched` every route asked for.
   */
  function openedHarness(transcript: unknown | Error, state: Record<string, any> = {}) {
    const sent: string[] = []
    const fetched: string[] = []
    const replaced: string[] = []
    const children: any[] = []
    const msgs: any = {
      get children() { return children },
      set innerHTML(_v: string) { children.length = 0 },
      removeChild: (n: any) => { children.splice(children.indexOf(n), 1); n.parentNode = null },
      appendChild: (n: any) => { const i = children.indexOf(n); if (i >= 0) children.splice(i, 1); children.push(n); n.parentNode = msgs },
    }
    const strip = { classList: { add: () => {}, remove: () => {} } }
    const label = { textContent: '' }
    const put = (text: string) => msgs.appendChild({ text })
    const projectsState: Record<string, any> = { active: null, renderedChat: null, openedSeq: 0, names: { yard: 'Front Yard' }, paths: { yard: 'C:/p/yard' }, slug: null, ...state }
    const make = new Function('document', 'ws', 'projectsState', 'clearChatCitations', 'restoreCodingCwd', 'appendChatMsg',
      'appendChatTool', 'summarizeInput', 'parseProjectsHash', 'history', 'showProjectCwd', 'projFetch', 'projUrl', 'projStatus',
      'loadProjectChats', 'markSaveableReplies',
      fnSource('onProjectOpened') + fnSource('fetchTranscript') + fnSource('renderTranscript') + '\nreturn onProjectOpened;')
    const onOpened = make(
      { getElementById: (id: string) => (id === 'chatMessages' ? msgs : id === 'chatProjectStrip' ? strip : label) },
      { readyState: 1, send: (s: string) => sent.push(s) },
      projectsState,
      () => {}, () => {},
      (role: string, text: string) => put(`${role}: ${text}`),
      (name: string) => put(`tool ${name}`),
      () => '',
      () => null,
      { replaceState: (_a: unknown, _b: string, h: string) => replaced.push(h) },
      () => {},
      (path: string) => { fetched.push(path); return transcript instanceof Error ? Promise.reject(transcript) : Promise.resolve(transcript) },
      (slug: string) => '/api/projects/' + encodeURIComponent(slug),
      () => {}, () => {}, () => {},
    )
    const pane = () => children.map(c => c.text)
    return { onOpened, sent, fetched, replaced, put, pane, projectsState, label }
  }

  const YARD = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Plan a diorama of my front yard.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'What scale?' }] },
    ],
  }

  it('a reload into a bound chat fetches the transcript and draws its turns, then the Opened line (fix-1 B)', async () => {
    const h = openedHarness(YARD)
    h.put('system: left over from the coding session')
    const p = h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' })
    h.put('assistant: (streamed while the transcript loaded)')
    await p
    expect(h.fetched).toEqual(['/api/projects/yard/chats/c1.jsonl'])
    expect(h.pane()).toEqual([
      'user: Plan a diorama of my front yard.',
      'assistant: What scale?',
      'system: Opened Front Yard › Diorama',
      'assistant: (streamed while the transcript loaded)',
    ])
    expect(h.projectsState.renderedChat).toBe('yard/c1.jsonl')
    expect(h.replaced).toEqual(['#projects/yard/chat/c1.jsonl'])
    expect(h.sent).toEqual([])
  })

  it('a second identical frame (a reconnect of the same page) is a no-op but the strip label', async () => {
    const h = openedHarness(YARD)
    await h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' })
    const before = h.pane()
    await h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama v2' })
    expect(h.pane()).toEqual(before)
    expect(h.fetched).toHaveLength(1)
    expect(h.label.textContent).toBe('Project: Front Yard › Diorama v2')
    expect(h.projectsState.active).toEqual({ slug: 'yard', chat: 'c1.jsonl', title: 'Diorama v2' })
    expect(h.sent).toEqual([])
  })

  it('a chat openProjectChat already drew is kept, not fetched again', async () => {
    const h = openedHarness(YARD, { renderedChat: 'yard/c1.jsonl' })
    h.put('user: drawn by openProjectChat')
    await h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' })
    expect(h.fetched).toEqual([])
    expect(h.pane()).toEqual(['user: drawn by openProjectChat', 'system: Opened Front Yard › Diorama'])
  })

  it('a new chat keeps today\'s behaviour: a fresh pane and one Opened line', async () => {
    const h = openedHarness(YARD)
    h.put('system: old')
    await h.onOpened({ type: 'project.opened', slug: 'yard', chat: null, title: null })
    expect(h.fetched).toEqual([])
    expect(h.pane()).toEqual(['system: Opened Front Yard › new chat'])
  })

  it('a transcript that will not load on connect is said so', async () => {
    const h = openedHarness(new Error('gone'))
    await h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' })
    expect(h.pane()).toEqual(['system: Could not load the earlier messages of c1.jsonl: gone', 'system: Opened Front Yard › Diorama (c1.jsonl)'])
    expect(h.projectsState.renderedChat).toBe(null)
  })

  it('onProjectOpened never sends on the socket (an on-connect frame must not become a project.open)', () => {
    expect(fnSource('onProjectOpened')).not.toContain('ws.send')
    expect(fnSource('onProjectOpened')).toContain('history.replaceState')
  })

  it('while a project is bound the CWD box shows the project folder read-only and user.message carries no cwd (final review M7)', async () => {
    const box = { value: 'C:/code/launch', readOnly: false, title: '' }
    const input = { value: '' }
    const sent: Record<string, unknown>[] = []
    const fetched: string[] = []
    const projectsState: Record<string, any> = { active: null, paths: { harbor: 'C:/projects/harbor' }, names: {}, codingCwd: null }
    const make = new Function('document', 'ws', 'projectsState', 'appendChatMsg', 'brainViz', 'fetch',
      fnSource('sendChatMessage') + fnSource('showProjectCwd') + fnSource('restoreCodingCwd') +
      '\nreturn { sendChatMessage: sendChatMessage, showProjectCwd: showProjectCwd, restoreCodingCwd: restoreCodingCwd };')
    const page = make(
      { getElementById: (id: string) => (id === 'chatCwd' ? box : input) },
      { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) },
      projectsState,
      () => {},
      { setActive: () => {} },
      (path: string) => { fetched.push(path); return Promise.resolve({ json: () => ({ projectPath: 'C:/code/launch' }) }) },
    )
    const say = (text: string) => { input.value = text; page.sendChatMessage() }

    say('coding question')
    expect(sent.pop()).toEqual({ type: 'user.message', text: 'coding question', cwd: 'C:/code/launch' })

    projectsState.active = { slug: 'harbor', chat: null, title: null }
    page.showProjectCwd('harbor')
    expect(box).toMatchObject({ value: 'C:/projects/harbor', readOnly: true })
    say('project question')
    expect(sent.pop()).toEqual({ type: 'user.message', text: 'project question' })

    projectsState.active = null
    page.restoreCodingCwd()
    expect(box).toMatchObject({ value: 'C:/code/launch', readOnly: false })
    await new Promise(r => setTimeout(r, 0))
    expect(fetched).toEqual(['/api/session'])
    say('back to code')
    expect(sent.pop()).toEqual({ type: 'user.message', text: 'back to code', cwd: 'C:/code/launch' })

    // A page loaded while bound learned the project folder as its cwd; leaving
    // must not send it back as the coding cwd.
    box.value = 'C:/projects/harbor'
    projectsState.active = { slug: 'harbor', chat: null, title: null }
    page.showProjectCwd('harbor')
    projectsState.active = null
    page.restoreCodingCwd()
    expect(box.value).toBe('')

    // the wiring: project.opened drives both, Save-as-artifact never sends a cwd
    expect(fnSource('onProjectOpened')).toContain('showProjectCwd(event.slug)')
    expect(fnSource('onProjectOpened')).toContain('restoreCodingCwd()')
    expect(fnSource('saveAsArtifact')).toContain("JSON.stringify({ type: 'user.message', text: text })")
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
