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
      'clearChatPane', 'projFetch', 'projUrl', 'summarizeInput', 'genuiPruneImages',
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
      () => drawn.push('PRUNE'),
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
    // the pictures the redraw no longer shows are freed after it, before the engine is bound
    expect(after).toEqual(['user: What colour is the crane?', 'tool ProjectSearch success', 'assistant: Rust red [1].', 'PRUNE', 'SEND'])
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
      'loadProjectChats', 'markSaveableReplies', 'showConnProject', 'clearChatPane', 'genuiPruneImages',
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
      (path: string) => {
        fetched.push(path)
        if (typeof transcript === 'function') return (transcript as (p: string) => Promise<unknown>)(path)
        return transcript instanceof Error ? Promise.reject(transcript) : Promise.resolve(transcript)
      },
      (slug: string) => '/api/projects/' + encodeURIComponent(slug),
      () => {}, () => {}, () => {}, () => {},
      () => { msgs.innerHTML = '' },
      () => {},
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

  it('a late transcript fetch loses to a newer frame (openedSeq)', async () => {
    const pending: Record<string, (t: unknown) => void> = {}
    const h = openedHarness((path: string) => new Promise(res => { pending[path] = res }))
    const first = h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'old.jsonl', title: 'Old' })
    const second = h.onOpened({ type: 'project.opened', slug: 'yard', chat: 'new.jsonl', title: 'New' })
    pending['/api/projects/yard/chats/new.jsonl']({ messages: [{ role: 'user', content: [{ type: 'text', text: 'new chat turn' }] }] })
    await second
    pending['/api/projects/yard/chats/old.jsonl']({ messages: [{ role: 'user', content: [{ type: 'text', text: 'old chat turn' }] }] })
    await first
    expect(h.pane()).toEqual(['user: new chat turn', 'system: Opened Front Yard › New'])
    expect(h.projectsState.renderedChat).toBe('yard/new.jsonl')
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
    const projectsState: Record<string, any> = { active: null, paths: { harbor: 'C:/projects/harbor' }, names: {}, codingCwd: null, reconciled: true }
    const make = new Function('document', 'ws', 'projectsState', 'appendChatMsg', 'brainViz', 'fetch', 'clearChatCitations',
      fnSource('sendChatMessage') + fnSource('showProjectCwd') + fnSource('restoreCodingCwd') + fnSource('projectChatUnsettled') +
      '\nreturn { sendChatMessage: sendChatMessage, showProjectCwd: showProjectCwd, restoreCodingCwd: restoreCodingCwd };')
    const page = make(
      { getElementById: (id: string) => (id === 'chatCwd' ? box : input) },
      { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) },
      projectsState,
      () => {},
      { setActive: () => {} },
      (path: string) => { fetched.push(path); return Promise.resolve({ json: () => ({ projectPath: 'C:/code/launch' }) }) },
      () => {},
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

/**
 * The project chat after an engine restart (dashboard transcript, 2026-10-11).
 *
 * The page kept a project pane (strip, "Save as artifact" links) across an
 * engine restart. The restarted engine held no project, so the server sent no
 * project.opened on connect (server.ts, websocket open), fetchSessionState read
 * /api/session and ignored its `project: null`, and the next message — sent
 * with no cwd because projectsState.active was still set — went to the CODING
 * session: no project memory, no project tools, no pictures. The page now
 * reconciles its pane with the engine's binding on every connect.
 */
describe('dashboard: the project chat re-binds after an engine restart', () => {
  const ACTIVE = { slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' }
  const OTHER = { slug: 'yard', chat: 'c2.jsonl', title: 'Crane' }
  const SESSION = { model: 'qwen.gguf', contextLength: 65536, tier: 'advanced', projectPath: 'C:/code/launch' }
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)) }

  function fnSource(name: string): string {
    const js = scripts()
    const start = js.indexOf(`function ${name}(`)
    expect(start, `function ${name} not found`).toBeGreaterThan(-1)
    const close = /\r?\n\}\r?\n/.exec(js.slice(start))
    expect(close).not.toBeNull()
    return js.slice(start, start + close!.index + close![0].length)
  }

  /**
   * connectWS + fetchSessionState + the project handlers against stubs. The
   * socket is a stub whose `onopen` the test fires; /api/session answers what
   * `session()` resolves to (one call per read, so a test can hold an answer
   * back); every socket send, pane line, route fetched and warning is recorded.
   */
  function harness(session: () => Promise<unknown>, state0: Record<string, any> = {}, transcripts: Record<string, unknown> = {}) {
    const sent: Record<string, unknown>[] = []
    const fetched: string[] = []
    const warned: string[] = []
    const replaced: string[] = []
    const els: Record<string, any> = {}
    const el = (id: string) => (els[id] ??= {
      textContent: '', value: '', readOnly: false, title: '', cls: new Set<string>(),
      classList: { add(c: string) { els[id].cls.add(c) }, remove(c: string) { els[id].cls.delete(c) }, contains(c: string) { return els[id].cls.has(c) } },
    })
    const children: any[] = []
    const msgs: any = {
      get children() { return children },
      set innerHTML(_v: string) { children.length = 0 },
      removeChild: (n: any) => { children.splice(children.indexOf(n), 1); n.parentNode = null },
      appendChild: (n: any) => { const i = children.indexOf(n); if (i >= 0) children.splice(i, 1); children.push(n); n.parentNode = msgs },
    }
    const put = (text: string) => msgs.appendChild({ text })
    const projectsState: Record<string, any> = {
      active: null, renderedChat: null, openedSeq: 0, names: { yard: 'Front Yard' }, paths: { yard: 'C:/p/yard' }, slug: null,
      codingCwd: null, replyCount: 0, connectSeq: 0, reconciled: true, rebind: null, ...state0,
    }
    const state: Record<string, any> = { connected: false, turnCount: 0, context: null, model: '', tier: '' }
    let sock: any = null
    function WebSocketStub(this: any, url: string) {
      this.url = url; this.readyState = 1; this.send = (s: string) => sent.push(JSON.parse(s)); sock = this
    }
    const fetchStub = (path: string) => {
      fetched.push(path)
      if (path === '/api/session') return session().then(data => ({ json: () => data }))
      return Promise.resolve({ json: () => null })
    }
    const make = new Function('WebSocket', 'location', 'window', 'document', 'state', 'projectsState', 'fetch', 'setInterval',
      'setTimeout', 'render', 'genuiRecheckImages', 'handleEvent', 'appendChatMsg', 'appendChatTool', 'summarizeInput', 'setSlider',
      'activateSession', 'clearChatCitations', 'parseProjectsHash', 'history', 'projFetch', 'projUrl', 'projStatus', 'loadProjectChats',
      'markSaveableReplies', 'clearChatPane', 'genuiPruneImages', 'brainViz', 'console',
      'fetchPredictions', 'fetchContracts', 'fetchTrainingData', 'renderToolFeed', 'renderSubsystems', 'escHtml',
      'var ws = null; var reconnectDelay = 1000;\n' +
      fnSource('connectWS') + fnSource('fetchSessionState') + fnSource('reconcileProjectBinding') + fnSource('onProjectOpened') +
      fnSource('onProjectOpenRefused') + fnSource('projectChatUnsettled') + fnSource('fetchTranscript') + fnSource('renderTranscript') +
      fnSource('sendChatMessage') + fnSource('showProjectCwd') + fnSource('restoreCodingCwd') + fnSource('setCodingCwd') +
      fnSource('seedSessionCounters') + fnSource('showConnProject') +
      '\nreturn { connect: function() { connectWS(); return ws; }, onProjectOpened: onProjectOpened, onProjectOpenRefused: onProjectOpenRefused,' +
      ' sendChatMessage: sendChatMessage, fetchSessionState: fetchSessionState };')
    const page = make(
      WebSocketStub, { protocol: 'http:', hostname: 'localhost', port: '9161' }, { __CYNCO_TOKEN: 't' },
      { getElementById: (id: string) => (id === 'chatMessages' ? msgs : el(id)), body: el('body') },
      state, projectsState, fetchStub, () => 0, () => 0, () => {}, () => {}, () => {},
      (role: string, text: string) => put(`${role}: ${text}`),
      (name: string) => { put(`tool ${name}`); return 'row' },
      () => '', () => {}, () => {}, () => {}, () => null,
      { replaceState: (_a: unknown, _b: string, h: string) => replaced.push(h) },
      (path: string) => {
        fetched.push(path)
        return path in transcripts ? Promise.resolve(transcripts[path]) : Promise.reject(new Error('no route ' + path))
      },
      (slug: string) => '/api/projects/' + encodeURIComponent(slug),
      () => {}, () => {}, () => {}, () => { msgs.innerHTML = '' }, () => {}, { setActive: () => {} },
      { warn: (m: string) => warned.push(m), log: () => {} },
      () => {}, () => {}, () => {}, () => {}, () => {}, (t: string) => String(t),
    )
    const pane = () => children.map(c => c.text)
    /** A restart the page lived through: the socket (re)opens and /api/session is read. */
    const reconnect = () => { const s = page.connect(); s.onopen(); return s }
    const say = (text: string) => { el('chatInput').value = text; page.sendChatMessage() }
    return { ...page, reconnect, say, sent, fetched, warned, replaced, pane, put, el, projectsState, state, get sock() { return sock } }
  }

  /**
   * The transcript, replayed with only the functions HEAD had: the pane shows a
   * project chat, the socket reopens on a restarted engine (/api/session says
   * `project: null`, no project.opened frame), the operator types. The frame
   * that goes out must be a project.open for the chat shown — not a bare
   * user.message, which main.ts hands to the coding loop.
   */
  it('REPRO: after a restart the typed message must not go to the coding loop as a project turn', async () => {
    const js = scripts()
    const optional = (name: string) => (js.indexOf(`function ${name}(`) >= 0 ? fnSource(name) : '')
    const sent: Record<string, unknown>[] = []
    const lines: string[] = []
    const els: Record<string, any> = {}
    const el = (id: string) => (els[id] ??= { textContent: '', value: '', readOnly: true, cls: new Set<string>(),
      classList: { add(c: string) { els[id].cls.add(c) }, remove(c: string) { els[id].cls.delete(c) }, contains(c: string) { return els[id].cls.has(c) } } })
    let sock: any = null
    function WebSocketStub(this: any) { this.readyState = 1; this.send = (s: string) => sent.push(JSON.parse(s)); sock = this }
    const projectsState: Record<string, any> = { active: { ...ACTIVE }, renderedChat: 'yard/c1.jsonl', names: {}, paths: {}, codingCwd: 'C:/code/launch', connectSeq: 0, reconciled: true, rebind: null }
    const make = new Function('WebSocket', 'location', 'window', 'document', 'state', 'projectsState', 'fetch', 'setInterval', 'setTimeout',
      'render', 'genuiRecheckImages', 'handleEvent', 'appendChatMsg', 'setSlider', 'activateSession', 'clearChatCitations', 'brainViz', 'console',
      'fetchPredictions', 'fetchContracts', 'fetchTrainingData', 'renderToolFeed', 'renderSubsystems', 'escHtml',
      'var ws = null; var reconnectDelay = 1000;\n' + fnSource('connectWS') + fnSource('fetchSessionState') + fnSource('sendChatMessage') +
      fnSource('seedSessionCounters') + fnSource('showConnProject') + fnSource('setCodingCwd') +
      optional('reconcileProjectBinding') + optional('projectChatUnsettled') +
      '\nconnectWS(); return { ws: ws, sendChatMessage: sendChatMessage };')
    const page = make(WebSocketStub, { protocol: 'http:', hostname: 'localhost', port: '9161' }, { __CYNCO_TOKEN: 't' },
      { getElementById: el, body: el('body') }, { connected: false, turnCount: 0, context: null }, projectsState,
      (path: string) => Promise.resolve({ json: () => (path === '/api/session' ? { ...SESSION, project: null } : null) }),
      () => 0, () => 0, () => {}, () => {}, () => {}, (role: string, text: string) => lines.push(`${role}: ${text}`),
      () => {}, () => {}, () => {}, { setActive: () => {} }, { warn: () => {}, log: () => {} },
      () => {}, () => {}, () => {}, () => {}, () => {}, (t: string) => String(t))
    el('chatCwd').value = 'C:/p/yard'
    sock.onopen()
    await flush()
    el('chatInput').value = 'It looks like the design images for the towers did not come through. try again so I can actually see these proposals'
    page.sendChatMessage()
    const userMessages = sent.filter(f => f.type === 'user.message')
    expect(userMessages, `a user.message with no cwd and no project bound is a coding turn: ${JSON.stringify(sent)}`).toEqual([])
    expect(sent).toEqual([{ type: 'project.open', slug: 'yard', chat: 'c1.jsonl' }])
    expect(lines).toContain('system: Engine restarted — reopening project chat yard › Diorama')
  })

  /** The page as the operator had it: a bound chat, drawn, the CWD box holding the project folder. */
  const boundPane = (extra: Record<string, any> = {}) => ({ active: { ...ACTIVE }, renderedChat: 'yard/c1.jsonl', codingCwd: 'C:/code/launch', ...extra })
  const withProject = (project: unknown) => () => Promise.resolve({ ...SESSION, project })

  it('the engine lost the project: project.open {slug, chat} once, the line says so, and the answer settles the pane', async () => {
    const h = harness(withProject(null), boundPane())
    h.el('chatCwd').value = 'C:/p/yard'; h.el('chatCwd').readOnly = true
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'yard', chat: 'c1.jsonl' }])
    expect(h.pane()).toEqual(['system: Engine restarted — reopening project chat Front Yard › Diorama'])
    expect(h.projectsState.active).toEqual(ACTIVE)
    // a second read of /api/session on the same connect sends nothing more
    h.fetchSessionState()
    await flush()
    expect(h.sent).toHaveLength(1)
    // until the engine answers, the pane is not a project chat to type into
    h.say('too early')
    expect(h.sent).toHaveLength(1)
    // the engine reloaded the transcript and answered: the chat shown, label only, and typing works again
    await h.onProjectOpened({ type: 'project.opened', ...ACTIVE })
    expect(h.el('chatProjectLabel').textContent).toBe('Project: Front Yard › Diorama')
    expect(h.projectsState.rebind).toBeNull()
    h.say('now the towers')
    expect(h.sent[1]).toEqual({ type: 'user.message', text: 'now the towers' })
    expect(h.sent).toHaveLength(2)
  })

  it('a new unnamed chat is reopened without `chat` (the command schema refuses chat: null)', async () => {
    const h = harness(withProject(null), boundPane({ active: { slug: 'yard', chat: null, title: null }, renderedChat: null }))
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'yard' }])
    expect(h.pane()).toEqual(['system: Engine restarted — reopening project chat Front Yard › new chat'])
  })

  it('the engine still holds the chat shown: nothing is sent, whichever answer lands first', async () => {
    // the on-connect frame first, then /api/session
    const a = harness(withProject(ACTIVE), boundPane())
    a.reconnect()
    await a.onProjectOpened({ type: 'project.opened', ...ACTIVE })
    await flush()
    expect(a.sent).toEqual([])
    a.say('still here?')
    expect(a.sent).toEqual([{ type: 'user.message', text: 'still here?' }])
    // /api/session first, then the frame
    const b = harness(withProject(ACTIVE), boundPane())
    b.reconnect()
    await flush()
    expect(b.sent).toEqual([])
    b.say('still here?')
    expect(b.sent).toEqual([{ type: 'user.message', text: 'still here?' }])
    await b.onProjectOpened({ type: 'project.opened', ...ACTIVE })
    expect(b.sent).toHaveLength(1)
    expect(b.pane()).toEqual(['user: still here?'])
  })

  it('a frame that landed first wins over a late /api/session null: no re-open is sent', async () => {
    let answer: (d: unknown) => void = () => {}
    const h = harness(() => new Promise(res => { answer = res }), boundPane())
    h.reconnect()
    await h.onProjectOpened({ type: 'project.opened', ...ACTIVE })
    answer({ ...SESSION, project: null })
    await flush()
    expect(h.sent).toEqual([])
    expect(h.pane()).toEqual([])
  })

  it('the engine holds another chat: nothing is sent, its frame redraws the pane, typing waits for the frame', async () => {
    const h = harness(withProject(OTHER), boundPane(), {
      '/api/projects/yard/chats/c2.jsonl': { messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is the crane?' }] }] },
    })
    h.put('assistant: the towers, drawn before the restart')
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([])
    h.say('too early')
    expect(h.sent).toEqual([])
    expect(h.pane()).toContain('system: Reconnecting the project chat — try again in a moment.')
    expect(h.el('chatInput').value).toBe('too early')
    await h.onProjectOpened({ type: 'project.opened', ...OTHER })
    expect(h.pane()).toEqual(['user: What colour is the crane?', 'system: Opened Front Yard › Crane'])
    expect(h.projectsState.active).toEqual(OTHER)
    h.say('and now?')
    expect(h.sent).toEqual([{ type: 'user.message', text: 'and now?' }])
  })

  it('a message typed while the binding is unsettled is never sent to the coding loop', async () => {
    let answer: (d: unknown) => void = () => {}
    const h = harness(() => new Promise(res => { answer = res }), boundPane())
    h.reconnect()
    h.say('It looks like the design images for the towers did not come through. try again')
    expect(h.sent).toEqual([])
    expect(h.pane()).toEqual(['system: Reconnecting the project chat — try again in a moment.'])
    expect(h.el('chatInput').value).toBe('It looks like the design images for the towers did not come through. try again')
    answer({ ...SESSION, project: null })
    await flush()
    // the re-open went out; the typed text did not
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'yard', chat: 'c1.jsonl' }])
  })

  it('the re-open refused: the pane stops pretending — strip hidden, coding cwd back, said so, the next message is a coding turn', async () => {
    const h = harness(withProject(null), boundPane())
    h.el('chatCwd').value = 'C:/p/yard'; h.el('chatCwd').readOnly = true
    h.el('chatProjectStrip').classList.add('visible')
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'yard', chat: 'c1.jsonl' }])
    h.onProjectOpenRefused('project.open refused: chat c1.jsonl not found')
    expect(h.projectsState.active).toBeNull()
    expect(h.projectsState.rebind).toBeNull()
    expect(h.el('chatProjectStrip').classList.contains('visible')).toBe(false)
    expect(h.el('chatCwd').readOnly).toBe(false)
    const said = h.pane().filter(l => l.indexOf('system: Could not reopen project chat Front Yard › Diorama') === 0)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('project.open refused: chat c1.jsonl not found')
    expect(said[0]).toContain('coding session')
    await flush()
    expect(h.el('chatCwd').value).toBe('C:/code/launch')
    h.say('where am I?')
    expect(h.sent[1]).toEqual({ type: 'user.message', text: 'where am I?', cwd: 'C:/code/launch' })
  })

  it('a refusal with no re-open pending (another tab\'s project.open) leaves the pane alone', () => {
    const h = harness(withProject(null), boundPane())
    h.onProjectOpenRefused('project.open refused: no such project')
    expect(h.projectsState.active).toEqual(ACTIVE)
    expect(h.pane()).toEqual([])
    // and a session.error that is not about project.open never touches a pending re-open
    h.projectsState.rebind = { seq: 1, slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' }
    h.projectsState.reconciled = false
    h.onProjectOpenRefused('command frame refused: frame is not valid JSON')
    expect(h.projectsState.rebind).not.toBeNull()
    expect(h.projectsState.active).toEqual(ACTIVE)
  })

  it('a stale /api/session answer from the previous connect reconciles nothing (connectSeq)', async () => {
    const answers: Array<(d: unknown) => void> = []
    const h = harness(() => new Promise(res => { answers.push(res) }), boundPane())
    h.reconnect()
    h.reconnect()
    expect(answers).toHaveLength(2)
    answers[0]({ ...SESSION, project: null })
    await flush()
    expect(h.sent).toEqual([])
    answers[1]({ ...SESSION, project: null })
    await flush()
    expect(h.sent).toEqual([{ type: 'project.open', slug: 'yard', chat: 'c1.jsonl' }])
  })

  it('/api/session unreachable: nothing is sent, the pane says it is not reconnected, and typing is refused', async () => {
    const h = harness(() => Promise.reject(new Error('boom')), boundPane())
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([])
    expect(h.pane().some(l => l.indexOf('system: Could not check which chat the engine holds') === 0 && l.indexOf('boom') > 0)).toBe(true)
    h.say('hello?')
    expect(h.sent).toEqual([])
  })

  it('a pane showing the coding session has nothing to reconcile', async () => {
    const h = harness(withProject(null), { active: null })
    h.reconnect()
    await flush()
    expect(h.sent).toEqual([])
    h.el('chatCwd').value = 'C:/code/launch'
    h.say('coding')
    expect(h.sent).toEqual([{ type: 'user.message', text: 'coding', cwd: 'C:/code/launch' }])
  })

  it('the wiring, as text: onopen opens a connect, fetchSessionState reads data.project, session.error reaches the refusal, the sends gate', () => {
    const js = scripts()
    const onopen = js.slice(js.indexOf('ws.onopen = function()'), js.indexOf('ws.onclose'))
    expect(onopen).toContain('projectsState.connectSeq++')
    expect(onopen).toContain('projectsState.reconciled = !projectsState.active')
    expect(fnSource('fetchSessionState')).toContain('data.project')
    expect(fnSource('fetchSessionState')).toContain('reconcileProjectBinding(seq, ')
    const arm = js.slice(js.indexOf("case 'session.error':"), js.indexOf("case 'ui.render':"))
    expect(arm).toContain('onProjectOpenRefused(event.error)')
    expect(fnSource('reconcileProjectBinding')).toContain("type: 'project.open'")
    expect(fnSource('onProjectOpened')).not.toContain('ws.send')
    expect(fnSource('onProjectOpened')).toContain('projectsState.reconciled = true')
    for (const fn of ['sendChatMessage', 'saveAsArtifact', 'showReplyAsUi']) expect(fnSource(fn)).toContain('projectChatUnsettled()')
  })
})
