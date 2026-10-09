/**
 * engine/genui/spec.ts — turn whatever the model wrote into a spec the page can draw.
 *
 * `validateSpec` never throws. It resolves component names case-insensitively,
 * relocates fields the model put at the wrong level (json-render's
 * `*_in_props` mistakes, both directions), coerces the shapes a 27B model
 * reaches for (numbers as strings, string option lists, chart `data` pairs,
 * table rows as objects, a nested tree instead of a flat map), drops what it
 * cannot draw and REPORTS every lossy decision so the model can fix the next
 * call. In `partial` mode (a half-streamed buffer repaired by jsonrepair) the
 * same pass runs silently: half-typed names and dangling ids are skipped
 * without errors because the next frame will complete them.
 */
import type { UiSpec, UiElement } from '../bridge/protocol.js'
import { GENUI_CATALOG, resolveComponentName, type PropDef, type ComponentDef } from './catalog.js'

export type { UiSpec, UiElement }

export const LIMITS = {
  /** Elements kept per surface (insertion order); sized to the 16k default output budget. */
  elements: 300,
  /** Items kept per array prop (table rows, chart points, options). */
  arrayItems: 500,
  /** Characters kept per string prop. */
  stringChars: 8000,
  /** Nesting depth from root. */
  depth: 24,
  idPattern: /^[A-Za-z0-9_-]{1,40}$/,
} as const

export type ValidateOptions = {
  /** A frame built from a half-streamed buffer: skip silently, report nothing. */
  partial?: boolean
}

export type ValidationResult = {
  /** The drawable spec, or null when nothing reachable from a root survived. */
  spec: UiSpec | null
  /** Human-readable, model-readable problems; always [] in partial mode. */
  errors: string[]
  /** Elements in `spec`. */
  count: number
}

/** A surface id the model may name: short, filesystem- and attribute-safe. */
export function isSurfaceId(v: unknown): v is string {
  return typeof v === 'string' && LIMITS.idPattern.test(v)
}

const ELEMENT_KEYS = new Set(['type', 'props', 'children', 'visible', 'tab'])
/** Keys a model adds from other formats that mean nothing here and are not worth a report. */
const IGNORED_ELEMENT_KEYS = new Set(['id', 'key', 'component', 'catalogId', 'weight', 'slots', 'on', 'watch', 'repeat', 'metadata', 'accessibility'])
const CONTAINER_NAMES = new Set(Object.entries(GENUI_CATALOG).filter(([, d]) => d.children === 'any').map(([n]) => n))

type Ctx = { partial: boolean; errors: string[] }

function report(ctx: Ctx, msg: string): void {
  if (!ctx.partial) ctx.errors.push(msg)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ─── scalar coercions ────────────────────────────────────────────

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return undefined
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '')
    if (t === '') return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  return undefined
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(t)) return true
    if (['false', 'no', 'off', '0', ''].includes(t)) return false
  }
  return undefined
}

function toEnum(v: unknown, def: PropDef): string | undefined {
  const options = def.enum ?? []
  const s = toStr(v)
  if (s !== undefined) {
    const t = s.trim().toLowerCase()
    for (const o of options) if (o.toLowerCase() === t) return o
  }
  return undefined
}

function clampStr(s: string, ctx: Ctx, at: string): string {
  if (s.length <= LIMITS.stringChars) return s
  report(ctx, `${at}: text cut at ${LIMITS.stringChars} characters`)
  return s.slice(0, LIMITS.stringChars)
}

function clampArr<T>(a: T[], ctx: Ctx, at: string): T[] {
  if (a.length <= LIMITS.arrayItems) return a
  report(ctx, `${at}: only the first ${LIMITS.arrayItems} of ${a.length} items were kept`)
  return a.slice(0, LIMITS.arrayItems)
}

function toStrs(v: unknown, ctx: Ctx, at: string): string[] | undefined {
  if (Array.isArray(v)) {
    const out: string[] = []
    for (const item of v) {
      const s = toStr(item) ?? (isObj(item) ? toStr(item.label ?? item.title ?? item.text ?? item.value ?? item.name) : undefined)
      if (s !== undefined) out.push(clampStr(s, ctx, at))
    }
    return clampArr(out, ctx, at)
  }
  const s = toStr(v)
  return s === undefined ? undefined : [clampStr(s, ctx, at)]
}

function toNums(v: unknown, ctx: Ctx, at: string): number[] | undefined {
  if (Array.isArray(v)) {
    const out: number[] = []
    for (const item of v) {
      const n = toNum(item) ?? (isObj(item) ? toNum(item.value ?? item.y ?? item.count) : undefined)
      if (n !== undefined) out.push(n)
    }
    return clampArr(out, ctx, at)
  }
  if (typeof v === 'string' && v.includes(',')) {
    const parts = v.split(',').map(toNum)
    if (parts.every(n => n !== undefined)) return parts as number[]
  }
  const n = toNum(v)
  return n === undefined ? undefined : [n]
}

/** `[{label, value}]` from strings, `{value}`-only or `{label}`-only objects. */
function toOptions(v: unknown, ctx: Ctx, at: string): Array<{ label: string; value: string }> | undefined {
  if (!Array.isArray(v)) {
    const s = toStr(v)
    if (s === undefined) return undefined
    v = s.includes(',') ? s.split(',').map(x => x.trim()).filter(Boolean) : [s]
  }
  const out: Array<{ label: string; value: string }> = []
  for (const item of v as unknown[]) {
    if (isObj(item)) {
      const label = toStr(item.label ?? item.title ?? item.text ?? item.name)
      const value = toStr(item.value ?? item.id ?? item.key)
      if (label !== undefined || value !== undefined) out.push({ label: clampStr(label ?? value!, ctx, at), value: clampStr(value ?? label!, ctx, at) })
    } else {
      const s = toStr(item)
      if (s !== undefined) out.push({ label: clampStr(s, ctx, at), value: clampStr(s, ctx, at) })
    }
  }
  return clampArr(out, ctx, at)
}

/** Table rows: arrays of cells, objects keyed by column, or single strings. */
function toRows(v: unknown, columns: string[], ctx: Ctx, at: string): string[][] | undefined {
  if (!Array.isArray(v)) return undefined
  const lower = columns.map(c => c.toLowerCase())
  const out: string[][] = []
  for (const row of v) {
    if (Array.isArray(row)) {
      out.push(row.map(c => clampStr(toStr(c) ?? (c == null ? '' : JSON.stringify(c)), ctx, at)))
    } else if (isObj(row)) {
      const keys = Object.keys(row)
      const cells = columns.map((c, i) => {
        const k = keys.find(k => k === c) ?? keys.find(k => k.toLowerCase() === lower[i]) ?? keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === lower[i].replace(/[^a-z0-9]/g, ''))
        const cell = k === undefined ? undefined : row[k]
        return clampStr(toStr(cell) ?? (cell == null ? '' : JSON.stringify(cell)), ctx, at)
      })
      // A row object whose keys match no column at all: take its values in order.
      if (cells.every(c => c === '') && keys.length) out.push(keys.map(k => clampStr(toStr(row[k]) ?? '', ctx, at)))
      else out.push(cells)
    } else {
      const s = toStr(row)
      if (s !== undefined) out.push([clampStr(s, ctx, at)])
    }
  }
  return clampArr(out, ctx, at)
}

/** Chart series from `[{name, values}]`, `[{category, values}]`, `[{label, data}]`, `number[]` or `[number[]]`. */
function toSeries(v: unknown, ctx: Ctx, at: string): Array<{ name: string; values: number[] }> | undefined {
  if (!Array.isArray(v)) return undefined
  if (v.every(x => typeof x === 'number' || typeof x === 'string')) {
    const values = toNums(v, ctx, at)
    return values && values.length ? [{ name: '', values }] : undefined
  }
  const out: Array<{ name: string; values: number[] }> = []
  for (const item of v) {
    if (Array.isArray(item)) {
      const values = toNums(item, ctx, at)
      if (values) out.push({ name: '', values })
    } else if (isObj(item)) {
      const name = toStr(item.name ?? item.category ?? item.label ?? item.series ?? item.key) ?? ''
      const values = toNums(item.values ?? item.data ?? item.points ?? item.y, ctx, at)
      if (values) out.push({ name: clampStr(name, ctx, at), values })
    }
  }
  return clampArr(out, ctx, at)
}

function toObjs(v: unknown, def: PropDef, ctx: Ctx, at: string): Record<string, unknown>[] | undefined {
  if (!Array.isArray(v)) return undefined
  const fields = def.fields ?? {}
  const firstStringField = Object.keys(fields).find(k => fields[k].type === 'string' && fields[k].required) ?? Object.keys(fields).find(k => fields[k].type === 'string')
  const out: Record<string, unknown>[] = []
  for (const item of v) {
    let obj: Record<string, unknown> | undefined
    if (isObj(item)) obj = item
    else if (firstStringField !== undefined) {
      const s = toStr(item)
      if (s !== undefined) obj = { [firstStringField]: s }
    }
    if (!obj) continue
    const coerced = coerceProps(obj, fields, ctx, at, { silentUnknown: true })
    // An item missing a required field is kept when it has anything at all: a
    // half-described step still draws.
    if (Object.keys(coerced).length) out.push(coerced)
  }
  return clampArr(out, ctx, at)
}

function coerceValue(v: unknown, def: PropDef, ctx: Ctx, at: string): unknown {
  switch (def.type) {
    case 'string': { const s = toStr(v); return s === undefined ? undefined : clampStr(s, ctx, at) }
    case 'number': {
      let n = toNum(v)
      if (n === undefined) return undefined
      if (def.min !== undefined && n < def.min) n = def.min
      if (def.max !== undefined && n > def.max) n = def.max
      return n
    }
    case 'boolean': return toBool(v)
    case 'enum': return toEnum(v, def)
    case 'string[]': return toStrs(v, ctx, at)
    case 'number[]': return toNums(v, ctx, at)
    case 'string[][]': return Array.isArray(v) ? v : undefined // Table handles rows with its columns
    case 'object': return isObj(v) ? v : undefined
    case 'object[]': return toObjs(v, def, ctx, at)
    default: return undefined
  }
}

/** Coerce one props object against a field table. Unknown keys are dropped (reported unless `silentUnknown`). */
function coerceProps(raw: Record<string, unknown>, fields: Record<string, PropDef>, ctx: Ctx, at: string, o: { silentUnknown?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lowerFields = new Map(Object.keys(fields).map(k => [k.toLowerCase(), k]))
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = fields[rawKey] ? rawKey : lowerFields.get(rawKey.toLowerCase())
    if (!key) {
      if (!o.silentUnknown) report(ctx, `${at}: unknown prop "${rawKey}" was dropped`)
      continue
    }
    if (value === null || value === undefined) continue
    const def = fields[key]
    const coerced = coerceValue(value, def, ctx, `${at}.${key}`)
    if (coerced === undefined) {
      if (def.type === 'enum') {
        report(ctx, `${at}.${key}: "${String(value)}" is not one of ${(def.enum ?? []).join('|')}; using "${def.default ?? def.enum?.[0]}"`)
      } else {
        report(ctx, `${at}.${key}: expected ${def.type}, got ${Array.isArray(value) ? 'an array' : typeof value}`)
      }
      continue
    }
    out[key] = coerced
  }
  return out
}

// ─── per-component shape rules (A5) ──────────────────────────────

function shapeProps(type: string, props: Record<string, unknown>, ctx: Ctx, at: string): Record<string, unknown> {
  const p = { ...props }
  if (type === 'Table') {
    if (p.columns === undefined && Array.isArray(p.rows) && p.rows.length && isObj(p.rows[0])) p.columns = Object.keys(p.rows[0] as object)
    if (p.columns === undefined && Array.isArray(p.headers)) { p.columns = p.headers; delete p.headers }
    if (p.rows === undefined && Array.isArray(p.data)) { p.rows = p.data; delete p.data }
  }
  if (type === 'BarChart' || type === 'LineChart') {
    // `data: [{label, value}]` → labels + one series (json-render's simplest chart contract).
    if (p.series === undefined && Array.isArray(p.data) && p.data.every(isObj)) {
      const pairs = p.data as Record<string, unknown>[]
      if (p.labels === undefined) p.labels = pairs.map(d => toStr(d.label ?? d.name ?? d.x) ?? '')
      p.series = [{ name: '', values: pairs.map(d => toNum(d.value ?? d.y ?? d.count) ?? 0) }]
      delete p.data
    } else if (p.series === undefined && Array.isArray(p.data)) { p.series = p.data; delete p.data }
    if (p.series === undefined && Array.isArray(p.values)) { p.series = p.values; delete p.values }
    if (p.series !== undefined) p.series = toSeries(p.series, ctx, `${at}.series`) ?? p.series
  }
  if (type === 'PieChart') {
    if (Array.isArray(p.data) && p.data.every(isObj)) {
      const pairs = p.data as Record<string, unknown>[]
      if (p.labels === undefined) p.labels = pairs.map(d => toStr(d.label ?? d.name) ?? '')
      if (p.values === undefined) p.values = pairs.map(d => toNum(d.value ?? d.count) ?? 0)
      delete p.data
    }
    if (p.values === undefined && Array.isArray(p.series)) {
      const s = toSeries(p.series, ctx, `${at}.series`)
      if (s && s.length) p.values = s[0].values
      delete p.series
    }
  }
  if (type === 'Sparkline' && p.values === undefined && Array.isArray(p.data)) { p.values = p.data; delete p.data }
  if (type === 'Select' || type === 'Radio' || type === 'CheckboxGroup') {
    if (p.options === undefined) {
      if (p.items !== undefined) { p.options = p.items; delete p.items }
      else if (p.choices !== undefined) { p.options = p.choices; delete p.choices }
    }
    // Strings, {value}-only and {label}-only choices become {label, value} pairs.
    if (p.options !== undefined) p.options = toOptions(p.options, ctx, `${at}.options`) ?? p.options
  }
  if (type === 'Tags' && p.items === undefined && p.tags !== undefined) { p.items = p.tags; delete p.tags }
  if (type === 'FollowUps' && p.items === undefined) {
    if (p.questions !== undefined) { p.items = p.questions; delete p.questions }
    else if (p.suggestions !== undefined) { p.items = p.suggestions; delete p.suggestions }
  }
  if ((type === 'Text' || type === 'Markdown') && p.text === undefined && typeof p.content === 'string') { p.text = p.content; delete p.content }
  if (type === 'Heading' && p.text === undefined && typeof p.title === 'string') { p.text = p.title; delete p.title }
  if (type === 'Callout' && p.message === undefined) {
    if (typeof p.text === 'string') { p.message = p.text; delete p.text }
    else if (typeof p.description === 'string') { p.message = p.description; delete p.description }
  }
  if (type === 'Button' && p.label === undefined && typeof p.text === 'string') { p.label = p.text; delete p.text }
  if (type === 'Button' && p.action === undefined && isObj(p.action === undefined ? undefined : p.action)) { /* unreachable */ }
  if (type === 'Button' && isObj(p.action)) {
    // A2UI `{event:{name, context}}` / OpenUI `{type:'continue_conversation', context}` shapes.
    const a = p.action as Record<string, unknown>
    const ev = isObj(a.event) ? (a.event as Record<string, unknown>) : a
    const name = toStr(ev.name ?? ev.action ?? ev.type)
    if (name !== undefined) p.action = name
    if (p.context === undefined && isObj(ev.context)) p.context = ev.context
  }
  if (type === 'Code' && p.code === undefined && typeof p.text === 'string') { p.code = p.text; delete p.text }
  return p
}

/** Props the renderer cannot do without; an element missing one is dropped rather than drawn empty. */
const MUST_HAVE: Record<string, string[]> = {
  Table: ['columns'],
  BarChart: ['labels', 'series'],
  LineChart: ['labels', 'series'],
  PieChart: ['labels', 'values'],
  Sparkline: ['values'],
  Image: ['src'],
  Link: ['href'],
}

// ─── nested → flat ───────────────────────────────────────────────

/** A model that nested children as objects instead of ids: flatten with generated ids. */
function flattenInto(elements: Record<string, unknown>, node: Record<string, unknown>, id: string, ctx: Ctx): string {
  const copy: Record<string, unknown> = { ...node }
  if (Array.isArray(copy.children)) {
    copy.children = (copy.children as unknown[]).map((child, i) => {
      if (isObj(child)) {
        const childId = typeof child.id === 'string' && LIMITS.idPattern.test(child.id) && !(child.id in elements) ? child.id : `${id}-${i + 1}`
        return flattenInto(elements, child, childId, ctx)
      }
      return child
    })
  }
  elements[id] = copy
  return id
}

// ─── the validator ───────────────────────────────────────────────

export function validateSpec(raw: unknown, opts: ValidateOptions = {}): ValidationResult {
  const ctx: Ctx = { partial: !!opts.partial, errors: [] }
  const fail = (msg: string): ValidationResult => { report(ctx, msg); return { spec: null, errors: ctx.errors, count: 0 } }

  if (!isObj(raw)) return fail('spec must be an object with "root" and "elements"')
  let elementsRaw: Record<string, unknown> | undefined = isObj(raw.elements) ? (raw.elements as Record<string, unknown>) : undefined
  let rootId: string | undefined = typeof raw.root === 'string' ? raw.root : undefined

  // A nested tree: { root: { type, children: [ {…} ] } } or a bare element.
  if (elementsRaw === undefined) {
    const tree = isObj(raw.root) ? (raw.root as Record<string, unknown>) : typeof raw.type === 'string' ? raw : undefined
    if (tree) {
      elementsRaw = {}
      rootId = flattenInto(elementsRaw, tree, typeof tree.id === 'string' && LIMITS.idPattern.test(tree.id) ? tree.id : 'root', ctx)
    }
  }
  if (!elementsRaw) return fail('spec.elements must be an object keyed by element id')
  // Children given as inline objects inside a flat map: flatten those too.
  for (const [id, el] of Object.entries(elementsRaw)) {
    if (isObj(el) && Array.isArray(el.children) && (el.children as unknown[]).some(isObj)) flattenInto(elementsRaw, el, id, ctx)
  }
  if (rootId === undefined) {
    // No root named: the first element nobody references.
    const referenced = new Set<string>()
    for (const el of Object.values(elementsRaw)) if (isObj(el) && Array.isArray(el.children)) for (const c of el.children as unknown[]) if (typeof c === 'string') referenced.add(c)
    rootId = Object.keys(elementsRaw).find(id => !referenced.has(id)) ?? Object.keys(elementsRaw)[0]
    if (rootId !== undefined) report(ctx, `spec.root was missing; "${rootId}" was used`)
  }
  if (rootId === undefined) return fail('spec has no elements')

  // Normalise every element first.
  const normalised: Record<string, UiElement> = {}
  let kept = 0
  for (const [rawId, el] of Object.entries(elementsRaw)) {
    if (kept >= LIMITS.elements) { report(ctx, `only the first ${LIMITS.elements} elements were kept`); break }
    const id = String(rawId).trim()
    if (!LIMITS.idPattern.test(id)) { report(ctx, `element id "${rawId}" must match ${LIMITS.idPattern}`); continue }
    if (!isObj(el)) { report(ctx, `${id}: not an object`); continue }
    const at = id
    const type = resolveComponentName(el.type)
    let def: ComponentDef | undefined = type ? GENUI_CATALOG[type] : undefined
    let typeName = type
    if (!typeName || !def) {
      if (ctx.partial) continue
      report(ctx, `${id}: unknown component "${String(el.type)}" — it was replaced by an error note; use a name from the catalog`)
      typeName = 'Callout'; def = GENUI_CATALOG.Callout
      normalised[id] = { type: 'Callout', props: { type: 'error', title: 'Unknown component', message: `"${String(el.type)}" is not in the catalog` } }
      kept++
      continue
    }
    // Relocate: element-level keys that are props move down; props that are element fields move up.
    let props: Record<string, unknown> = isObj(el.props) ? { ...(el.props as Record<string, unknown>) } : {}
    const element: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(el)) {
      if (k === 'type' || k === 'props') continue
      if (ELEMENT_KEYS.has(k)) { element[k] = v; continue }
      if (IGNORED_ELEMENT_KEYS.has(k)) continue
      if (def.props[k] || Object.keys(def.props).some(p => p.toLowerCase() === k.toLowerCase())) { if (props[k] === undefined) props[k] = v; continue }
      if (k === 'content' || k === 'text' || k === 'label' || k === 'title' || k === 'items' || k === 'rows' || k === 'columns' || k === 'action') { if (props[k] === undefined) props[k] = v; continue }
      report(ctx, `${at}: unknown field "${k}" was dropped`)
    }
    for (const k of ['visible', 'tab', 'children'] as const) {
      if (props[k] !== undefined) { if (element[k] === undefined) element[k] = props[k]; delete props[k] }
    }
    delete props.id; delete props.key
    props = shapeProps(typeName, props, ctx, at)
    const coerced = coerceProps(props, def.props, ctx, at)
    // Table rows need the columns to coerce objects.
    if (typeName === 'Table') {
      const columns = Array.isArray(coerced.columns) ? (coerced.columns as string[]) : []
      let rows = toRows(props.rows, columns, ctx, `${at}.rows`)
      // Every row has exactly one cell per column: short rows are padded,
      // long ones cut and said so (a 2,000-cell row is not a table).
      if (rows && columns.length) {
        let cut = 0
        rows = rows.map(r => {
          if (r.length > columns.length) { cut++; return r.slice(0, columns.length) }
          return r.length < columns.length ? [...r, ...Array(columns.length - r.length).fill('')] : r
        })
        if (cut) report(ctx, `${at}.rows: ${cut} row(s) had more cells than the ${columns.length} columns; the extra cells were dropped`)
      }
      if (rows) coerced.rows = rows; else delete coerced.rows
      if (!rows && props.rows !== undefined) report(ctx, `${at}.rows: expected an array of rows`)
    }
    // Required props.
    const missing = Object.entries(def.props).filter(([k, d]) => d.required && coerced[k] === undefined).map(([k]) => k)
    const fatal = (MUST_HAVE[typeName] ?? []).some(k => coerced[k] === undefined)
    if (fatal) { report(ctx, `${at} (${typeName}): missing ${missing.join(', ') || 'required props'} — the element was dropped`); continue }
    if (missing.length) report(ctx, `${at} (${typeName}): missing ${missing.join(', ')}`)

    const out: UiElement = { type: typeName, props: coerced }
    if (def.children === 'any') {
      const rawChildren = element.children
      if (Array.isArray(rawChildren)) {
        const ids: string[] = []
        for (const c of rawChildren) { const s = toStr(c); if (s !== undefined) ids.push(s.trim()) }
        out.children = ids
      } else if (rawChildren !== undefined) report(ctx, `${at}.children: expected an array of element ids`)
      else out.children = []
    } else if (Array.isArray(element.children) && (element.children as unknown[]).length) {
      report(ctx, `${at} (${typeName}) takes no children; ${(element.children as unknown[]).length} were ignored`)
    }
    if (element.visible !== undefined) {
      const v = element.visible
      if (isObj(v) && typeof v.name === 'string') out.visible = { name: v.name, ...(v.eq !== undefined ? { eq: v.eq } : {}), ...(v.neq !== undefined ? { neq: v.neq } : {}) }
      else if (typeof v === 'string') out.visible = { name: v, neq: '' }
      else if (v !== true) report(ctx, `${at}.visible: expected { name, eq | neq }`)
    }
    if (element.tab !== undefined) { const t = toStr(element.tab); if (t !== undefined) out.tab = t }
    normalised[id] = out
    kept++
  }

  if (!normalised[rootId]) {
    if (ctx.partial) return { spec: null, errors: [], count: 0 }
    const first = Object.keys(normalised)[0]
    if (!first) return fail(`root "${rootId}" is not a drawable element and nothing else is either`)
    report(ctx, `root "${rootId}" is not a drawable element; "${first}" was used`)
    rootId = first
  }

  // Reachability from root, depth cap, cycles, dangling children, parent map.
  const reachable: Record<string, UiElement> = {}
  const parentOf = new Map<string, string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  const seen = new Set<string>([rootId])
  while (queue.length) {
    const { id, depth } = queue.shift()!
    const el = normalised[id]
    reachable[id] = el
    if (!el.children) continue
    if (depth >= LIMITS.depth) { report(ctx, `${id}: nesting deeper than ${LIMITS.depth} was cut`); el.children = []; continue }
    const kids: string[] = []
    for (const c of el.children) {
      if (!normalised[c]) { report(ctx, `${id}.children: "${c}" is not an element id`); continue }
      if (seen.has(c)) { if (c === id || parentOf.has(c)) { report(ctx, `${id}.children: "${c}" would nest twice (cycle) and was skipped`); continue } }
      seen.add(c); parentOf.set(c, id); kids.push(c)
      queue.push({ id: c, depth: depth + 1 })
    }
    el.children = kids
  }
  for (const id of Object.keys(normalised)) if (!reachable[id]) report(ctx, `${id}: not reachable from root "${rootId}" and was dropped`)

  // Action names travel back over the socket, which accepts only short ids
  // (commandSchema.ts): "Plan trip" would be refused at the click.
  for (const el of Object.values(reachable)) {
    const p = el.props
    if (!p) continue
    if ((el.type === 'Button' || el.type === 'Form') && typeof p.action === 'string' && p.action.trim() && !ACTION_ID.test(p.action)) p.action = actionFromLabel(p.action)
    if (el.type === 'List' && Array.isArray(p.items)) {
      for (const it of p.items as Record<string, unknown>[]) if (typeof it.action === 'string' && it.action.trim() && !ACTION_ID.test(it.action)) it.action = actionFromLabel(it.action)
    }
  }

  // Buttons: an action, or a Form ancestor that supplies one; otherwise the
  // label is the action (OpenUI: a Button with no action sends its label).
  for (const [id, el] of Object.entries(reachable)) {
    if (el.type !== 'Button') continue
    if (typeof el.props?.action === 'string' && el.props.action.trim()) continue
    let p = parentOf.get(id); let inForm = false
    while (p) { if (reachable[p]?.type === 'Form') { inForm = true; break } p = parentOf.get(p) }
    if (!inForm) el.props = { ...(el.props ?? {}), action: actionFromLabel(el.props?.label) }
  }
  // Tabs: a child with no tab goes to the first tab; say so once per container.
  for (const [id, el] of Object.entries(reachable)) {
    if (el.type !== 'Tabs' || !el.children) continue
    const tabs = Array.isArray(el.props?.tabs) ? (el.props!.tabs as Array<{ value: string }>) : []
    const first = tabs[0]?.value
    for (const c of el.children) {
      const child = reachable[c]
      if (child && child.tab === undefined && first !== undefined) { child.tab = first; report(ctx, `${c}: no "tab" set; shown under "${first}"`) }
    }
  }

  const count = Object.keys(reachable).length
  return { spec: { root: rootId, elements: reachable }, errors: ctx.errors, count }
}

const ACTION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** An action name the socket accepts (/^[A-Za-z0-9_-]{1,128}$/) made from a button label. */
export function actionFromLabel(label: unknown): string {
  const slug = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug || 'click'
}

/** True when `name` is a container (takes children). Exported for the prompt and tests. */
export function isContainer(name: string): boolean {
  return CONTAINER_NAMES.has(name)
}
