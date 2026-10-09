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
import { genuiExampleCall } from '../../genui/prompt.js'

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
  return {
    body,
    createElement: (tag: string) => new Node(tag),
    createElementNS: (ns: string, tag: string) => new Node(tag, ns),
    getElementById: (id: string) => body.descendants().find(n => n.id === id) ?? null,
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  }
}

type Page = {
  renderUiSpec: (spec: unknown, el: Node, ctx?: Record<string, unknown>) => Record<string, any>
  upsertSurface: (event: Record<string, unknown>) => Node | null
  sendUiAction: (surfaceId: string, action: string, label?: string, context?: unknown, userMessage?: string) => boolean
  finalizeGenuiSurfaces: () => void
  GENUI_RENDERERS: Record<string, unknown>
  genuiToolRows: Record<string, string>
}

/** The page's genui section running against the stub document and a recording socket. */
function harness(opts: { wsOpen?: boolean; project?: boolean; cwd?: string | null } = {}) {
  const document = makeDocument()
  const msgs = new Node('div'); msgs.id = 'chatMessages'; document.body.appendChild(msgs)
  if (opts.cwd !== null) { const box = new Node('input'); box.id = 'chatCwd'; box.value = opts.cwd ?? ''; document.body.appendChild(box) }
  const sent: Record<string, unknown>[] = []
  const said: [string, string][] = []
  const make = new Function('document', 'ws', 'appendChatMsg', 'brainViz', 'projectsState',
    fnSource('escHtml') + '\n' + genuiSection() +
    '\nreturn { renderUiSpec: renderUiSpec, upsertSurface: upsertSurface, sendUiAction: sendUiAction,' +
    ' finalizeGenuiSurfaces: finalizeGenuiSurfaces, GENUI_RENDERERS: GENUI_RENDERERS, genuiToolRows: genuiToolRows };')
  const page = make(
    document,
    { readyState: opts.wsOpen === false ? 3 : 1, send: (s: string) => sent.push(JSON.parse(s)) },
    (role: string, text: string) => said.push([role, text]),
    { setActive: () => {} },
    { active: opts.project ? { slug: 'p', chat: 'c' } : null },
  ) as Page
  return { page, document, msgs, sent, said }
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
