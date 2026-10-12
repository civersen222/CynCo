/**
 * Generative UI on the Chat tab (engine/genui + design §5, §8 A1/A2/A7/A9).
 *
 * The engine emits `ui.render` frames for a RenderUI call — partial while the
 * arguments stream, one final frame after it ran, `spec: null` when it was
 * withdrawn — and the page draws them with a vanilla-DOM renderer, one
 * function per catalog component. Clicks go back as `ui.action` with the
 * surface's input values; FollowUps chips are ordinary user messages.
 *
 * Three layers:
 *   1. string-level: the arms, the frame types and every catalog name as a
 *      renderer key — read from engine/genui/catalog.ts so the page cannot
 *      drift from the engine;
 *   2. the renderer under a small DOM stub (createElement/createElementNS
 *      returning plain nodes): the prompt's worked example, partial/final,
 *      state across re-renders, visible, Tabs, clicks, the four charts;
 *   3. `upsertSurface`: surface identity across partial and final frames,
 *      in-place re-render of an older surface, withdrawal.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { GENUI_CATALOG } from '../../genui/catalog.js'
import { PROJECT_IMAGE_PATH_RE } from '../../genui/spec.js'
import { genuiExampleCall } from '../../genui/prompt.js'
import { uiRequestReason } from '../../genui/intent.js'
import { isFollowUp } from '../../genui/actions.js'
import { validateCommand } from '../../bridge/commandSchema.js'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function scripts(): string {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[2])
  return out.join('\n')
}

/** The markdown + generative UI section of the page script, between its headers. */
function genuiSection(): string {
  const js = scripts()
  const start = js.indexOf('// ── Markdown (assistant prose)')
  const end = js.indexOf('// ── end generative UI')
  expect(start, 'markdown section header not found').toBeGreaterThan(-1)
  expect(end, 'generative UI end marker not found').toBeGreaterThan(start)
  return js.slice(start, end)
}

function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf('function ' + name + '(')
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = js.indexOf('{', start); i < js.length; i++) {
    if (js[i] === '{') depth++
    else if (js[i] === '}') { depth--; if (depth === 0) return js.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

// ── A minimal DOM ──────────────────────────────────────────
// Enough of the element API for the renderer: tree, attributes, dataset,
// classList, listeners, form properties, and a selector matcher for
// `.cls`, `#id`, `tag`, `[attr="v"]` compounds with descendant chains.

type Listener = (ev?: unknown) => void

class Node {
  tagName: string
  nodeName: string
  namespaceURI: string | null
  attrs: Record<string, string> = {}
  dataset: Record<string, string> = {}
  childNodes: Node[] = []
  parentNode: Node | null = null
  style: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  className = ''
  value: unknown = ''
  checked = false
  disabled = false
  selected = false
  required = false
  type = ''
  name = ''
  id = ''
  rows = 0
  min = ''
  max = ''
  step = ''
  href = ''
  title = ''
  placeholder = ''
  onclick: Listener | null = null
  scrollTop = 0
  scrollHeight = 0
  _text = ''
  _html = ''
  __genui?: unknown

  constructor(tag: string, ns: string | null = null) {
    this.tagName = tag.toUpperCase()
    this.nodeName = tag
    this.namespaceURI = ns
  }
  get textContent(): string {
    if (this._html) return this._html.replace(/<[^>]+>/g, '')
    return this._text + this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(v: string) { this._text = String(v); this._html = ''; this.childNodes.forEach(c => { c.parentNode = null }); this.childNodes = [] }
  get innerHTML(): string { return this._html }
  set innerHTML(v: string) { this._html = String(v); this._text = ''; this.childNodes.forEach(c => { c.parentNode = null }); this.childNodes = [] }
  get children(): Node[] { return this.childNodes }
  get firstChild(): Node | null { return this.childNodes[0] ?? null }
  get lastChild(): Node | null { return this.childNodes[this.childNodes.length - 1] ?? null }
  get firstElementChild(): Node | null { return this.firstChild }
  get lastElementChild(): Node | null { return this.lastChild }
  get nextSibling(): Node | null {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[i + 1] ?? null
  }
  appendChild(c: Node): Node {
    if (c.parentNode) c.parentNode.removeChild(c)
    this.childNodes.push(c); c.parentNode = this
    return c
  }
  insertBefore(c: Node, ref: Node | null): Node {
    if (!ref) return this.appendChild(c)
    if (c.parentNode) c.parentNode.removeChild(c)
    const i = this.childNodes.indexOf(ref)
    if (i < 0) throw new Error('insertBefore: ref is not a child')
    this.childNodes.splice(i, 0, c); c.parentNode = this
    return c
  }
  removeChild(c: Node): Node {
    const i = this.childNodes.indexOf(c)
    if (i < 0) throw new Error('removeChild: not a child')
    this.childNodes.splice(i, 1); c.parentNode = null
    return c
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v)
    if (k === 'class') this.className = String(v)
    if (k === 'id') this.id = String(v)
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v)
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null
  }
  hasAttribute(k: string): boolean { return Object.prototype.hasOwnProperty.call(this.attrs, k) }
  get classList() {
    const self = this
    const list = () => self.className.split(/\s+/).filter(Boolean)
    return {
      add: (...cs: string[]) => { const l = list(); cs.forEach(c => { if (!l.includes(c)) l.push(c) }); self.className = l.join(' ') },
      remove: (...cs: string[]) => { self.className = list().filter(c => !cs.includes(c)).join(' ') },
      contains: (c: string) => list().includes(c),
      toggle: (c: string, force?: boolean) => { const on = force === undefined ? !list().includes(c) : force; if (on) self.classList.add(c); else self.classList.remove(c); return on },
    }
  }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] = this.listeners[type] ?? []).push(fn) }
  fire(type: string, ev: unknown = {}): void {
    if (type === 'click' && this.disabled) return
    if (type === 'click' && this.onclick) this.onclick(ev)
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
  /** Every descendant, depth first. */
  descendants(): Node[] { const out: Node[] = []; const walk = (n: Node) => { for (const c of n.childNodes) { out.push(c); walk(c) } }; walk(this); return out }
  matches(selector: string): boolean { return selector.split(',').some(s => matchChain(this, s.trim().split(/\s+/))) }
  querySelectorAll(selector: string): Node[] { return this.descendants().filter(n => n.matches(selector)) }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null }
}

function matchCompound(n: Node, compound: string): boolean {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(compound)
  if (!m) throw new Error('selector not supported by the stub: ' + compound)
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false
  const parts = m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) ?? []
  return parts.every(p => {
    if (p[0] === '.') return n.classList.contains(p.slice(1))
    if (p[0] === '#') return n.id === p.slice(1)
    const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p)
    if (!a) throw new Error('attribute selector not supported: ' + p)
    return a[2] === undefined ? n.hasAttribute(a[1]) : n.getAttribute(a[1]) === a[2]
  })
}
function matchChain(n: Node, chain: string[]): boolean {
  if (!matchCompound(n, chain[chain.length - 1])) return false
  let rest = chain.slice(0, -1), cur = n.parentNode
  while (rest.length && cur) { if (matchCompound(cur, rest[rest.length - 1])) rest = rest.slice(0, -1); cur = cur.parentNode }
  return rest.length === 0
}

function makeDocument() {
  const body = new Node('body')
  const listeners: Record<string, Listener[]> = {}
  return {
    body,
    listeners,
    createElement: (tag: string) => new Node(tag),
    createElementNS: (ns: string, tag: string) => new Node(tag, ns),
    getElementById: (id: string) => body.descendants().find(n => n.id === id) ?? null,
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    addEventListener: (type: string, fn: Listener) => { (listeners[type] = listeners[type] ?? []).push(fn) },
    removeEventListener: (type: string, fn: Listener) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn) },
    fire: (type: string, ev: unknown) => { for (const fn of [...(listeners[type] ?? [])]) fn(ev) },
  }
}

type ImageEntry = { status: string; reason: string; slug: string; key: string; url: string; loading: boolean; path?: string; stale?: boolean }

type Page = {
  renderUiSpec: (spec: unknown, el: Node, ctx?: Record<string, unknown>) => Record<string, any>
  upsertSurface: (event: Record<string, unknown>) => Node | null
  sendUiAction: (surfaceId: string, action: string, label?: string, context?: unknown, userMessage?: string) => boolean
  finalizeGenuiSurfaces: () => void
  GENUI_RENDERERS: Record<string, unknown>
  genuiToolRows: Record<string, string>
  applyUiImage: (event: Record<string, unknown>) => void
  genuiImages: Record<string, ImageEntry>
  genuiRecheckImages: () => void
  genuiForgetImages: () => void
}

/** A fetch reply the way the page reads one: ok/status, a content-type header, blob() or json(). */
type FakeReply = { ok: boolean; status: number; headers: { get: (k: string) => string | null }; blob: () => Promise<unknown>; json: () => Promise<unknown> }
function reply(status: number, type: string | null, body: unknown = 'png-bytes'): FakeReply {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
    blob: () => Promise.resolve({ blob: body }),
    json: () => Promise.resolve(body),
  }
}

/**
 * The page's genui section running against the stub document, a recording
 * socket, a recording fetch (by default it never answers) and a URL stub
 * that names blob URLs `blob:page/<n>`.
 */
function harness(opts: { wsOpen?: boolean; project?: boolean; cwd?: string | null; fetch?: (url: string) => Promise<FakeReply> } = {}) {
  const document = makeDocument()
  const msgs = new Node('div'); msgs.id = 'chatMessages'; document.body.appendChild(msgs)
  if (opts.cwd !== null) { const box = new Node('input'); box.id = 'chatCwd'; box.value = opts.cwd ?? ''; document.body.appendChild(box) }
  const sent: Record<string, unknown>[] = []
  const said: [string, string][] = []
  const fetched: string[] = []
  const blobs = { created: [] as unknown[], revoked: [] as string[] }
  const fetchFn = (url: string) => { fetched.push(url); return opts.fetch ? opts.fetch(url) : new Promise<FakeReply>(() => {}) }
  const urlStub = {
    createObjectURL: (b: unknown) => { blobs.created.push(b); return 'blob:page/' + blobs.created.length },
    revokeObjectURL: (u: string) => { blobs.revoked.push(u) },
  }
  const make = new Function('document', 'ws', 'appendChatMsg', 'brainViz', 'projectsState', 'fetch', 'URL',
    fnSource('escHtml') + '\n' + fnSource('projectChatUnsettled') + '\n' + genuiSection() +
    '\nreturn { renderUiSpec: renderUiSpec, upsertSurface: upsertSurface, sendUiAction: sendUiAction,' +
    ' finalizeGenuiSurfaces: finalizeGenuiSurfaces, GENUI_RENDERERS: GENUI_RENDERERS, genuiToolRows: genuiToolRows,' +
    ' applyUiImage: applyUiImage, genuiImages: genuiImages, genuiRecheckImages: genuiRecheckImages, genuiForgetImages: genuiForgetImages };')
  const page = make(
    document,
    { readyState: opts.wsOpen === false ? 3 : 1, send: (s: string) => sent.push(JSON.parse(s)) },
    (role: string, text: string) => said.push([role, text]),
    { setActive: () => {} },
    { active: opts.project ? { slug: 'p', chat: 'c' } : null },
    fetchFn,
    urlStub,
  ) as Page
  return { page, document, msgs, sent, said, fetched, blobs }
}

/** A surface element the way upsertSurface would label it. */
function surfaceEl(id = 'plan'): Node {
  const el = new Node('div'); el.className = 'genui-surface'; el.setAttribute('data-surface', id); el.setAttribute('data-tool-id', 't-' + id)
  return el
}

const texts = (nodes: Node[]) => nodes.map(n => n.textContent)
const controls = (el: Node) => el.querySelectorAll('button, input, select, textarea')

// ═══ 1. string-level ═══════════════════════════════════════

describe('dashboard genui: the page wires the protocol', () => {
  const js = scripts()

  it('handles ui.render in handleEvent and sends ui.action frames (chips included)', () => {
    expect(js).toContain("case 'ui.render'")
    expect(js).toContain('upsertSurface(event)')
    expect(js).toContain("type: 'ui.action'")
    // A chip is a ui.action, never a user.message: the busy guard drops a
    // user.message sent while the turn that drew the chips still runs.
    expect(js).not.toContain('function sendUiFollowUp(')
    expect(js).toContain("sendUiAction(ctx.surfaceId, 'followup', text, undefined, text)")
    expect(html).toContain('.genui-surface')
    expect(js).toContain('data-tool-id')
    expect(js).toContain('data-surface')
  })

  it('echoes a click as a distinct action bubble, never the plain `you` bubble', () => {
    expect(fnSource('appendChatMsg')).toContain("role === 'action'")
    expect(fnSource('sendUiAction')).toContain("appendChatMsg('action'")
    expect(html).toContain('.chat-msg-action {')
  })

  it('finalizes still-partial surfaces on message.complete and session.error, and places surfaces under the RenderUI row', () => {
    const arm = (name: string) => { const i = js.indexOf(`case '${name}'`); return js.slice(i, js.indexOf('break;', i)) }
    expect(arm('message.complete')).toContain('finalizeGenuiSurfaces()')
    expect(arm('session.error')).toContain('finalizeGenuiSurfaces()')
    expect(arm('tool.start')).toContain("if (event.toolName === 'RenderUI') genuiToolRows[event.toolId || ''] = chatToolId")
  })

  it('renderTranscript redraws a stored RenderUI call; one that failed or drew nothing comes back withdrawn', () => {
    const frames: Record<string, unknown>[] = []
    const run = new Function('appendChatMsg', 'appendChatTool', 'summarizeInput', 'upsertSurface', 'GENUI_ID_RE', 'genuiToolRows',
      fnSource('renderTranscript') + '\nreturn renderTranscript;')(
      () => {}, () => 'row', () => '', (f: Record<string, unknown>) => { frames.push(f) }, /^[A-Za-z0-9_-]{1,40}$/, {},
    ) as (t: unknown) => number
    const spec = { root: 'c', elements: { c: { type: 'Card', props: {}, children: [] } } }
    run({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'ok', name: 'RenderUI', input: { surface: 'plan', spec } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'bad', name: 'RenderUI', input: { surface: 'plan', spec } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: [] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'none', name: 'RenderUI', input: { spec: null } }] },
    ] })
    expect(frames).toEqual([
      { type: 'ui.render', toolId: 'ok', surfaceId: 'plan', partial: false, spec, errors: [] },
      // a failed call keys on its own id: it never takes over (or withdraws) 'plan'
      { type: 'ui.render', toolId: 'bad', surfaceId: 'bad', partial: false, spec: null, errors: ['this call failed when it ran'] },
      { type: 'ui.render', toolId: 'none', surfaceId: 'none', partial: false, spec: null, errors: ['nothing could be drawn'] },
    ])
  })

  it('every catalog component has a renderer key (GENUI_RENDERERS cannot drift from engine/genui/catalog.ts)', () => {
    const names = Object.keys(GENUI_CATALOG)
    expect(names.length).toBeGreaterThan(30)
    const { page } = harness()
    const keys = Object.keys(page.GENUI_RENDERERS)
    for (const n of names) {
      expect(keys, `renderer for ${n} missing`).toContain(n)
      expect(typeof page.GENUI_RENDERERS[n]).toBe('function')
      expect(js, `GENUI_RENDERERS.${n} not written as a literal key`).toMatch(new RegExp('^\\s+' + n + ': function\\(', 'm'))
    }
    const extra = keys.filter(k => !names.includes(k))
    expect(extra, 'renderers the catalog does not know').toEqual([])
  })

  it('builds DOM with createElement/textContent: innerHTML only carries markdown output', () => {
    const section = genuiSection().slice(genuiSection().indexOf('// ── Generative UI'))
    const uses = section.match(/\.innerHTML\s*=\s*[^;]+/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/genuiRich\((mdInline\(escHtml\(|escHtml\(|mdToHtml\()/)
  })

  it('styles: genui prefix, word fade honouring reduced motion, grid collapse under 520px', () => {
    expect(html).toContain('@keyframes genui-fade')
    expect(html).toContain('@media (prefers-reduced-motion: reduce) { .genui-w { animation: none; } }')
    expect(html).toMatch(/@media \(max-width: 520px\) \{[^}]*\.genui-grid \{ grid-template-columns: 1fr !important; \}/)
    // the 720px block stays the first media query (projectsView pins it)
    expect(html.indexOf('@media (max-width: 720px)')).toBeLessThan(html.indexOf('@media (prefers-reduced-motion'))
  })
})

// ═══ 2. renderUiSpec under the stub ═══════════════════════

describe('dashboard genui: renderUiSpec draws the worked example', () => {
  const spec = genuiExampleCall().spec

  it('Card > Steps, Table, Form(Slider, Button), FollowUps with the expected structure', () => {
    const { page } = harness()
    const el = surfaceEl()
    page.renderUiSpec(spec, el, { partial: false })
    const card = el.querySelector('.genui-card')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.genui-card-title')!.textContent).toBe('Weekend build plan')
    expect(card.getAttribute('data-el')).toBe('card')

    const steps = card.querySelectorAll('.genui-step')
    expect(steps.map(s => s.className)).toEqual(['genui-step genui-step-done', 'genui-step genui-step-active'])
    expect(texts(steps.map(s => s.querySelector('.genui-step-glyph')!))).toEqual(['●', '◐'])
    expect(texts(steps.map(s => s.querySelector('.genui-step-title')!))).toEqual(['Cut the frame', 'Resin pour'])
    expect(steps[1].querySelector('.genui-step-details')!.textContent).toBe('2 kg, 24 h cure')

    const table = card.querySelector('table.genui-table')!
    expect(texts(table.querySelectorAll('th'))).toEqual(['Item', 'Qty', 'Cost'])
    const rows = table.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(texts(rows[0].querySelectorAll('td'))).toEqual(['Resin', '2 kg', '$60'])

    const form = card.querySelector('.genui-form')!
    expect(form.querySelector('.genui-form-title')!.textContent).toBe('Adjust')
    const slider = form.querySelector('input.genui-range')!
    expect(slider.type).toBe('range')
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['1', '5', '0.5', '2'])
    expect(form.querySelector('.genui-slider-val')!.textContent).toBe('2')
    const btn = form.querySelector('button.genui-btn')!
    expect(btn.className).toBe('genui-btn genui-btn-primary')
    expect(btn.textContent).toBe('Recalculate')

    const chips = card.querySelectorAll('.genui-followups button.genui-chip')
    expect(texts(chips)).toEqual(['Show the cost by week', 'What if I use walnut?'])
    expect(el.querySelectorAll('.genui-unknown')).toEqual([])
  })

  it('partial: every control disabled and .genui-partial set; final: enabled', () => {
    const { page } = harness()
    const el = surfaceEl()
    const ctx = page.renderUiSpec(spec, el, { partial: true })
    expect(el.classList.contains('genui-partial')).toBe(true)
    const cs = controls(el)
    expect(cs.length).toBeGreaterThanOrEqual(4) // slider, button, two chips
    expect(cs.every(c => c.disabled)).toBe(true)
    // a partial Text fades its words in
    const fade = surfaceEl('f')
    page.renderUiSpec({ root: 't', elements: { t: { type: 'Text', props: { text: 'one **two** three' } } } }, fade, { partial: true })
    expect(fade.querySelector('p.genui-text')!.innerHTML).toBe('<span class="genui-w">one</span> <strong><span class="genui-w">two</span></strong> <span class="genui-w">three</span>')

    ctx.partial = false
    page.renderUiSpec(spec, el, ctx)
    expect(el.classList.contains('genui-partial')).toBe(false)
    expect(controls(el).every(c => !c.disabled)).toBe(true)
    // the final frame draws plain text
    page.renderUiSpec({ root: 't', elements: { t: { type: 'Text', props: { text: 'one **two** three' } } } }, fade, { partial: false })
    expect(fade.querySelector('p.genui-text')!.innerHTML).toBe('one <strong>two</strong> three')
  })

  it('input state is preserved across a re-render by name', () => {
    const { page } = harness()
    const el = surfaceEl()
    const ctx = page.renderUiSpec(spec, el, {})
    expect(ctx.state).toEqual({ kg: 2 })
    const slider = el.querySelector('input.genui-range')!
    slider.value = '3.5'
    slider.fire('input')
    expect(ctx.state.kg).toBe(3.5)
    expect(el.querySelector('.genui-slider-val')!.textContent).toBe('3.5')
    page.renderUiSpec(spec, el, ctx)
    expect(el.querySelector('input.genui-range')!.value).toBe('3.5')
    expect(ctx.state).toEqual({ kg: 3.5 })
  })

  it('a half-streamed tab value never sticks: the final frame shows its tab panel', () => {
    const { page } = harness()
    const tabsSpec = (first: string) => ({ root: 't', elements: {
      t: { type: 'Tabs', props: { tabs: [{ label: 'Plan', value: first }, { label: 'Costs', value: 'costs' }] }, children: ['a', 'b'] },
      a: { type: 'Text', props: { text: 'plan body' }, tab: first },
      b: { type: 'Text', props: { text: 'costs body' }, tab: 'costs' },
    } })
    const el = surfaceEl('trip')
    const ctx = page.renderUiSpec(tabsSpec('pla'), el, { partial: true })
    expect(ctx.state['__tab:t']).toBeUndefined()
    page.renderUiSpec(tabsSpec('plan'), el, Object.assign(ctx, { partial: false }))
    const panels = el.querySelectorAll('.genui-tab-panel')
    expect(panels.map(pn => pn.classList.contains('genui-hidden'))).toEqual([false, true])
    // a remembered tab the new render no longer has falls back to the default
    ctx.state['__tab:t'] = 'gone'
    page.renderUiSpec(tabsSpec('plan'), el, ctx)
    expect(el.querySelectorAll('.genui-tab-panel').map(pn => pn.classList.contains('genui-hidden'))).toEqual([false, true])
  })

  it('a partial frame never seeds input state: the final frame\'s value wins', () => {
    const { page } = harness()
    const el = surfaceEl()
    const sliderSpec = (value: number) => ({ root: 's', elements: { s: { type: 'Slider', props: { name: 'kg', label: 'Kg', min: 0, max: 50, value } } } })
    const ctx = page.renderUiSpec(sliderSpec(2), el, { partial: true })
    expect(ctx.state).toEqual({})
    expect(el.querySelector('input.genui-range')!.value).toBe('2')
    page.renderUiSpec(sliderSpec(25), el, Object.assign(ctx, { partial: false }))
    expect(ctx.state).toEqual({ kg: 25 })
    expect(el.querySelector('input.genui-range')!.value).toBe('25')
  })

  it('a stored spec with thousands of elements draws at most 400', () => {
    const { page } = harness()
    const el = surfaceEl()
    const elements: Record<string, unknown> = { s: { type: 'Stack', props: {}, children: [] as string[] } }
    for (let i = 0; i < 2000; i++) { elements['t' + i] = { type: 'Text', props: { text: String(i) } }; (elements.s as any).children.push('t' + i) }
    page.renderUiSpec({ root: 's', elements }, el, {})
    expect(el.querySelectorAll('.genui-text').length).toBe(399) // 400 drawn: the Stack and 399 of its children
  })

  it('visible: eq / neq against the surface state, re-evaluated on change', () => {
    const { page } = harness()
    const el = surfaceEl()
    const s = { root: 'f', elements: {
      f: { type: 'Form', props: {}, children: ['rush', 'yes', 'no', 'any'] },
      rush: { type: 'Switch', props: { name: 'rush', label: 'Rush order' } },
      yes: { type: 'Text', props: { text: 'rush it' }, visible: { name: 'rush', eq: true } },
      no: { type: 'Text', props: { text: 'take it slow' }, visible: { name: 'rush', neq: true } },
      any: { type: 'Text', props: { text: 'truthy' }, visible: { name: 'rush' } },
    } }
    const ctx = page.renderUiSpec(s, el, {})
    expect(ctx.state).toEqual({ rush: false })
    const yes = el.querySelector('[data-el="yes"]')!, no = el.querySelector('[data-el="no"]')!, any = el.querySelector('[data-el="any"]')!
    expect([yes, no, any].map(n => n.classList.contains('genui-hidden'))).toEqual([true, false, true])
    const sw = el.querySelector('input.genui-switch-input')!
    sw.checked = true
    sw.fire('change')
    expect(ctx.state).toEqual({ rush: true })
    expect([yes, no, any].map(n => n.classList.contains('genui-hidden'))).toEqual([false, true, false])
  })

  it('Tabs: a clickable strip; the child whose `tab` matches the active value is shown', () => {
    const { page } = harness()
    const el = surfaceEl()
    const s = { root: 'tabs', elements: {
      tabs: { type: 'Tabs', props: { tabs: [{ label: 'Plan', value: 'plan' }, { label: 'Costs', value: 'costs' }] }, children: ['a', 'b'] },
      a: { type: 'Text', props: { text: 'the plan' }, tab: 'plan' },
      b: { type: 'Text', props: { text: 'the costs' }, tab: 'costs' },
    } }
    const ctx = page.renderUiSpec(s, el, {})
    const btns = el.querySelectorAll('.genui-tab-strip button.genui-tab')
    expect(texts(btns)).toEqual(['Plan', 'Costs'])
    expect(btns.map(b => b.classList.contains('active'))).toEqual([true, false])
    const panels = el.querySelectorAll('.genui-tab-panel')
    expect(panels.map(p => p.classList.contains('genui-hidden'))).toEqual([false, true])
    btns[1].fire('click')
    expect(ctx.state['__tab:tabs']).toBe('costs')
    expect(btns.map(b => b.classList.contains('active'))).toEqual([false, true])
    expect(panels.map(p => p.classList.contains('genui-hidden'))).toEqual([true, false])
  })

  it('a Button click sends exactly one ui.action with the Form action and the surface state, and echoes it', () => {
    const { page, sent, said } = harness()
    const el = surfaceEl('plan')
    page.renderUiSpec(spec, el, {})
    el.querySelector('button.genui-btn')!.fire('click')
    expect(sent).toEqual([{ type: 'ui.action', surfaceId: 'plan', action: 'recalc', label: 'Recalculate', state: { kg: 2 } }])
    expect(said).toEqual([['action', '▶ Recalculate']])
    // tab/open bookkeeping never rides along; a Button's own action and context do
    const el2 = surfaceEl('s2')
    page.renderUiSpec({ root: 'r', elements: {
      r: { type: 'Tabs', props: { tabs: [{ label: 'A', value: 'a' }] }, children: ['b'] },
      b: { type: 'Button', props: { label: 'Go', action: 'go', context: { id: 7 } }, tab: 'a' },
    } }, el2, {})
    el2.querySelector('button.genui-btn')!.fire('click')
    expect(sent[1]).toEqual({ type: 'ui.action', surfaceId: 's2', action: 'go', label: 'Go', context: { id: 7 }, state: {} })
    // a disabled button sends nothing; no socket sends nothing and says so
    const closed = harness({ wsOpen: false })
    const el3 = surfaceEl('s3')
    closed.page.renderUiSpec(spec, el3, {})
    el3.querySelector('button.genui-btn')!.fire('click')
    expect(closed.sent).toEqual([])
    expect(closed.said[0][1]).toContain('Not connected')
  })

  it('a FollowUps chip rides ui.action as the `followup` action carrying its text', () => {
    const { page, sent, said } = harness({ cwd: '/work/repo' })
    const el = surfaceEl()
    page.renderUiSpec(spec, el, {})
    el.querySelectorAll('button.genui-chip')[1].fire('click')
    expect(sent).toEqual([{ type: 'ui.action', surfaceId: 'plan', action: 'followup', label: 'What if I use walnut?', userMessage: 'What if I use walnut?', state: { kg: 2 } }])
    expect(said).toEqual([['action', 'What if I use walnut?']])
  })

  it('click frames always satisfy the socket bounds: safe ids, capped text, 8 KB state', () => {
    const { page, sent, said } = harness()
    const el = surfaceEl('my surface!')
    page.renderUiSpec({ root: 'f', elements: {
      f: { type: 'Form', props: { action: 'Save it' }, children: ['t', 'b'] },
      t: { type: 'Textarea', props: { name: 'notes', label: 'Notes' } },
      b: { type: 'Button', props: { label: 'Save' } },
    } }, el, {})
    el.querySelector('button.genui-btn')!.fire('click')
    expect(sent[0]).toMatchObject({ type: 'ui.action', surfaceId: 'my-surface', action: 'save-it' })
    const ta = el.querySelector('textarea')!
    ta.value = 'x'.repeat(9000)
    ta.fire('input')
    el.querySelector('button.genui-btn')!.fire('click')
    expect(sent).toHaveLength(1)
    expect(said[said.length - 1][0]).toBe('system')
    expect(said[said.length - 1][1]).toMatch(/over 8 KB/)
  })

  it('a List item with an action is clickable like a Button', () => {
    const { page, sent } = harness()
    const el = surfaceEl('l')
    page.renderUiSpec({ root: 'l', elements: { l: { type: 'List', props: { variant: 'number', items: [{ title: 'Open it', action: 'open' }, { title: 'plain', subtitle: 'two' }] } } } }, el, {})
    const list = el.querySelector('ol.genui-list')!
    const items = list.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[1].querySelector('.genui-list-sub')!.textContent).toBe('two')
    items[0].querySelector('button.genui-list-btn')!.fire('click')
    expect(sent).toEqual([{ type: 'ui.action', surfaceId: 'l', action: 'open', label: 'Open it', state: {} }])
  })

  it('charts are inline SVG with a <title> per mark, axis labels and a legend for several series', () => {
    const { page } = harness()
    const el = surfaceEl('c')
    page.renderUiSpec({ root: 'g', elements: {
      g: { type: 'Grid', props: { columns: 2 }, children: ['bar', 'stack', 'line', 'pie', 'donut', 'spark'] },
      bar: { type: 'BarChart', props: { title: 'Cost', labels: ['Frame', 'Resin', 'Finish'], series: [{ name: 'min', values: [40, 60, 20] }, { name: 'max', values: [50, 80, 30] }], yLabel: '$' } },
      stack: { type: 'BarChart', props: { labels: ['a', 'b'], series: [{ name: 's1', values: [1, 2] }, { name: 's2', values: [3, 4] }], stacked: true } },
      line: { type: 'LineChart', props: { labels: ['0h', '6h', '12h'], series: [{ name: '°C', values: [22, 31, 28] }], area: true } },
      pie: { type: 'PieChart', props: { labels: ['Wood', 'Resin', 'Hardware'], values: [55, 35, 10] } },
      donut: { type: 'PieChart', props: { labels: ['x', 'y'], values: [1, 1], donut: true } },
      spark: { type: 'Sparkline', props: { values: [3, 5, 4, 8, 7], label: 'builds/week' } },
    } }, el, {})
    const svgNs = 'http://www.w3.org/2000/svg'
    const svgs = el.querySelectorAll('svg')
    expect(svgs).toHaveLength(6)
    expect(svgs.every(s => s.namespaceURI === svgNs && /^0 0 \d+ \d+$/.test(s.getAttribute('viewBox')!))).toBe(true)

    const bar = el.querySelector('[data-el="bar"]')!
    expect(bar.querySelector('.genui-chart-title')!.textContent).toBe('Cost')
    const rects = bar.querySelectorAll('rect')
    expect(rects).toHaveLength(6)
    expect(rects.every(r => r.querySelector('title') !== null)).toBe(true)
    expect(rects[0].querySelector('title')!.textContent).toBe('min · Frame: 40')
    expect(rects.map(r => r.getAttribute('fill'))).toEqual(['#4ec9b0', '#569cd6', '#4ec9b0', '#569cd6', '#4ec9b0', '#569cd6'])
    const labels = texts(bar.querySelectorAll('text'))
    for (const l of ['Frame', 'Resin', 'Finish', '$', '0']) expect(labels).toContain(l)
    expect(texts(bar.querySelectorAll('.genui-legend-item'))).toEqual(['min', 'max'])

    const stack = el.querySelector('[data-el="stack"]')!
    const srects = stack.querySelectorAll('rect')
    expect(srects).toHaveLength(4)
    // stacked: the second series sits on top of the first (smaller y) in the same column
    expect(Number(srects[1].getAttribute('y'))).toBeLessThan(Number(srects[0].getAttribute('y')))
    expect(srects[0].getAttribute('x')).toBe(srects[1].getAttribute('x'))

    const line = el.querySelector('[data-el="line"]')!
    expect(line.querySelectorAll('polyline')).toHaveLength(1)
    expect(line.querySelectorAll('polygon')).toHaveLength(1)
    const dots = line.querySelectorAll('circle')
    expect(dots).toHaveLength(3)
    expect(dots[1].querySelector('title')!.textContent).toBe('°C · 6h: 31')
    expect(line.querySelectorAll('.genui-legend')).toEqual([])

    const pie = el.querySelector('[data-el="pie"]')!
    const slices = pie.querySelectorAll('path')
    expect(slices).toHaveLength(3)
    expect(slices[0].querySelector('title')!.textContent).toBe('Wood: 55 (55%)')
    expect(slices[0].getAttribute('d')).toMatch(/^M100 100 L/)
    expect(texts(pie.querySelectorAll('.genui-legend-item'))).toEqual(['Wood — 55 (55%)', 'Resin — 35 (35%)', 'Hardware — 10 (10%)'])
    const donut = el.querySelector('[data-el="donut"]')!
    const ring = donut.querySelectorAll('path')
    expect(ring).toHaveLength(2)
    expect(ring[0].getAttribute('d')!.match(/ A/g)).toHaveLength(2) // outer and inner arc

    const spark = el.querySelector('[data-el="spark"]')!
    expect(spark.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(5)
    expect(spark.querySelector('.genui-sparkline-label')!.textContent).toBe('builds/week')
    expect(el.querySelector('.genui-grid')!.getAttribute('data-columns')).toBe('2')
  })

  it('an unknown type draws a muted "unknown component" box instead of throwing', () => {
    const { page } = harness()
    const el = surfaceEl('u')
    page.renderUiSpec({ root: 'c', elements: { c: { type: 'Card', props: { title: 'T' }, children: ['x', 'ok'] }, x: { type: 'Gauge', props: {} }, ok: { type: 'Badge', props: { text: 'fine' } } } }, el, {})
    const box = el.querySelector('.genui-unknown')!
    expect(box).not.toBeNull()
    expect(box.textContent).toBe('unknown component "Gauge"')
    expect(el.querySelector('.genui-badge')!.textContent).toBe('fine')
    // a root that names nothing
    const el2 = surfaceEl('u2')
    page.renderUiSpec({ root: 'nope', elements: {} }, el2, {})
    expect(el2.querySelector('.genui-unknown')!.textContent).toContain('nothing to draw')
  })

  it('every catalog component draws from its own example without an unknown box', () => {
    const { page } = harness()
    for (const [name, def] of Object.entries(GENUI_CATALOG)) {
      const el = surfaceEl('x-' + name)
      const spec = { root: 'x', elements: { x: { type: name, props: JSON.parse(JSON.stringify(def.example)), children: [] } } }
      page.renderUiSpec(spec, el, {})
      const node = el.querySelector('[data-el="x"]')
      expect(node, `${name} drew nothing`).not.toBeNull()
      expect(el.querySelectorAll('.genui-unknown'), `${name} drew an unknown box`).toEqual([])
    }
  })

  it('Link and Image use safeUrl; an unsafe Image shows a placeholder, a broken one falls back to it', () => {
    const { page } = harness()
    const el = surfaceEl('i')
    page.renderUiSpec({ root: 's', elements: {
      s: { type: 'Stack', props: {}, children: ['ok', 'bad', 'img', 'badimg'] },
      ok: { type: 'Link', props: { label: 'sds', href: 'https://example.com/sds.pdf' } },
      bad: { type: 'Link', props: { label: 'nope', href: 'javascript:alert(1)' } },
      img: { type: 'Image', props: { src: 'https://example.com/t.jpg', alt: 'River table', caption: 'ref' } },
      badimg: { type: 'Image', props: { src: 'javascript:alert(1)', alt: 'evil' } },
    } }, el, {})
    const a = el.querySelector('a.genui-link')!
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]).toEqual(['https://example.com/sds.pdf', '_blank', 'noopener noreferrer'])
    expect(el.querySelectorAll('a')).toHaveLength(1)
    expect(el.querySelector('.genui-link-bad')!.textContent).toBe('nope')
    // A remote image is never fetched unasked (the URL is model-chosen and
    // could carry anything the model read): a click loads it, no referrer.
    expect(el.querySelector('img')).toBeNull()
    const load = el.querySelector('[data-el="img"] button.genui-image-load')!
    expect(load.textContent).toBe('Load image from example.com')
    load.fire('click')
    const img = el.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://example.com/t.jpg')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(el.querySelector('[data-el="badimg"] .genui-image-ph')!.textContent).toBe('evil')
    expect(el.querySelector('[data-el="badimg"] img')).toBeNull()
    expect(el.querySelector('[data-el="badimg"] button')).toBeNull()
    img.fire('error')
    expect(el.querySelector('[data-el="img"] img')).toBeNull()
    expect(el.querySelector('[data-el="img"] .genui-image-ph')!.textContent).toBe('River table')
    expect(el.querySelector('[data-el="img"] figcaption')!.textContent).toBe('ref')
  })

  it('Text renders inline markdown; Markdown renders a block; both escape first', () => {
    const { page } = harness()
    const el = surfaceEl('m')
    page.renderUiSpec({ root: 's', elements: {
      s: { type: 'Stack', props: {}, children: ['t', 'm', 'h'] },
      t: { type: 'Text', props: { text: 'a **b** <i>c</i>', variant: 'muted' } },
      m: { type: 'Markdown', props: { text: '## Notes\n- cure 24 h' } },
      h: { type: 'Heading', props: { text: '<Materials>', level: 3 } },
    } }, el, {})
    const t = el.querySelector('p.genui-text')!
    expect(t.className).toBe('genui-text genui-text-muted')
    expect(t.innerHTML).toBe('a <strong>b</strong> &lt;i&gt;c&lt;/i&gt;')
    expect(el.querySelector('.genui-md')!.innerHTML).toBe('<h2>Notes</h2><ul><li>cure 24 h</li></ul>')
    const h = el.querySelector('h3.genui-heading')!
    expect(h.innerHTML).toBe('&lt;Materials&gt;')
  })

  it('report components: Steps glyphs, FileChange counts, Terminal, TestResults, Callout, Progress', () => {
    const { page } = harness()
    const el = surfaceEl('r')
    page.renderUiSpec({ root: 's', elements: {
      s: { type: 'Stack', props: {}, children: ['st', 'fc', 'te', 'tr', 'co', 'pr', 'sec'] },
      st: { type: 'Steps', props: { items: [{ title: 'a', status: 'todo' }, { title: 'b', status: 'failed' }, { title: 'c', status: 'skipped' }] } },
      fc: { type: 'FileChange', props: { path: 'src/p.ts', kind: 'created', additions: 12, deletions: 3, summary: 'new' } },
      te: { type: 'Terminal', props: { command: 'npx vitest run', output: '12 passed', exitCode: 1 } },
      tr: { type: 'TestResults', props: { passed: 41, failed: 1, runner: 'pytest', failures: [{ name: 'test_x', message: 'expected 24' }] } },
      co: { type: 'Callout', props: { type: 'warning', title: 'Vent', message: 'outdoors' } },
      pr: { type: 'Progress', props: { value: 40, label: 'Frame' } },
      sec: { type: 'Section', props: { title: 'More', collapsible: true, open: false }, children: ['inner'] },
      inner: { type: 'Badge', props: { text: 'hidden until opened', variant: 'success' } },
    } }, el, {})
    expect(texts(el.querySelectorAll('.genui-step-glyph'))).toEqual(['○', '✕', '—'])
    const fc = el.querySelector('.genui-filechange')!
    expect(fc.className).toBe('genui-filechange genui-filechange-created')
    expect([fc.querySelector('.genui-add')!.textContent, fc.querySelector('.genui-del')!.textContent]).toEqual(['+12', '-3'])
    expect(fc.querySelector('.genui-filechange-path')!.textContent).toBe('src/p.ts')
    const te = el.querySelector('.genui-terminal')!
    expect(te.querySelector('.genui-terminal-text')!.textContent).toBe('npx vitest run')
    expect(te.querySelector('pre.genui-terminal-out')!.textContent).toBe('12 passed')
    expect(te.querySelector('.genui-terminal-exit')!.className).toBe('genui-terminal-exit bad')
    const tr = el.querySelector('.genui-tests')!
    expect(tr.className).toBe('genui-tests genui-tests-bad')
    expect([tr.querySelector('.genui-tests-passed')!.textContent, tr.querySelector('.genui-tests-failed')!.textContent]).toEqual(['41 passed', '1 failed'])
    expect(tr.querySelector('.genui-tests-failures li .genui-tests-name')!.textContent).toBe('test_x')
    const co = el.querySelector('.genui-callout')!
    expect(co.className).toBe('genui-callout genui-callout-warning')
    expect(co.querySelector('.genui-callout-title')!.textContent).toBe('Vent')
    const pr = el.querySelector('.genui-progress')!
    expect(pr.querySelector('.genui-progress-fill')!.style.width).toBe('40%')
    expect(pr.querySelector('.genui-progress-pct')!.textContent).toBe('40%')
    const sec = el.querySelector('.genui-section')!
    const body = sec.querySelector('.genui-section-body')!
    expect(body.classList.contains('genui-hidden')).toBe(true)
    sec.querySelector('button.genui-section-toggle')!.fire('click')
    expect(body.classList.contains('genui-hidden')).toBe(false)
    expect(body.querySelector('.genui-badge')!.textContent).toBe('hidden until opened')
  })

  it('form inputs: Select/Radio chips/Checkbox/CheckboxGroup/Input/Textarea initialise and write the state', () => {
    const { page } = harness()
    const el = surfaceEl('f')
    const ctx = page.renderUiSpec({ root: 'f', elements: {
      f: { type: 'Form', props: { title: 'x' }, children: ['sel', 'rad', 'cb', 'cg', 'inp', 'ta'] },
      sel: { type: 'Select', props: { name: 'wood', label: 'Wood', options: [{ label: 'Oak', value: 'oak' }, { label: 'Walnut', value: 'walnut' }], value: 'oak' } },
      rad: { type: 'Radio', props: { name: 'finish', label: 'Finish', options: ['matte', 'gloss'], value: 'matte', display: 'chips' } },
      cb: { type: 'Checkbox', props: { name: 'delivery', label: 'Include delivery', checked: true } },
      cg: { type: 'CheckboxGroup', props: { name: 'extras', label: 'Extras', options: ['LED', 'Legs', 'Coasters'], value: ['Legs'] } },
      inp: { type: 'Input', props: { name: 'length', label: 'Length', type: 'number', value: '180' } },
      ta: { type: 'Textarea', props: { name: 'notes', label: 'Notes', rows: 2 } },
    } }, el, {})
    expect(ctx.state).toEqual({ wood: 'oak', finish: 'matte', delivery: true, extras: ['Legs'], length: '180', notes: '' })
    const sel = el.querySelector('select.genui-select')!
    expect(texts(sel.querySelectorAll('option'))).toEqual(['Oak', 'Walnut'])
    sel.value = 'walnut'; sel.fire('change')
    const chips = el.querySelector('[data-el="rad"] .genui-choice')!
    expect(chips.classList.contains('genui-chips')).toBe(true)
    const radios = chips.querySelectorAll('input')
    expect(radios.map(r => r.checked)).toEqual([true, false])
    expect(chips.querySelectorAll('label').map(l => l.classList.contains('on'))).toEqual([true, false])
    radios[0].checked = false; radios[1].checked = true; radios[1].fire('change')
    expect(chips.querySelectorAll('label').map(l => l.classList.contains('on'))).toEqual([false, true])
    const boxes = el.querySelectorAll('[data-el="cg"] input')
    expect(boxes.map(b => b.checked)).toEqual([false, true, false])
    boxes[2].checked = true; boxes[2].fire('change')
    const inp = el.querySelector('[data-el="inp"] input')!
    expect(inp.type).toBe('number')
    inp.value = '200'; inp.fire('input')
    const ta = el.querySelector('textarea')!
    expect(ta.rows).toBe(2)
    ta.value = 'hi'; ta.fire('input')
    el.querySelector('[data-el="cb"] input')!.checked = false
    el.querySelector('[data-el="cb"] input')!.fire('change')
    expect(ctx.state).toEqual({ wood: 'walnut', finish: 'gloss', delivery: false, extras: ['Legs', 'Coasters'], length: '200', notes: 'hi' })
  })
})

// ═══ 3. upsertSurface ═════════════════════════════════════

describe('dashboard genui: upsertSurface keeps one element per surface', () => {
  const spec = genuiExampleCall().spec

  it('partial frames under the toolId followed by a final frame with a different surfaceId leave exactly one surface', () => {
    const { page, msgs } = harness()
    const partial = { root: 'card', elements: { card: { type: 'Card', props: { title: 'Weekend' }, children: [] } } }
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 't1', partial: true, spec: partial })
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 't1', partial: true, spec: spec })
    let surfaces = msgs.querySelectorAll('.genui-surface')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].getAttribute('data-surface')).toBe('t1')
    expect(surfaces[0].classList.contains('genui-partial')).toBe(true)
    expect(controls(surfaces[0]).every(c => c.disabled)).toBe(true)
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'plan', partial: false, spec: spec, errors: [] })
    surfaces = msgs.querySelectorAll('.genui-surface')
    expect(surfaces).toHaveLength(1)
    expect([surfaces[0].getAttribute('data-tool-id'), surfaces[0].getAttribute('data-surface')]).toEqual(['t1', 'plan'])
    expect(surfaces[0].classList.contains('genui-partial')).toBe(false)
    expect(controls(surfaces[0]).every(c => !c.disabled)).toBe(true)
    expect(surfaces[0].querySelector('.genui-issues')).toBeNull()
  })

  it('a final frame naming an older surface renders into it, keeps its input state and drops the transient element', () => {
    const { page, msgs, sent } = harness()
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'plan', partial: false, spec: spec })
    const first = msgs.querySelector('.genui-surface')!
    const slider = first.querySelector('input.genui-range')!
    slider.value = '4'; slider.fire('input')
    // the model re-renders "plan" in a second call
    page.upsertSurface({ type: 'ui.render', toolId: 't2', surfaceId: 't2', partial: true, spec: spec })
    expect(msgs.querySelectorAll('.genui-surface')).toHaveLength(2)
    page.upsertSurface({ type: 'ui.render', toolId: 't2', surfaceId: 'plan', partial: false, spec: spec })
    const surfaces = msgs.querySelectorAll('.genui-surface')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toBe(first)
    expect([first.getAttribute('data-tool-id'), first.getAttribute('data-surface')]).toEqual(['t2', 'plan'])
    expect(first.querySelector('input.genui-range')!.value).toBe('4')
    first.querySelector('button.genui-btn')!.fire('click')
    expect(sent).toEqual([{ type: 'ui.action', surfaceId: 'plan', action: 'recalc', label: 'Recalculate', state: { kg: 4 } }])
  })

  it('spec: null withdraws the surface: muted class, controls removed, the first error shown', () => {
    const { page, msgs } = harness()
    page.upsertSurface({ type: 'ui.render', toolId: 't3', surfaceId: 't3', partial: true, spec: spec })
    page.upsertSurface({ type: 'ui.render', toolId: 't3', surfaceId: 't3', partial: false, spec: null, errors: ['turn ended before the UI call completed', 'second'] })
    const surfaces = msgs.querySelectorAll('.genui-surface')
    expect(surfaces).toHaveLength(1)
    const s = surfaces[0]
    expect(s.classList.contains('genui-withdrawn')).toBe(true)
    expect(s.classList.contains('genui-partial')).toBe(false)
    expect(controls(s)).toEqual([])
    expect(s.querySelector('.genui-card-title')!.textContent).toBe('Weekend build plan') // what was drawn stays, muted
    expect(s.querySelector('.genui-withdrawn-note')!.textContent).toBe('UI withdrawn — turn ended before the UI call completed')
    // a terminal frame for a call nobody saw still says so
    page.upsertSurface({ type: 'ui.render', toolId: 't4', surfaceId: 't4', partial: false, spec: null, errors: ['RenderUI refused'] })
    expect(msgs.querySelectorAll('.genui-surface.genui-withdrawn')).toHaveLength(2)
  })

  it('a failed call naming an earlier surface leaves that surface and its inputs alone', () => {
    const { page, msgs } = harness()
    const plan = page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'plan', partial: false, spec, errors: [] })!
    const before = controls(plan).length
    // the engine keys a failed call's terminal frame on its own id; the page
    // also refuses to let a spec-less frame adopt an older surface by name
    page.upsertSurface({ type: 'ui.render', toolId: 't2', surfaceId: 'plan', partial: false, spec: null, errors: ['Nothing could be drawn'] })
    expect(plan.classList.contains('genui-withdrawn')).toBe(false)
    expect(controls(plan).length).toBe(before)
    expect(msgs.querySelectorAll('.genui-surface')).toHaveLength(2)
  })

  it('a final frame with errors shows a muted "n issues" toggle listing them', () => {
    const { page, msgs } = harness()
    page.upsertSurface({ type: 'ui.render', toolId: 't5', surfaceId: 'plan', partial: false, spec: spec, errors: ['go (Button): needs an action', 'x: not reachable'] })
    const s = msgs.querySelector('.genui-surface')!
    const btn = s.querySelector('.genui-issues-btn')!
    expect(btn.textContent).toBe('2 issues')
    const list = s.querySelector('.genui-issues-list')!
    expect(list.classList.contains('genui-hidden')).toBe(true)
    expect(texts(list.querySelectorAll('li'))).toEqual(['go (Button): needs an action', 'x: not reachable'])
    btn.fire('click')
    expect(list.classList.contains('genui-hidden')).toBe(false)
    page.upsertSurface({ type: 'ui.render', toolId: 't6', surfaceId: 'one', partial: false, spec: spec, errors: ['only'] })
    expect(msgs.querySelectorAll('.genui-issues-btn')[1].textContent).toBe('1 issue')
  })

  it('the surface sits right after the RenderUI tool row (and its detail) and the row collapses to "surface <id>"', () => {
    const { page, msgs } = harness()
    const before = new Node('div'); before.className = 'chat-msg chat-msg-assistant'; msgs.appendChild(before)
    // the partial frames arrive before tool.start: the surface lands at the end first
    page.upsertSurface({ type: 'ui.render', toolId: 't7', surfaceId: 't7', partial: true, spec: spec })
    const row = new Node('div'); row.className = 'chat-tool'; row.setAttribute('data-id', 'ct-1')
    for (let i = 0; i < 5; i++) row.appendChild(new Node('span'))
    row.children[2].textContent = '{"surface":"plan","spec":{"root":"card"...'
    const detail = new Node('div'); detail.className = 'chat-tool-detail'; detail.id = 'ct-1-detail'
    msgs.appendChild(row); msgs.appendChild(detail)
    page.genuiToolRows['t7'] = 'ct-1'
    const after = new Node('div'); after.className = 'chat-msg chat-msg-assistant'; msgs.appendChild(after)
    page.upsertSurface({ type: 'ui.render', toolId: 't7', surfaceId: 'plan', partial: false, spec: spec })
    expect(msgs.children.map(c => c.className.split(' ')[0] + (c.id ? '#' + c.id : ''))).toEqual(
      ['chat-msg', 'chat-tool', 'chat-tool-detail#ct-1-detail', 'genui-surface', 'chat-msg'])
    expect(row.children[2].textContent).toBe('surface plan')
    expect(detail.textContent).toBe('') // the detail is the tool result's, left alone
  })

  it('finalizeGenuiSurfaces enables the controls of any surface still partial (message.complete / session.error)', () => {
    const { page, msgs } = harness()
    page.upsertSurface({ type: 'ui.render', toolId: 't8', surfaceId: 't8', partial: true, spec: spec })
    page.upsertSurface({ type: 'ui.render', toolId: 't9', surfaceId: 'done', partial: false, spec: spec })
    expect(msgs.querySelectorAll('.genui-surface.genui-partial')).toHaveLength(1)
    page.finalizeGenuiSurfaces()
    expect(msgs.querySelectorAll('.genui-surface.genui-partial')).toEqual([])
    expect(msgs.querySelectorAll('.genui-surface').every(s => controls(s).every(c => !c.disabled))).toBe(true)
  })
})

// F171: a prose reply in a project chat can be redrawn with one click. The
// page's message must be one the engine forces (uiRequestReason); it goes as
// a FollowUps-style click so a turn that is running queues it instead of the
// busy guard dropping it, and it always names its reply by the opening words
// (final review: "the previous reply" is wrong after a surface-only turn).
describe('dashboard genui: "Show as UI" and "Save as artifact" under a project reply', () => {
  const OPENING = 'Here are four "designs": just tell me plainly, no cards'
  function page(state: { active: unknown; replyCount: number }, connected = true) {
    const sent: string[] = []
    const shown: string[] = []
    let cleared = 0
    const reply = { getAttribute: (k: string) => (k === 'data-raw' ? OPENING : null), textContent: 'x' }
    const fns = new Function('projectsState', 'ws', 'appendChatMsg', 'document', 'brainViz', 'clearChatCitations', 'window',
      fnSource('replyReference') + fnSource('showReplyAsUi') + fnSource('saveAsArtifact') + fnSource('projectChatUnsettled') + '\nreturn { show: showReplyAsUi, save: saveAsArtifact };')(
      state,
      { readyState: connected ? 1 : 3, send: (x: string) => sent.push(x) },
      (role: string, text: string) => shown.push(role + ': ' + text),
      { querySelector: (sel: string) => (sel.includes('data-reply="0"') ? reply : null) },
      { setActive: () => {} },
      () => { cleared++ },
      { prompt: () => 'Alien "designs"' },
    )
    return { ...fns, sent, shown, cleared: () => cleared }
  }

  it('sends a queued followup click whose text the engine forces, quoting the reply without its quotes', () => {
    const p = page({ active: { slug: 'yard', chat: 'c.jsonl' }, replyCount: 1 })
    p.show(0)
    expect(p.sent).toHaveLength(1)
    const frame = JSON.parse(p.sent[0])
    const text = "Show your previous reply as UI with RenderUI: the same content, no new facts. The reply to show is the one that begins: \"Here are four 'designs': just tell me plainly, no cards\"."
    expect(frame).toEqual({ type: 'ui.action', surfaceId: 'show-as-ui', action: 'followup', label: 'Show as UI', userMessage: text })
    expect(validateCommand(frame).ok).toBe(true)
    expect(isFollowUp(frame)).toBe(true)
    expect(uiRequestReason(frame.userMessage)).toBe('as ui')
    expect(p.shown).toEqual(['user: ' + text])
    expect(p.cleared()).toBe(1)
  })

  it('Save as artifact names the reply the same way and is never forced', () => {
    const p = page({ active: { slug: 'yard', chat: 'c.jsonl' }, replyCount: 1 })
    p.save(0)
    const frame = JSON.parse(p.sent[0])
    expect(frame.type).toBe('user.message')
    expect(frame.text).toBe("Save the previous reply as an artifact named \"Alien 'designs'\" using SaveArtifact. The reply to save is the one that begins: \"Here are four 'designs': just tell me plainly, no cards\".")
    expect(uiRequestReason(frame.text)).toBeNull()
  })

  it('sends nothing outside a project chat or while disconnected', () => {
    const none = page({ active: null, replyCount: 1 })
    none.show(0)
    expect(none.sent).toEqual([])
    expect(none.shown[0]).toMatch(/needs an open project chat/)
    const off = page({ active: { slug: 'yard', chat: null }, replyCount: 1 }, false)
    off.show(0)
    expect(off.sent).toEqual([])
    expect(off.shown[0]).toMatch(/Not connected/)
  })

  it('every project reply gets the link next to Save as artifact; a typed turn and a click clear the old Sources line', () => {
    const src = fnSource('markSaveableReplies')
    expect(src).toContain('onclick="saveAsArtifact(')
    expect(src).toContain('onclick="showReplyAsUi(')
    expect(fnSource('sendChatMessage')).toContain('clearChatCitations()')
    expect(fnSource('sendUiAction')).toContain('clearChatCitations()')
  })
})

// ═══ 4. generated pictures (F174) ═════════════════════════
// An Image with a "prompt" is painted by the engine; the final frame carries
// the engine's annotation (`el.image`) and `ui.image` events keyed on the
// image key fill it in. The page builds the URL from a checked key and slug
// and fetches it with the token into a blob URL — never a bare <img src>.

const KEY = 'a'.repeat(32)
const KEY2 = 'b'.repeat(32)
/** The page's name for a picture in its map: the project's slug and the key (one key can be painted in two projects). */
const P = (key: string, slug = 'p') => `${slug}/${key}`
const PROMPT = 'curving path of weathered grey flagstones through low ferns, morning light, photo'

/** One Image in a Card; `image` is the engine's annotation (omitted = none). */
function picSpec(image?: unknown, extra: Record<string, unknown> = {}) {
  const img: Record<string, unknown> = { type: 'Image', props: { prompt: PROMPT, alt: 'Stone path', caption: 'Option A', ...extra } }
  if (image !== undefined) img.image = image
  return { root: 'c', elements: { c: { type: 'Card', props: { title: 'A' }, children: ['img'] }, img } }
}
const done = (key = KEY, extra: Record<string, unknown> = {}) => ({ status: 'done', key, slug: 'p', w: 1024, h: 768, ...extra })
/** A final frame for `surface`, drawn through upsertSurface so the figure sits in the document. */
function drawPic(page: Page, surface: string, image?: unknown, partial = false) {
  return page.upsertSurface({ type: 'ui.render', toolId: 't-' + surface, surfaceId: surface, partial, spec: picSpec(image) })!
}
const fig = (el: Node) => el.querySelector('figure.genui-image-gen')!
const boxText = (el: Node) => el.querySelector('.genui-image-box')!.textContent
const tick = () => new Promise(r => setTimeout(r, 0))

describe('dashboard genui: generated pictures — wiring', () => {
  const js = scripts()

  it('handles ui.image next to ui.render, rechecks on reconnect, forgets on a cleared pane', () => {
    const arm = js.slice(js.indexOf("case 'ui.image'"), js.indexOf('break;', js.indexOf("case 'ui.image'")))
    expect(arm).toContain('applyUiImage(event)')
    expect(js.indexOf("case 'ui.image'")).toBeGreaterThan(js.indexOf("case 'ui.render'"))
    expect(js.indexOf("case 'ui.image'") - js.indexOf("case 'ui.render'")).toBeLessThan(400)
    const onopen = js.slice(js.indexOf('ws.onopen = function()'), js.indexOf('ws.onclose'))
    expect(onopen).toContain('genuiRecheckImages()')
    expect(fnSource('clearChatPane')).toContain('genuiForgetImages()')
  })

  it('never points an <img> at the API: the picture comes through fetch and a blob URL', () => {
    expect(js).not.toMatch(/setAttribute\(\s*['"]src['"]\s*,\s*['"]\/api\//)
    expect(js).not.toMatch(/\.src\s*=\s*['"]\/api\//)
    expect(fnSource('genuiLoadImage')).toContain("fetch('/api/projects/' + m.slug + '/images/' + key + '.png')")
    expect(fnSource('genuiLoadImage')).toContain('URL.createObjectURL(blob)')
    // the key and slug are checked against the engine's own patterns before any URL is built from them
    expect(js).toContain('var GENUI_IMAGE_KEY_RE = /^[0-9a-f]{32}$/;')
    expect(js).toContain('var GENUI_IMAGE_SLUG_RE = /^[a-z0-9-]{1,64}$/;')
  })

  it('styles: the box keeps the picture shape, the pulse honours reduced motion, a lightbox', () => {
    expect(html).toContain('.genui-image-box {')
    expect(html).toContain('aspect-ratio: 1 / 1')
    expect(html).toContain('@keyframes genui-pulse')
    expect(html).toContain('@media (prefers-reduced-motion: reduce) { .genui-image-pulse { animation: none; } }')
    expect(html).toContain('.genui-lightbox {')
  })
})

describe('dashboard genui: generated pictures — every state', () => {
  it('a partial frame says the picture comes later: no fetch, no key, no pulse, never "image unavailable"', () => {
    const { page, msgs, fetched } = harness()
    const el = drawPic(page, 'opts', undefined, true)
    expect(boxText(el)).toBe('Picture comes when the card is finished')
    expect(fig(el).hasAttribute('data-image-key')).toBe(false)
    expect(el.querySelector('.genui-image-box')!.classList.contains('genui-image-pulse')).toBe(false)
    expect(msgs.textContent).not.toContain('image unavailable')
    // even an annotation riding a partial frame starts nothing
    const el2 = drawPic(page, 'opts2', done(), true)
    expect(boxText(el2)).toBe('Picture comes when the card is finished')
    expect(fetched).toEqual([])
    expect(page.genuiImages).toEqual({})
    expect(el.querySelector('.genui-image-alt')!.textContent).toBe('Stone path')
    expect(el.querySelector('figcaption')!.textContent).toBe('Option A')
  })

  it('a final frame with no annotation (catalog demo, old transcript) says the picture was not generated', () => {
    const { page, fetched } = harness()
    const el = drawPic(page, 'opts')
    expect(boxText(el)).toBe('Stone path — picture not generated')
    // the box names the alt itself, so the alt line under it is hidden
    expect(el.querySelector('.genui-image-alt')!.classList.contains('genui-hidden')).toBe(true)
    expect(el.querySelector('.genui-image-box')!.style.aspectRatio).toBe('1 / 1')
    expect(fetched).toEqual([])
  })

  it('off: the alt and the engine\'s reason', () => {
    const { page } = harness()
    const el = drawPic(page, 'opts', { status: 'off', reason: 'pictures are generated in project chats only' })
    expect(boxText(el)).toBe('Stone path — pictures are generated in project chats only')
    expect(fig(el).hasAttribute('data-image-key')).toBe(false)
  })

  it('queued and running pulse; failed names the reason; the box takes the picture\'s shape', () => {
    const { page, fetched } = harness()
    const q = drawPic(page, 'q', { status: 'queued', key: KEY, slug: 'p', w: 1024, h: 768 })
    expect(boxText(q)).toBe('Picture queued…')
    expect(q.querySelector('.genui-image-box')!.classList.contains('genui-image-pulse')).toBe(true)
    expect(q.querySelector('.genui-image-box')!.style.aspectRatio).toBe('1024 / 768')
    expect(fig(q).getAttribute('data-image-key')).toBe(KEY)
    expect(q.querySelector('.genui-image-alt')!.classList.contains('genui-hidden')).toBe(false)
    const r = drawPic(page, 'r', { status: 'running', key: KEY2, slug: 'p', w: 1024, h: 1024 })
    expect(boxText(r)).toBe('Painting the picture…')
    expect(r.querySelector('.genui-image-box')!.classList.contains('genui-image-pulse')).toBe(true)
    const f = drawPic(page, 'f', { status: 'failed', key: 'c'.repeat(32), slug: 'p', w: 1024, h: 1024, reason: 'ComfyUI did not answer at http://pc:8188 (timeout)' })
    expect(boxText(f)).toBe('Picture failed: ComfyUI did not answer at http://pc:8188 (timeout)')
    expect(f.querySelector('.genui-image-box')!.classList.contains('genui-image-pulse')).toBe(false)
    expect(f.querySelector('.genui-image-box')!.classList.contains('genui-image-failed')).toBe(true)
    expect(fetched).toEqual([])
  })

  it('done: "Loading picture…", one fetch of /api/projects/p/images/<key>.png, then an <img> on the blob URL', async () => {
    const { page, fetched, blobs } = harness({ fetch: async () => reply(200, 'image/png') })
    const el = drawPic(page, 'opts', done())
    expect(boxText(el)).toBe('Loading picture…')
    expect(fetched).toEqual([`/api/projects/p/images/${KEY}.png`])
    await tick()
    const img = el.querySelector('.genui-image-box img')!
    expect(img.getAttribute('src')).toBe('blob:page/1')
    expect(img.getAttribute('alt')).toBe('Stone path')
    expect(blobs.created).toEqual([{ blob: 'png-bytes' }])
    expect(page.genuiImages[P(KEY)]).toMatchObject({ status: 'done', url: 'blob:page/1', loading: false })
    // a second surface showing the same key draws at once from the cached blob URL: no second fetch
    const again = drawPic(page, 'other', done())
    expect(again.querySelector('.genui-image-box img')!.getAttribute('src')).toBe('blob:page/1')
    expect(fetched).toHaveLength(1)
  })

  it('a refused or wrong-typed load marks the picture failed with the HTTP status', async () => {
    const { page } = harness({ fetch: async (u) => (u.includes(KEY) ? reply(401, 'application/json') : reply(200, 'text/html')) })
    const a = drawPic(page, 'a', done())
    const b = drawPic(page, 'b', done(KEY2))
    await tick()
    expect(boxText(a)).toBe('Picture failed: could not load the picture (HTTP 401)')
    expect(boxText(b)).toBe('Picture failed: could not load the picture (HTTP 200, text/html)')
    expect(a.querySelector('img')).toBeNull()
  })

  it('an annotation with a bad key, slug or status draws as off: "bad picture reference"', () => {
    const { page, fetched } = harness()
    for (const [i, im] of [
      done('A'.repeat(32)), done('a'.repeat(31)), done('../../x'), { ...done(), slug: '../p' }, { ...done(), slug: 'P' },
      { ...done(), status: 'painted' }, { ...done(), key: 7 }, { ...done(), status: '__proto__' },
    ].entries()) {
      const el = drawPic(page, 'bad' + i, im)
      expect(boxText(el), JSON.stringify(im)).toBe('Stone path — bad picture reference')
      expect(fig(el).hasAttribute('data-image-key')).toBe(false)
    }
    expect(fetched).toEqual([])
    expect(page.genuiImages).toEqual({})
  })

  it('a URL Image while the call streams: the neutral placeholder, no "Load image from" button; the final frame draws it', () => {
    const { page } = harness()
    const spec = (src: string) => ({ root: 'i', elements: { i: { type: 'Image', props: { src, alt: 'River table' } } } })
    const el = page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'ref', partial: true, spec: spec('https://exa') })!
    expect(el.querySelector('.genui-image-ph')!.textContent).toBe('River table')
    expect(el.querySelector('button')).toBeNull()
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'ref', partial: false, spec: spec('https://example.com/t.jpg') })
    expect(el.querySelector('button.genui-image-load')!.textContent).toBe('Load image from example.com')
    expect(el.querySelector('img')).toBeNull()
  })
})

describe('dashboard genui: generated pictures — ui.image and the map', () => {
  it('applyUiImage fills every figure showing the key and leaves the others alone', async () => {
    const { page, fetched } = harness({ fetch: async () => reply(200, 'image/png') })
    const queued = { status: 'queued', key: KEY, slug: 'p', w: 1024, h: 1024 }
    const a = drawPic(page, 'a', queued)
    const b = drawPic(page, 'b', queued)
    const c = drawPic(page, 'c', { ...queued, key: KEY2 })
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'running' })
    expect([boxText(a), boxText(b), boxText(c)]).toEqual(['Painting the picture…', 'Painting the picture…', 'Picture queued…'])
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })
    expect(fetched).toEqual([`/api/projects/p/images/${KEY}.png`])
    await tick()
    expect(a.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    expect(b.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    page.applyUiImage({ type: 'ui.image', key: KEY2, slug: 'p', status: 'failed', reason: 'interrupted on the ComfyUI PC' })
    expect(boxText(c)).toBe('Picture failed: interrupted on the ComfyUI PC')
  })

  it('a late event for a key no surface shows only updates the map; a malformed one is ignored', () => {
    const { page, fetched } = harness()
    expect(() => page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })).not.toThrow()
    expect(page.genuiImages[P(KEY)]).toMatchObject({ status: 'done', slug: 'p', url: '' })
    expect(fetched).toEqual([]) // nothing shows it, so nothing is fetched
    for (const bad of [
      { key: 'x', slug: 'p', status: 'done' }, { key: KEY2, slug: '../p', status: 'done' }, { key: KEY2, slug: 'p', status: 'painted' },
      { key: KEY2, slug: 'p' }, null, 'ui.image',
    ]) expect(() => page.applyUiImage(bad as any)).not.toThrow()
    expect(Object.keys(page.genuiImages)).toEqual([P(KEY)])
  })

  it('merge: done never goes back; a fresh queued/running replaces a failure; otherwise the more advanced status wins', () => {
    const { page } = harness()
    const ev = (key: string, status: string, reason?: string) => page.applyUiImage({ type: 'ui.image', key, slug: 'p', status, reason })
    ev(KEY, 'done')
    ev(KEY, 'failed', 'late')
    ev(KEY, 'running')
    expect(page.genuiImages[P(KEY)].status).toBe('done')
    ev(KEY2, 'failed', 'ComfyUI did not finish within 300 s')
    const el = drawPic(page, 'retry', { status: 'queued', key: KEY2, slug: 'p', w: 1024, h: 1024 })
    expect(page.genuiImages[P(KEY2)]).toMatchObject({ status: 'queued', reason: '' })
    expect(boxText(el)).toBe('Picture queued…')
    ev(KEY2, 'running')
    drawPic(page, 'stale', { status: 'queued', key: KEY2, slug: 'p', w: 1024, h: 1024 })
    expect(page.genuiImages[P(KEY2)].status).toBe('running')
    expect(boxText(el)).toBe('Painting the picture…')
  })

  // Completeness review: the key hashes how a picture is made, not where, so two
  // projects asking for one prompt run two jobs under one key. A job still in
  // the FIFO for project q must neither fill nor fail project p's card.
  it('a picture is its project and its key: an event for the same key from another project leaves the card alone', async () => {
    const { page, fetched } = harness({ fetch: async () => reply(200, 'image/png') })
    const el = drawPic(page, 'mine', { status: 'queued', key: KEY, slug: 'p', w: 1024, h: 1024 })
    expect(fig(el).getAttribute('data-image-slug')).toBe('p')
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'q', status: 'running' })
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'q', status: 'failed', reason: 'interrupted on the ComfyUI PC' })
    expect(boxText(el)).toBe('Picture queued…')
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'q', status: 'done' })
    expect(boxText(el)).toBe('Picture queued…')
    expect(fetched).toEqual([]) // nothing shows q's picture, so nothing fetches it — least of all into p's card
    expect(page.genuiImages[P(KEY)]).toMatchObject({ status: 'queued', slug: 'p', key: KEY })
    expect(page.genuiImages[P(KEY, 'q')]).toMatchObject({ status: 'done', slug: 'q', key: KEY })
    // p's own events still land, and the picture comes from p
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })
    expect(fetched).toEqual([`/api/projects/p/images/${KEY}.png`])
    await tick()
    expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    // q's events do not even redraw p's card
    const shown = el.querySelector('img')
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'q', status: 'failed', reason: 'x' })
    expect(el.querySelector('img')).toBe(shown)
  })

  it('a card for each project showing one key: each fills from its own project', async () => {
    const { page, fetched } = harness({ fetch: async () => reply(200, 'image/png') })
    const p = drawPic(page, 'in-p', { status: 'running', key: KEY, slug: 'p', w: 1024, h: 1024 })
    const q = drawPic(page, 'in-q', { status: 'queued', key: KEY, slug: 'q', w: 1024, h: 1024 })
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'q', status: 'done' })
    expect(boxText(p)).toBe('Painting the picture…')
    expect(fetched).toEqual([`/api/projects/q/images/${KEY}.png`])
    await tick()
    expect(q.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    expect(p.querySelector('img')).toBeNull()
  })

  // failed ranks below done on purpose: the page's own load failure turns a
  // done picture failed, and a later done — an event, a recheck or a re-render
  // that finds it made — must fetch it again, not stay failed.
  it('a picture whose load failed is fetched again by a later done event or a re-render that finds it made', async () => {
    let answer = 401
    const { page, fetched } = harness({ fetch: async () => (answer === 200 ? reply(200, 'image/png') : reply(answer, 'application/json')) })
    const el = drawPic(page, 'opts', done())
    await tick()
    expect(boxText(el)).toBe('Picture failed: could not load the picture (HTTP 401)')
    expect(page.genuiImages[P(KEY)]).toMatchObject({ status: 'failed', url: '', loading: false })
    // a done event: fetched again
    answer = 503
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })
    expect(fetched).toEqual([`/api/projects/p/images/${KEY}.png`, `/api/projects/p/images/${KEY}.png`])
    await tick()
    expect(boxText(el)).toBe('Picture failed: could not load the picture (HTTP 503)')
    // a re-render whose annotation finds the picture made: fetched again, and this time shown
    answer = 200
    const again = drawPic(page, 'again', done())
    expect(fetched).toHaveLength(3)
    await tick()
    expect(again.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    // and once shown, a late failure never takes it back
    page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'failed', reason: 'late' })
    expect(page.genuiImages[P(KEY)]).toMatchObject({ status: 'done', url: 'blob:page/1' })
  })

  it('the recheck after a reconnect asks the record of queued/running pictures only and applies it', async () => {
    const answers: Record<string, unknown> = {
      [`/api/projects/p/images/${KEY}.json`]: { status: 'done', w: 1024, h: 1024 },
      [`/api/projects/p/images/${KEY2}.json`]: { status: 'failed', reason: 'interrupted — the engine stopped before this picture finished' },
    }
    const { page, fetched } = harness({ fetch: async (u) => (u.endsWith('.json') ? reply(200, 'application/json', answers[u]) : reply(200, 'image/png')) })
    const a = drawPic(page, 'a', { status: 'running', key: KEY, slug: 'p', w: 1024, h: 1024 })
    const b = drawPic(page, 'b', { status: 'queued', key: KEY2, slug: 'p', w: 1024, h: 1024 })
    page.applyUiImage({ type: 'ui.image', key: 'd'.repeat(32), slug: 'p', status: 'failed', reason: 'x' })
    page.applyUiImage({ type: 'ui.image', key: 'e'.repeat(32), slug: 'p', status: 'done' })
    page.genuiRecheckImages()
    expect(fetched.sort()).toEqual([`/api/projects/p/images/${KEY}.json`, `/api/projects/p/images/${KEY2}.json`])
    await tick(); await tick()
    expect(fetched).toContain(`/api/projects/p/images/${KEY}.png`)
    await tick()
    expect(a.querySelector('img')!.getAttribute('src')).toMatch(/^blob:page\//)
    expect(boxText(b)).toBe('Picture failed: interrupted — the engine stopped before this picture finished')
  })

  it('a cleared pane frees every blob URL and empties the map in place', async () => {
    const { page, blobs } = harness({ fetch: async () => reply(200, 'image/png') })
    drawPic(page, 'a', done())
    await tick()
    const map = page.genuiImages
    page.genuiForgetImages()
    expect(blobs.revoked).toEqual(['blob:page/1'])
    expect(map).toEqual({})
  })
})

describe('dashboard genui: generated pictures — the lightbox', () => {
  async function opened() {
    const h = harness({ fetch: async () => reply(200, 'image/png') })
    const el = drawPic(h.page, 'opts', done())
    await tick()
    el.querySelector('button.genui-image-open')!.fire('click')
    return { ...h, el, box: h.document.body.querySelector('.genui-lightbox') }
  }

  it('a click on a done picture opens the picture with its alt, prompt and a Download link named after the alt', async () => {
    const { box } = await opened()
    expect(box).not.toBeNull()
    expect(box!.getAttribute('role')).toBe('dialog')
    expect(box!.querySelector('img.genui-lightbox-img')!.getAttribute('src')).toBe('blob:page/1')
    expect(box!.querySelector('.genui-lightbox-alt')!.textContent).toBe('Stone path')
    expect(box!.querySelector('.genui-lightbox-prompt')!.textContent).toBe(PROMPT)
    const dl = box!.querySelector('a')!
    expect(dl.textContent).toBe('Download')
    expect(dl.getAttribute('href')).toBe('blob:page/1')
    expect(dl.getAttribute('download')).toBe(`stone-path-${KEY.slice(0, 8)}.png`)
  })

  it('Escape, the backdrop and Close each close it; a click inside the panel does not', async () => {
    const esc = await opened()
    esc.document.fire('keydown', { key: 'Enter' })
    expect(esc.document.body.querySelector('.genui-lightbox')).not.toBeNull()
    esc.document.fire('keydown', { key: 'Escape' })
    expect(esc.document.body.querySelector('.genui-lightbox')).toBeNull()
    expect(esc.document.listeners.keydown).toEqual([])

    const back = await opened()
    const panel = back.box!.querySelector('.genui-lightbox-panel')!
    back.box!.fire('click', { target: panel })
    expect(back.document.body.querySelector('.genui-lightbox')).not.toBeNull()
    back.box!.fire('click', { target: back.box })
    expect(back.document.body.querySelector('.genui-lightbox')).toBeNull()

    const close = await opened()
    close.box!.querySelector('button.genui-lightbox-btn')!.fire('click')
    expect(close.document.body.querySelector('.genui-lightbox')).toBeNull()
    // only one at a time
    close.el.querySelector('button.genui-image-open')!.fire('click')
    close.el.querySelector('button.genui-image-open')!.fire('click')
    expect(close.document.body.querySelectorAll('.genui-lightbox')).toHaveLength(1)
  })

  it('the download name falls back to "picture" and caps the alt at 40 characters', async () => {
    const h = harness({ fetch: async () => reply(200, 'image/png') })
    const spec = (alt: string, key: string) => ({ root: 'i', elements: { i: { type: 'Image', props: { prompt: PROMPT, alt }, image: done(key) } } })
    const a = h.page.upsertSurface({ type: 'ui.render', toolId: 'ta', surfaceId: 'a', partial: false, spec: spec('!!!', KEY) })!
    const b = h.page.upsertSurface({ type: 'ui.render', toolId: 'tb', surfaceId: 'b', partial: false, spec: spec('A very long title for a walnut river table with a blue resin river', KEY2) })!
    await tick()
    a.querySelector('button.genui-image-open')!.fire('click')
    expect(h.document.body.querySelector('.genui-lightbox a')!.getAttribute('download')).toBe(`picture-${KEY.slice(0, 8)}.png`)
    b.querySelector('button.genui-image-open')!.fire('click')
    const name = h.document.body.querySelector('.genui-lightbox a')!.getAttribute('download')!
    expect(name).toBe(`a-very-long-title-for-a-walnut-river-tab-${KEY2.slice(0, 8)}.png`)
    expect(name.length - `-${KEY2.slice(0, 8)}.png`.length).toBeLessThanOrEqual(40)
  })
})

describe('dashboard genui: generated pictures — the pane changes conversation (stage C review)', () => {
  /**
   * The Chat pane's own functions (clearChatPane, renderTranscript,
   * openProjectChat, onProjectOpened) compiled in one scope with the genui
   * section, so they share its picture map; what they call outside it is
   * stubbed. `transcript` answers fetchTranscript; the pane's lines are plain
   * nodes in #chatMessages.
   */
  function paneHarness(transcript: (file: string) => Promise<unknown>, state: Record<string, unknown> = {}) {
    const document = makeDocument()
    const msgs = new Node('div'); msgs.id = 'chatMessages'; document.body.appendChild(msgs)
    for (const id of ['chatProjectStrip', 'chatProjectLabel']) { const n = new Node('div'); n.id = id; document.body.appendChild(n) }
    const fetched: string[] = []
    const blobs = { created: [] as unknown[], revoked: [] as string[] }
    const projectsState = { active: null, renderedChat: null, openedSeq: 0, names: { p: 'P' }, paths: { p: '/x' }, slug: null, ...state }
    const env: Record<string, unknown> = {
      document, projectsState,
      ws: { readyState: 1, send: () => {} },
      appendChatMsg: (role: string, text: string) => { const n = new Node('div'); n.className = 'chat-msg'; n.textContent = role + ': ' + text; msgs.appendChild(n) },
      brainViz: { setActive: () => {} },
      fetch: async (url: string) => { fetched.push(url); return reply(200, 'image/png') },
      URL: {
        createObjectURL: (b: unknown) => { blobs.created.push(b); return 'blob:page/' + blobs.created.length },
        revokeObjectURL: (u: string) => { blobs.revoked.push(u) },
      },
      fetchTranscript: (_slug: string, file: string) => transcript(file),
      appendChatTool: () => 'row', summarizeInput: () => '', clearChatCitations: () => {}, restoreCodingCwd: () => {},
      showConnProject: () => {}, parseProjectsHash: () => null, history: { replaceState: () => {} }, showProjectCwd: () => {},
      projFetch: () => new Promise(() => {}), projUrl: (s: string) => '/api/projects/' + s, loadProjectChats: () => {},
      markSaveableReplies: () => {}, projStatus: () => {}, switchTab: () => {},
    }
    const names = Object.keys(env)
    const page = new Function(...names, fnSource('escHtml') + '\n' + genuiSection() + '\n' +
      ['clearChatPane', 'renderTranscript', 'openProjectChat', 'onProjectOpened'].map(fnSource).join('\n') +
      '\nreturn { upsertSurface: upsertSurface, applyUiImage: applyUiImage, genuiImages: genuiImages,' +
      ' openProjectChat: openProjectChat, onProjectOpened: onProjectOpened };')(...names.map(n => env[n])) as {
      upsertSurface: Page['upsertSurface']; applyUiImage: Page['applyUiImage']; genuiImages: Page['genuiImages']
      openProjectChat: (slug: string, file: string | null) => Promise<unknown> | undefined
      onProjectOpened: (event: Record<string, unknown>) => Promise<unknown> | undefined
    }
    return { page, document, msgs, fetched, blobs, projectsState }
  }
  /** A stored chat whose one RenderUI call shows KEY with the state the server read from its record. */
  const storedChat = (status: string) => ({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'RenderUI',
      input: { surface: 'aliens', spec: picSpec({ status, key: KEY, slug: 'p', w: 1024, h: 1024 }) } }] },
  ] })
  const held = () => { let open!: (t: unknown) => void; const p = new Promise(r => { open = r }); return { p, open } }
  const KEY3 = 'c'.repeat(32)

  it('reopening a chat: a done ui.image that lands while the transcript loads beats the record the server read', async () => {
    const t = held()
    const h = paneHarness(() => t.p)
    // the chat the pane showed before: its loaded picture is freed by the first clear
    h.page.upsertSurface({ type: 'ui.render', toolId: 'old', surfaceId: 'old', partial: false, spec: picSpec(done(KEY2)) })
    await tick()
    const opening = h.page.openProjectChat('p', 'c.jsonl')
    expect(h.blobs.revoked).toEqual(['blob:page/1'])
    // the server read the sidecar as "running"; the picture finishes before the page reads the reply
    h.page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })
    t.open(storedChat('running'))
    await opening
    await tick()
    expect(h.page.genuiImages[P(KEY)]).toMatchObject({ status: 'done', url: 'blob:page/2' })
    expect(h.msgs.querySelector('.genui-image-box img')!.getAttribute('src')).toBe('blob:page/2')
    expect(h.fetched).toEqual([`/api/projects/p/images/${KEY2}.png`, `/api/projects/p/images/${KEY}.png`])
  })

  it('reopening a chat: a picture the old conversation drew while the transcript loaded is freed with it', async () => {
    const t = held()
    const h = paneHarness(() => t.p)
    const opening = h.page.openProjectChat('p', 'c.jsonl')
    // the engine is still bound to the last chat until the transcript is drawn: its turn can draw meanwhile
    h.page.upsertSurface({ type: 'ui.render', toolId: 'late', surfaceId: 'late', partial: false, spec: picSpec(done(KEY2)) })
    await tick()
    expect(h.page.genuiImages[P(KEY2)].url).toBe('blob:page/1')
    t.open(storedChat('queued'))
    await opening
    expect(h.blobs.revoked).toEqual(['blob:page/1'])
    expect(Object.keys(h.page.genuiImages)).toEqual([P(KEY)])
  })

  it('a new project chat empties the pane through clearChatPane: the old pictures\' blob URLs are freed, the map emptied', async () => {
    const h = paneHarness(() => new Promise(() => {}), { active: { slug: 'p', chat: 'c.jsonl', title: 'Old' }, renderedChat: 'p/c.jsonl' })
    h.page.upsertSurface({ type: 'ui.render', toolId: 'old', surfaceId: 'old', partial: false, spec: picSpec(done()) })
    await tick()
    h.page.onProjectOpened({ type: 'project.opened', slug: 'p', chat: null, title: null })
    expect(h.document.body.querySelectorAll('[data-image-key]')).toHaveLength(0)
    expect(h.blobs.revoked).toEqual(['blob:page/1'])
    expect(h.page.genuiImages).toEqual({})
  })

  it('a reconnect into another bound chat frees the stale chat\'s pictures and keeps the live turn\'s and any newer state', async () => {
    const t = held()
    const h = paneHarness(() => t.p, { active: { slug: 'p', chat: 'old.jsonl', title: 'Old' }, renderedChat: 'p/old.jsonl' })
    h.page.upsertSurface({ type: 'ui.render', toolId: 'stale', surfaceId: 'stale', partial: false, spec: picSpec(done(KEY3)) })
    await tick()
    expect(h.page.genuiImages[P(KEY3)].url).toBe('blob:page/1')
    const opened = h.page.onProjectOpened({ type: 'project.opened', slug: 'p', chat: 'other.jsonl', title: 'Other' })
    // this chat's live turn streams in while the transcript loads: a cached picture, already shown
    const live = h.page.upsertSurface({ type: 'ui.render', toolId: 'live', surfaceId: 'live', partial: false, spec: picSpec(done(KEY2)) })!
    await tick()
    expect(live.querySelector('img')!.getAttribute('src')).toBe('blob:page/2')
    // and a stored picture finishes after the server read its record as running
    h.page.applyUiImage({ type: 'ui.image', key: KEY, slug: 'p', status: 'done' })
    t.open(storedChat('running'))
    await opened
    await tick()
    expect(h.blobs.revoked).toEqual(['blob:page/1'])
    expect(Object.keys(h.page.genuiImages).sort()).toEqual([P(KEY), P(KEY2)])
    expect(live.querySelector('img')!.getAttribute('src')).toBe('blob:page/2')
    expect(h.page.genuiImages[P(KEY)]).toMatchObject({ status: 'done', url: 'blob:page/3' })
  })
})

describe('dashboard genui: generated pictures — a withdrawn or cramped card (stage C review)', () => {
  it('a streaming surface withdrawn before its final frame no longer promises the picture', () => {
    const { page, fetched } = harness()
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 't1', partial: true, spec: picSpec() })
    const el = page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 't1', partial: false, spec: null, errors: ['the turn was stopped before this call finished'] })!
    expect(el.classList.contains('genui-withdrawn')).toBe(true)
    expect(boxText(el)).toBe('Stone path — picture not generated (the card was not finished)')
    expect(el.querySelector('.genui-image-alt')!.classList.contains('genui-hidden')).toBe(true)
    expect(el.querySelector('.genui-image-box')!.classList.contains('genui-image-pulse')).toBe(false)
    expect(fetched).toEqual([])
  })

  it('a withdrawn surface leaves a picture the engine already reported alone', () => {
    const { page } = harness()
    const el = page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'opts', partial: false, spec: picSpec({ status: 'queued', key: KEY, slug: 'p', w: 1024, h: 1024 }) })!
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'opts', partial: false, spec: null, errors: ['x'] })
    expect(boxText(el)).toBe('Picture queued…')
    const off = page.upsertSurface({ type: 'ui.render', toolId: 't2', surfaceId: 'off', partial: false, spec: picSpec({ status: 'off', reason: 'pictures are generated in project chats only' }) })!
    page.upsertSurface({ type: 'ui.render', toolId: 't2', surfaceId: 'off', partial: false, spec: null, errors: ['x'] })
    expect(boxText(off)).toBe('Stone path — pictures are generated in project chats only')
  })

  it('a long reason in a small box scrolls inside it instead of being cut off top and bottom', () => {
    const rule = (sel: string) => { const i = html.indexOf(sel + ' {'); return html.slice(i, html.indexOf('}', i)) }
    expect(rule('.genui-image-msg')).toContain('max-height: 100%')
    expect(rule('.genui-image-msg')).toContain('overflow-y: auto')
    expect(rule('.genui-image-box')).toContain('align-items: safe center')
  })
})

// ═══ 5. pictures from project files ═══════════════════════
// An Image whose src is a relative image path shows a file the model wrote
// into the project (dashboard transcript, 2026-10-11: 1:1 printable SVG
// templates the page could not show). The engine's annotation carries
// `{ status: 'file', slug, path }` and the page treats it like a done
// generated picture: a fetch of /api/projects/:slug/files/<path> with the
// token, a blob URL in an <img>, the lightbox, a Download named after the
// file. Never inline, never innerHTML: an SVG in an <img> runs no script.

const PATH = 'tower/templates/tower_v1.1_30in.svg'
const fileState = (path = PATH, slug = 'p') => ({ status: 'file', slug, path })
const F = (path = PATH, slug = 'p') => `${slug}/file:${path}`
function fileSpec(image?: unknown) {
  const img: Record<string, unknown> = { type: 'Image', props: { alt: 'Tower template', caption: '30 in' } }
  if (image !== undefined) img.image = image
  return { root: 'c', elements: { c: { type: 'Card', props: { title: 'Templates' }, children: ['img'] }, img } }
}
function drawFile(page: Page, surface: string, image?: unknown, partial = false) {
  return page.upsertSurface({ type: 'ui.render', toolId: 't-' + surface, surfaceId: surface, partial, spec: fileSpec(image) })!
}

describe('dashboard genui: pictures from project files — wiring', () => {
  const js = scripts()

  it('checks the path against the engine\'s own rule before it builds a URL, builds the URL segment by segment, and never writes HTML', () => {
    expect(js).toContain('var GENUI_IMAGE_PATH_RE = ' + PROJECT_IMAGE_PATH_RE.toString() + ';')
    expect(js).toContain('var GENUI_IMAGE_PATH_MAX = 200;')
    expect(fnSource('genuiFileUrl')).toContain("'/api/projects/' + slug + '/files/' + path.split('/').map(encodeURIComponent).join('/')")
    for (const fn of ['genuiGeneratedImage', 'genuiFillImage', 'genuiLoadImage', 'genuiOpenLightbox', 'genuiImageAnnotation', 'genuiMergeFile', 'genuiFileUrl']) {
      expect(fnSource(fn), fn).not.toContain('innerHTML')
      expect(fnSource(fn), fn).not.toContain('insertAdjacentHTML')
    }
    expect(js).not.toMatch(/setAttribute\(\s*['"]src['"]\s*,\s*['"]\/api\//)
    expect(js).not.toMatch(/\.src\s*=\s*['"]\/api\//)
    // only an <img> ever shows it: no <object>, <embed>, <iframe> or inline <svg> from a file
    for (const fn of ['genuiFillImage', 'genuiOpenLightbox']) {
      expect(fnSource(fn), fn).not.toMatch(/genuiEl\('(object|embed|iframe|svg)'/)
      expect(fnSource(fn), fn).not.toMatch(/createElementNS/)
    }
  })
})

describe('dashboard genui: pictures from project files — every state', () => {
  it('file: "Loading <name>…", one fetch of /api/projects/p/files/<path> with each segment encoded, then an <img> on the blob URL', async () => {
    const { page, fetched, blobs } = harness({ fetch: async () => reply(200, 'image/svg+xml') })
    const el = drawFile(page, 'opts', fileState())
    expect(fig(el)).not.toBeNull()
    expect(boxText(el)).toBe('Loading tower_v1.1_30in.svg…')
    expect(fetched).toEqual(['/api/projects/p/files/tower/templates/tower_v1.1_30in.svg'])
    expect(fig(el).getAttribute('data-image-key')).toBe('file:' + PATH)
    expect(fig(el).getAttribute('data-image-slug')).toBe('p')
    await tick()
    const img = el.querySelector('.genui-image-box img')!
    expect(img.getAttribute('src')).toBe('blob:page/1')
    expect(img.getAttribute('alt')).toBe('Tower template')
    expect(el.querySelector('figcaption')!.textContent).toBe('30 in')
    expect(blobs.created).toEqual([{ blob: 'png-bytes' }])
    expect(page.genuiImages[F()]).toMatchObject({ status: 'done', url: 'blob:page/1', loading: false, path: PATH, key: 'file:' + PATH, slug: 'p' })
    // a path with spaces and parentheses is encoded per segment (its own harness: the stub's selector matcher cannot refill a name with a space)
    const spaced = harness()
    drawFile(spaced.page, 'sp', fileState('my tower (v2)/front view.png'))
    expect(spaced.fetched).toEqual(['/api/projects/p/files/my%20tower%20(v2)/front%20view.png'])
    // the box takes the file's own shape: no fixed aspect ratio
    expect(el.querySelector('.genui-image-box')!.style.aspectRatio).toBe('auto')
  })

  it('a failed load names the file and the HTTP status; a wrong type counts as a failure; a later frame fetches it again', async () => {
    let answer: FakeReply = reply(404, 'application/json')
    const { page, fetched } = harness({ fetch: async () => answer })
    const el = drawFile(page, 'opts', fileState())
    await tick()
    expect(boxText(el)).toBe('tower/templates/tower_v1.1_30in.svg could not be loaded (HTTP 404)')
    expect(el.querySelector('.genui-image-box')!.classList.contains('genui-image-failed')).toBe(true)
    expect(el.querySelector('img')).toBeNull()
    expect(page.genuiImages[F()]).toMatchObject({ status: 'failed', url: '' })
    answer = reply(200, 'text/html')
    const again = drawFile(page, 'opts', fileState())
    expect(fetched).toHaveLength(2)
    await tick()
    expect(boxText(again)).toBe('tower/templates/tower_v1.1_30in.svg could not be loaded (HTTP 200, text/html)')
    answer = reply(200, 'image/svg+xml')
    const third = drawFile(page, 'opts', fileState())
    expect(fetched).toHaveLength(3)
    await tick()
    expect(third.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
  })

  it('a new final frame fetches a shown file again (it may have changed) and keeps the old picture until the new one is in', async () => {
    const { page, fetched, blobs } = harness({ fetch: async () => reply(200, 'image/png') })
    const a = drawFile(page, 'a', fileState('front.png'))
    await tick()
    expect(a.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    // a second surface showing the same file draws the picture at once and asks for it again
    const b = drawFile(page, 'b', fileState('front.png'))
    expect(b.querySelector('img')!.getAttribute('src')).toBe('blob:page/1')
    expect(fetched).toHaveLength(2)
    await tick()
    expect(b.querySelector('img')!.getAttribute('src')).toBe('blob:page/2')
    expect(a.querySelector('img')!.getAttribute('src')).toBe('blob:page/2')
    expect(blobs.revoked).toEqual(['blob:page/1'])
    expect(page.genuiImages[F('front.png')]).toMatchObject({ status: 'done', url: 'blob:page/2', stale: false, loading: false })
  })

  it('off (a coding session): the reason in the box and no fetch; a bad reference draws as off', () => {
    const { page, fetched } = harness()
    const off = drawFile(page, 'off', { status: 'off', reason: 'files are shown in project chats only' })
    expect(boxText(off)).toBe('Tower template — files are shown in project chats only')
    for (const [i, im] of [
      fileState('../x.png'), fileState('x.html'), fileState('/etc/passwd.png'), fileState('a\\b.png'), fileState(PATH, 'P'), fileState(PATH, '../p'),
      fileState('a'.repeat(197) + '.png'), { status: 'file', slug: 'p' }, { status: 'file', slug: 'p', path: 7 }, { status: 'file', slug: 'p', path: 'x.svg?v=1' },
    ].entries()) {
      const el = drawFile(page, 'bad' + i, im)
      expect(boxText(el), JSON.stringify(im)).toBe('Tower template — bad file reference')
      expect(fig(el).hasAttribute('data-image-key')).toBe(false)
    }
    expect(fetched).toEqual([])
    expect(page.genuiImages).toEqual({})
  })

  it('a partial frame with a path src draws the neutral placeholder and never a fetch; an unannotated path draws the placeholder', () => {
    const { page, fetched } = harness()
    const spec = (src: string) => ({ root: 'i', elements: { i: { type: 'Image', props: { src, alt: 'Tower template' } } } })
    const el = page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'ref', partial: true, spec: spec('tower/templ') })!
    expect(el.querySelector('.genui-image-ph')!.textContent).toBe('Tower template')
    expect(el.querySelector('button')).toBeNull()
    page.upsertSurface({ type: 'ui.render', toolId: 't1', surfaceId: 'ref', partial: false, spec: spec(PATH) })
    expect(el.querySelector('.genui-image-ph')!.textContent).toBe('Tower template')
    expect(el.querySelector('img')).toBeNull()
    expect(fetched).toEqual([])
  })

  it('the lightbox shows the file with its alt and path and downloads it under its own name; a cleared pane frees it', async () => {
    const h = harness({ fetch: async () => reply(200, 'image/svg+xml') })
    const el = drawFile(h.page, 'opts', fileState())
    await tick()
    el.querySelector('button.genui-image-open')!.fire('click')
    const box = h.document.body.querySelector('.genui-lightbox')!
    expect(box.querySelector('img.genui-lightbox-img')!.getAttribute('src')).toBe('blob:page/1')
    expect(box.querySelector('.genui-lightbox-alt')!.textContent).toBe('Tower template')
    expect(box.querySelector('.genui-lightbox-prompt')!.textContent).toBe(PATH)
    const dl = box.querySelector('a')!
    expect(dl.getAttribute('href')).toBe('blob:page/1')
    expect(dl.getAttribute('download')).toBe('tower_v1.1_30in.svg')
    h.page.genuiForgetImages()
    expect(h.blobs.revoked).toEqual(['blob:page/1'])
    expect(h.page.genuiImages).toEqual({})
    expect(h.document.body.querySelector('.genui-lightbox')).toBeNull()
  })

  it('the recheck after a reconnect never asks about a file', () => {
    const { page, fetched } = harness()
    drawFile(page, 'a', fileState())
    expect(fetched).toHaveLength(1)
    page.genuiRecheckImages()
    expect(fetched).toHaveLength(1)
  })
})
