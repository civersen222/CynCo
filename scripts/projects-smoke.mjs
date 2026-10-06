// scripts/projects-smoke.mjs — a repeatable end-to-end smoke of projects mode
// against a LIVE engine (Task 11 of the projects-mode-core plan).
//
// It drives the dashboard exactly as the page does: the `/api/projects*` and
// `/api/project-search` routes under the dashboard (inference) token, and the
// `/ws` socket with `?token=` for `project.open` and `user.message`. Eleven
// steps, one `[smoke] n/11 PASS|FAIL <step>: <evidence>` line each, exit 1 on
// the first FAIL.
//
// Run it against an engine started on a SCRATCH port and a SCRATCH projects
// home, never the user's 9161 (the dashboard rides the engine):
//
//   LOCALCODE_WS_PORT=19160 LOCALCODE_PROJECTS_HOME=<scratch> bun engine/main.ts
//   LOCALCODE_PROJECTS_HOME=<scratch> bun scripts/projects-smoke.mjs
//
// Environment:
//   PROJECTS_SMOKE_BASE      dashboard base URL (default http://127.0.0.1:19161)
//   LOCALCODE_PROJECTS_HOME  the engine's projects home — step 1 checks the folder there
//   CYNCO_HOME               where tokens.json lives (default ~/.cynco)
//   PROJECTS_SMOKE_CWD       the engine's launch cwd, for step 11 (default: this process's cwd)
//   PROJECTS_SMOKE_TURN_MS   per-turn wait for `message.complete` (default 600000)
//
// No spawn is needed — it is HTTP + WebSocket only. Anything that ever needs one
// takes `runAsync` from ./cynco-spawn.mjs (F155).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOTAL = 11
export const DEFAULT_BASE = 'http://127.0.0.1:19161'
export const DEFAULT_TURN_MS = 10 * 60 * 1000
export const OPEN_TIMEOUT_MS = 10 * 1000

/** The eleven steps, in order; `n` is what the `[smoke] n/11` line prints. */
export const STEPS = [
  { n: 1, name: 'create project' },
  { n: 2, name: 'paste knowledge' },
  { n: 3, name: 'upload pdf' },
  { n: 4, name: 'open project' },
  { n: 5, name: 'chat with citations' },
  { n: 6, name: 'save artifact' },
  { n: 7, name: 'promote artifact' },
  { n: 8, name: 'global search' },
  { n: 9, name: 'project isolation' },
  { n: 10, name: 'download asks' },
  { n: 11, name: 'leave project' },
]

/** What `createProject` lays out (engine/projects/layout.ts) — step 1 checks every entry. */
export const PROJECT_LAYOUT = ['project.json', 'instructions.md', 'knowledge', 'chats', 'artifacts', 'inbox', 'plan.md', 'journal.md', 'knowledge/index.json', 'artifacts/index.json', '.gitignore', '.cynco/index']

/** The cookbook chapter step 2 pastes: four headings, so at least three chunks. */
export const COOKBOOK_CHAPTER = [
  '# Chapter 3: Starters',
  '',
  'This chapter covers starters: the small plates served before the main course.',
  '',
  '## Bruschetta',
  '',
  'Toast thick slices of sourdough, rub them with a cut garlic clove, and top them with diced tomato, basil and olive oil. Serve within ten minutes so the bread stays crisp.',
  '',
  '## Chilled Cucumber Soup',
  '',
  'Blend two cucumbers with yogurt, dill and a squeeze of lemon. Chill for at least an hour and serve in small glasses as a starter on hot days.',
  '',
  '## Stuffed Mushrooms',
  '',
  'Fill button mushroom caps with breadcrumbs, parmesan and parsley, then bake at 200 C for fifteen minutes until golden.',
  '',
].join('\n')

/** The two pages of the generated PDF step 3 uploads. */
export const PDF_PAGES = [
  'Diorama Water Effects Guide. Pour two-part epoxy resin in thin layers for still water.',
  'Curing: each resin layer takes 24 hours to cure at room temperature before the next pour.',
]

export const PROMPTS = {
  ask: 'Which chapter covers starters, and how long does the PDF say resin takes to cure? Cite the passages.',
  save: 'Save that answer as an artifact named smoke-answer.',
  isolate: "Use ProjectSearch for 'resin' in this project only and tell me the exact tool output.",
  download: 'Run this command: curl -s https://example.com',
  cwd: 'What directory are you in?',
}

/** One output line. */
export function smokeLine(n, ok, step, evidence) {
  return `[smoke] ${n}/${TOTAL} ${ok ? 'PASS' : 'FAIL'} ${step}: ${String(evidence).replace(/\s+/g, ' ').trim()}`
}

/** A failed assertion carries its own message; `run` prints it as the FAIL evidence. */
export class SmokeFailure extends Error {}

/** `got` must equal `want`, or the failure names both and a short body. */
export function statusMessage(label, got, want, body) {
  if (got === want) return null
  const b = typeof body === 'string' ? body : JSON.stringify(body)
  return `${label} answered ${got}, expected ${want}${b ? ` — ${b.slice(0, 200)}` : ''}`
}

export function expectStatus(label, got, want, body) {
  const m = statusMessage(label, got, want, body)
  if (m) throw new SmokeFailure(m)
}

/** The dashboard token's secret from `<cyncoHome>/tokens.json`, or a named error. */
export function readDashboardToken(cyncoHome, read = (p) => readFileSync(p, 'utf8')) {
  const p = join(cyncoHome, 'tokens.json')
  let parsed
  try {
    parsed = JSON.parse(read(p))
  } catch (e) {
    throw new Error(`cannot read ${p}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const t = Array.isArray(parsed?.tokens) ? parsed.tokens.find(x => x && x.name === 'dashboard') : undefined
  if (!t || typeof t.secret !== 'string' || !t.secret) throw new Error(`no 'dashboard' token in ${p}`)
  return t.secret
}

/** The layout entries missing under a project folder; empty when the folder is whole. */
export function missingLayout(dir, exists = existsSync) {
  return PROJECT_LAYOUT.filter(rel => !exists(join(dir, rel)))
}

/** Citations whose file is under `knowledge/` — step 5 needs at least one. */
export function knowledgeCitations(citations) {
  return (Array.isArray(citations) ? citations : []).filter(c => c && typeof c.filePath === 'string' && c.filePath.startsWith('knowledge/'))
}

/** Does the reply say the command was refused? */
export function saidDenied(text) {
  return /\b(den(y|ied|ial)|declined|rejected|not approved|wasn'?t approved|was not run|did not run|refused|blocked)\b/i.test(String(text))
}

const norm = (s) => String(s).replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase()

/** Does the reply name `dir` — its full path, or failing that its last segment? */
export function namesDir(text, dir) {
  const t = norm(text), d = norm(dir).replace(/\/+$/, '')
  return t.includes(d) || t.includes(basename(d))
}

/** Does the reply mention any of the project paths/slugs it must not? */
export function namesAnyOf(text, needles) {
  const t = norm(text)
  return needles.filter(n => n && t.includes(norm(n)))
}

/**
 * A search phrase from a reply: the longest run of plain words in one line,
 * markdown, citation marks and punctuation stripped, cut to `maxWords`.
 */
export function phraseFrom(text, maxWords = 8) {
  let best = []
  for (const line of String(text).split(/\r?\n/)) {
    const words = line.replace(/\[\d+\]/g, ' ').replace(/[*_`#>|]/g, ' ').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean)
    if (words.length > best.length) best = words
  }
  return best.slice(0, maxWords).join(' ')
}

/** The reply text of one turn: every `stream.token` between its first event and `message.complete`. */
export function replyText(events) {
  return events.filter(e => e.type === 'stream.token' && typeof e.text === 'string').map(e => e.text).join('')
}

const clip = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

// ─── live run ───────────────────────────────────────────────────────────────

/** A dashboard socket that buffers every frame so a step can wait on what already arrived. */
class Socket {
  constructor(url) {
    this.events = []
    this.waiters = []
    this.onApproval = null
    this.ws = new WebSocket(url)
    this.ws.onmessage = (m) => {
      let ev
      try { ev = JSON.parse(String(m.data)) } catch (e) { console.log(`[smoke] unparsable frame: ${e instanceof Error ? e.message : String(e)}`); return }
      this.events.push(ev)
      if (ev.type === 'approval.request' && this.onApproval) this.onApproval(ev)
      for (const w of [...this.waiters]) w()
    }
  }
  opened() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = (e) => rej(new Error(`websocket error: ${e?.message ?? 'connect failed'}`))
    })
  }
  send(frame) { this.ws.send(JSON.stringify(frame)) }
  /** The first event at index >= `from` matching `pred`, or a timeout naming `what`. */
  waitFor(from, pred, timeoutMs, what) {
    return new Promise((res, rej) => {
      const check = () => {
        const i = this.events.findIndex((e, k) => k >= from && pred(e))
        if (i < 0) return false
        cleanup(); res({ event: this.events[i], index: i }); return true
      }
      const timer = setTimeout(() => { cleanup(); rej(new SmokeFailure(`no ${what} within ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
      const cleanup = () => { clearTimeout(timer); this.waiters = this.waiters.filter(w => w !== check) }
      if (!check()) this.waiters.push(check)
    })
  }
  close() { this.ws.close() }
}

async function main() {
  const base = (process.env.PROJECTS_SMOKE_BASE || DEFAULT_BASE).replace(/\/+$/, '')
  const home = process.env.LOCALCODE_PROJECTS_HOME
  const cyncoHome = process.env.CYNCO_HOME || join(homedir(), '.cynco')
  const launchCwd = resolve(process.env.PROJECTS_SMOKE_CWD || process.cwd())
  const turnMs = Number(process.env.PROJECTS_SMOKE_TURN_MS) || DEFAULT_TURN_MS
  if (!home) { console.log('[smoke] LOCALCODE_PROJECTS_HOME must name the engine\'s scratch projects home'); process.exit(1) }
  const token = readDashboardToken(cyncoHome)
  const auth = { Authorization: `Bearer ${token}` }

  const api = async (method, path, body) => {
    const init = { method, headers: { ...auth } }
    if (body instanceof FormData) init.body = body
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
    const r = await fetch(`${base}${path}`, init)
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (e) { json = { unparsed: text, error: e instanceof Error ? e.message : String(e) } }
    return { status: r.status, body: json }
  }

  let ws = null
  const approvals = []
  // A turn: send `user.message`, buffer every frame up to `message.complete`.
  const turn = async (text) => {
    const from = ws.events.length
    ws.send({ type: 'user.message', text })
    const { index } = await ws.waitFor(from, e => e.type === 'message.complete', turnMs, 'message.complete')
    const events = ws.events.slice(from, index + 1)
    return { events, text: replyText(events), tools: events.filter(e => e.type === 'tool.start').map(e => e.toolName) }
  }
  const open = async (slug) => {
    const from = ws.events.length
    ws.send(slug === null ? { type: 'project.open', slug: null } : { type: 'project.open', slug })
    const { event } = await ws.waitFor(from, e => e.type === 'project.opened' || (e.type === 'session.error' && /project\.open/.test(e.error ?? '')), OPEN_TIMEOUT_MS, 'project.opened')
    if (event.type === 'session.error') throw new SmokeFailure(`project.open refused: ${event.error}`)
    return event
  }

  const ctx = { step5Reply: '' }
  const bodies = {
    1: async () => {
      const r = await api('POST', '/api/projects', { name: 'diorama-test', description: 'Projects-mode live smoke' })
      expectStatus('POST /api/projects', r.status, 201, r.body)
      if (r.body?.slug !== 'diorama-test') throw new SmokeFailure(`slug was ${JSON.stringify(r.body?.slug)}, expected diorama-test`)
      const dir = join(home, 'diorama-test')
      const missing = missingLayout(dir)
      if (missing.length) throw new SmokeFailure(`${dir} is missing ${missing.join(', ')}`)
      return `201 slug diorama-test; ${dir} has ${PROJECT_LAYOUT.length}/${PROJECT_LAYOUT.length} layout entries`
    },
    2: async () => {
      const r = await api('POST', '/api/projects/diorama-test/knowledge', { name: 'cookbook-chapter-3.md', text: COOKBOOK_CHAPTER })
      expectStatus('POST knowledge (paste)', r.status, 201, r.body)
      if (r.body?.indexed !== true) throw new SmokeFailure(`indexed was ${r.body?.indexed} (${r.body?.reason ?? 'no reason'})`)
      if (!(r.body?.chunks >= 3)) throw new SmokeFailure(`chunks ${r.body?.chunks}, expected >= 3`)
      return `201 ${r.body.name} indexed: true, chunks ${r.body.chunks}`
    },
    3: async () => {
      const { pdfWithPages } = await import('../engine/__tests__/projects/fixtures.ts')
      const form = new FormData()
      form.append('file', new File([pdfWithPages(PDF_PAGES)], 'resin-guide.pdf', { type: 'application/pdf' }))
      const r = await api('POST', '/api/projects/diorama-test/knowledge', form)
      expectStatus('POST knowledge (multipart)', r.status, 201, r.body)
      if (r.body?.indexed !== true) throw new SmokeFailure(`indexed was ${r.body?.indexed} (${r.body?.reason ?? 'no reason'})`)
      return `201 ${r.body.name} indexed: true, chunks ${r.body.chunks}`
    },
    4: async () => {
      ws = new Socket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
      await ws.opened()
      ws.onApproval = (ev) => { approvals.push(ev); ws.send({ type: 'approval.response', requestId: ev.requestId, approved: false }) }
      const t0 = Date.now()
      const ev = await open('diorama-test')
      if (ev.slug !== 'diorama-test') throw new SmokeFailure(`project.opened slug ${JSON.stringify(ev.slug)}`)
      return `project.opened slug diorama-test chat ${ev.chat ?? '(new)'} in ${Date.now() - t0} ms`
    },
    5: async () => {
      const t0 = Date.now()
      const r = await turn(PROMPTS.ask)
      ctx.step5Reply = r.text
      const cites = r.events.filter(e => e.type === 'project.citations').flatMap(e => e.citations ?? [])
      const k = knowledgeCitations(cites)
      if (!k.length) throw new SmokeFailure(`no project.citations under knowledge/ (citations: ${JSON.stringify(cites)}); reply: ${clip(r.text)}`)
      return `message.complete in ${Math.round((Date.now() - t0) / 1000)} s; ${k.length} knowledge citation(s): ${[...new Set(k.map(c => c.filePath))].join(', ')}; reply: "${clip(r.text, 140)}"`
    },
    6: async () => {
      const r = await turn(PROMPTS.save)
      const ing = r.events.filter(e => e.type === 'project.ingest')
      const hit = ing.find(e => e.kind === 'artifact' && e.filePath === 'artifacts/smoke-answer.md')
      if (!hit) throw new SmokeFailure(`no project.ingest {kind: artifact, filePath: artifacts/smoke-answer.md}; saw ${JSON.stringify(ing.map(e => [e.kind, e.filePath]))}; tools ${r.tools.join(',') || 'none'}`)
      return `project.ingest kind artifact filePath artifacts/smoke-answer.md indexed ${hit.indexed}${hit.chunks !== undefined ? ` (${hit.chunks} chunks)` : ''}; tools ${r.tools.join(',')}`
    },
    7: async () => {
      const p = await api('POST', '/api/projects/diorama-test/artifacts/smoke-answer.md/promote')
      expectStatus('POST promote', p.status, 200, p.body)
      const k = await api('GET', '/api/projects/diorama-test/knowledge')
      expectStatus('GET knowledge', k.status, 200, k.body)
      const rec = k.body?.files?.['smoke-answer.md']
      if (!rec) throw new SmokeFailure(`knowledge does not list smoke-answer.md (has ${Object.keys(k.body?.files ?? {}).join(', ')})`)
      if (rec.origin !== 'artifact') throw new SmokeFailure(`smoke-answer.md origin ${rec.origin}, expected artifact`)
      return `promote 200; knowledge lists ${Object.keys(k.body.files).join(', ')}; smoke-answer.md origin artifact, indexed ${rec.indexed}`
    },
    8: async () => {
      const artifact = join(home, 'diorama-test', 'knowledge', 'smoke-answer.md')
      const source = existsSync(artifact) ? readFileSync(artifact, 'utf8') : ctx.step5Reply
      const q = phraseFrom(source)
      if (!q) throw new SmokeFailure('no phrase to search for: the saved answer is empty')
      const r = await api('GET', `/api/project-search?q=${encodeURIComponent(q)}&limit=20`)
      expectStatus('GET /api/project-search', r.status, 200, r.body)
      const hits = Array.isArray(r.body?.hits) ? r.body.hits : []
      const hit = hits.find(h => h.slug === 'diorama-test' && h.filePath === 'knowledge/smoke-answer.md')
      if (!hit) throw new SmokeFailure(`q "${q}": no hit {diorama-test, knowledge/smoke-answer.md} among ${JSON.stringify(hits.map(h => `${h.slug}:${h.filePath}`))}`)
      return `q "${q}" → ${hits.length} hits, rank ${hits.indexOf(hit) + 1} is diorama-test knowledge/smoke-answer.md`
    },
    9: async () => {
      const c = await api('POST', '/api/projects', { name: 'other-test' })
      expectStatus('POST /api/projects other-test', c.status, 201, c.body)
      const ev = await open('other-test')
      if (ev.slug !== 'other-test') throw new SmokeFailure(`project.opened slug ${JSON.stringify(ev.slug)}`)
      const r = await turn(PROMPTS.isolate)
      if (!r.tools.includes('ProjectSearch')) throw new SmokeFailure(`the model did not call ProjectSearch (tools: ${r.tools.join(',') || 'none'}); reply: ${clip(r.text)}`)
      const leaked = namesAnyOf(r.text, ['diorama-test'])
      const results = r.events.filter(e => e.type === 'tool.complete' && e.toolName === 'ProjectSearch').map(e => typeof e.result === 'string' ? e.result : JSON.stringify(e.result))
      const toolLeak = results.filter(s => s.includes('diorama-test'))
      if (leaked.length || toolLeak.length) throw new SmokeFailure(`other-test's chat reached diorama-test: reply "${clip(r.text)}" tool output "${clip(toolLeak.join(' | '))}"`)
      return `other-test opened; ProjectSearch called; neither the reply nor the tool output names diorama-test; tool output: "${clip(results.join(' | '), 120)}"`
    },
    10: async () => {
      const before = approvals.length
      const r = await turn(PROMPTS.download)
      const asked = approvals.slice(before)
      if (!asked.length) throw new SmokeFailure(`no approval.request (tools: ${r.tools.join(',') || 'none'}); reply: ${clip(r.text)}`)
      if (!saidDenied(r.text)) throw new SmokeFailure(`approval.request ${asked[0].requestId} answered approved:false but the reply does not say denied: ${clip(r.text)}`)
      return `approval.request (${asked[0].toolName}, risk ${asked[0].risk}: "${clip(asked[0].description, 60)}") answered approved:false; reply: "${clip(r.text, 120)}"`
    },
    11: async () => {
      const ev = await open(null)
      if (ev.slug !== null) throw new SmokeFailure(`project.opened slug ${JSON.stringify(ev.slug)}, expected null`)
      const r = await turn(PROMPTS.cwd)
      if (!namesDir(r.text, launchCwd)) throw new SmokeFailure(`reply does not name the launch cwd ${launchCwd}: ${clip(r.text)}`)
      const wrong = namesAnyOf(r.text, [home, join(home, 'other-test'), join(home, 'diorama-test')])
      if (wrong.length) throw new SmokeFailure(`reply names the project folder ${wrong[0]}: ${clip(r.text)}`)
      return `project.opened slug null; reply names ${launchCwd}, not the projects home: "${clip(r.text, 120)}"`
    },
  }

  for (const s of STEPS) {
    try {
      const evidence = await bodies[s.n]()
      console.log(smokeLine(s.n, true, s.name, evidence))
    } catch (e) {
      console.log(smokeLine(s.n, false, s.name, e instanceof Error ? e.message : String(e)))
      if (ws) ws.close()
      process.exit(1)
    }
  }
  if (ws) ws.close()
  process.exit(0)
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) await main()
