/**
 * validateSpec: the mistakes the surveys document a model making — numbers as
 * strings, children omitted, props at the wrong level, option lists as plain
 * strings, chart data as {label, value} pairs, a nested tree instead of a flat
 * map, dangling and orphaned ids, unknown components — each coerced or
 * reported, never thrown, and reported silently in partial mode.
 */
import { describe, expect, it } from 'vitest'
import { validateSpec, LIMITS, isSurfaceId } from '../../genui/spec.js'
import { genuiExampleCall } from '../../genui/prompt.js'

const one = (type: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  validateSpec({ root: 'x', elements: { x: { type, props, ...extra } } })

describe('validateSpec', () => {
  it('accepts the worked example without a single issue', () => {
    const r = validateSpec(genuiExampleCall().spec)
    expect(r.errors).toEqual([])
    expect(r.count).toBe(7)
    expect(r.spec?.root).toBe('card')
    expect(r.spec?.elements.card.children).toEqual(['steps', 'costs', 'form', 'next'])
  })

  it('never throws and names the fault for non-specs', () => {
    expect(validateSpec(null).spec).toBeNull()
    expect(validateSpec('x').errors[0]).toMatch(/must be an object/)
    expect(validateSpec({ root: 'a' }).errors[0]).toMatch(/elements/)
    expect(validateSpec({ root: 'a', elements: {} }).spec).toBeNull()
  })

  it('coerces scalars: "2" → 2, "true" → true, 3 → "3", enum case', () => {
    const g = one('Grid', { columns: '3' })
    expect(g.spec?.elements.x.props?.columns).toBe(3)
    expect(g.errors).toEqual([])
    const s = one('Switch', { name: 'a', label: 'A', checked: 'true' })
    expect(s.spec?.elements.x.props?.checked).toBe(true)
    const m = one('Metric', { label: 'n', value: 42 })
    expect(m.spec?.elements.x.props?.value).toBe('42')
    const c = one('Callout', { message: 'm', type: 'WARNING' })
    expect(c.spec?.elements.x.props?.type).toBe('warning')
    expect(c.errors).toEqual([])
  })

  it('clamps numbers to their range and reports an enum value it cannot place', () => {
    expect(one('Grid', { columns: 99 }).spec?.elements.x.props?.columns).toBe(6)
    expect(one('Progress', { value: -5 }).spec?.elements.x.props?.value).toBe(0)
    const c = one('Callout', { message: 'm', type: 'loud' })
    expect(c.spec?.elements.x.props?.type).toBeUndefined()
    expect(c.errors[0]).toMatch(/not one of info\|success\|warning\|error/)
  })

  it('relocates element-level props down and props-level visible/tab/children up', () => {
    const r = validateSpec({ root: 'c', elements: {
      c: { type: 'Card', title: 'T', children: ['t'] },
      t: { type: 'Text', props: { text: 'hi', visible: { name: 'show', eq: true }, tab: 'a' } },
    } })
    expect(r.errors).toEqual([])
    expect(r.spec?.elements.c.props?.title).toBe('T')
    expect(r.spec?.elements.t.visible).toEqual({ name: 'show', eq: true })
    expect(r.spec?.elements.t.tab).toBe('a')
    expect(r.spec?.elements.t.props?.visible).toBeUndefined()
  })

  it('drops unknown props and fields with a report, ignores other formats\' noise silently', () => {
    const r = one('Text', { text: 'x', colour: 'red' }, { id: 'x', weight: 2, catalogId: 'c' })
    expect(r.spec?.elements.x.props).toEqual({ text: 'x' })
    expect(r.errors).toEqual(['x: unknown prop "colour" was dropped'])
  })

  it('table rows: objects by column, strings, mixed cells', () => {
    const r = one('Table', { columns: ['Name', 'Qty'], rows: [{ Name: 'Resin', Qty: 2 }, { name: 'Pigment', qty: '1' }, 'note', ['a', null, true]] })
    expect(r.spec?.elements.x.props?.rows).toEqual([['Resin', '2'], ['Pigment', '1'], ['note'], ['a', '', 'true']])
    expect(r.errors).toEqual([])
  })

  it('table without columns derives them from the first row object; without rows it is dropped', () => {
    const r = one('Table', { rows: [{ A: 1, B: 2 }] })
    expect(r.spec?.elements.x.props?.columns).toEqual(['A', 'B'])
    const d = one('Table', { rows: 'nope' })
    expect(d.spec).toBeNull()
    expect(d.errors.join(' ')).toMatch(/missing columns/)
  })

  it('charts: {label,value} pairs, bare number arrays, OpenUI {category,values}, numeric strings', () => {
    const pairs = one('BarChart', { data: [{ label: 'a', value: '3' }, { label: 'b', value: 4 }] })
    expect(pairs.spec?.elements.x.props?.labels).toEqual(['a', 'b'])
    expect(pairs.spec?.elements.x.props?.series).toEqual([{ name: '', values: [3, 4] }])
    const bare = one('LineChart', { labels: ['x', 'y'], series: ['1', 2] })
    expect(bare.spec?.elements.x.props?.series).toEqual([{ name: '', values: [1, 2] }])
    const openui = one('BarChart', { labels: ['x'], series: [{ category: 'A', values: [1] }] })
    expect(openui.spec?.elements.x.props?.series).toEqual([{ name: 'A', values: [1] }])
    const pie = one('PieChart', { data: [{ label: 'a', value: 1 }, { label: 'b', value: 3 }] })
    expect(pie.spec?.elements.x.props?.values).toEqual([1, 3])
    expect(pie.spec?.elements.x.props?.labels).toEqual(['a', 'b'])
    const spark = one('Sparkline', { values: '1, 2, 3' })
    expect(spark.spec?.elements.x.props?.values).toEqual([1, 2, 3])
  })

  it('options: strings, {value}-only, {label}-only, comma string; list items as strings', () => {
    const r = one('Select', { name: 's', label: 'S', options: ['a', { value: 'b' }, { label: 'C' }] })
    expect(r.spec?.elements.x.props?.options).toEqual([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'C', value: 'C' }])
    const csv = one('Radio', { name: 'r', label: 'R', options: 'x, y' })
    expect(csv.spec?.elements.x.props?.options).toEqual([{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }])
    const list = one('List', { items: ['one', { title: 'two', subtitle: 's' }] })
    expect(list.spec?.elements.x.props?.items).toEqual([{ title: 'one' }, { title: 'two', subtitle: 's' }])
  })

  it('aliases: content→text, title→text (Heading), text→message (Callout), items→options, A2UI/OpenUI action objects', () => {
    expect(one('Text', { content: 'c' }).spec?.elements.x.props?.text).toBe('c')
    expect(one('Heading', { title: 'h' }).spec?.elements.x.props?.text).toBe('h')
    expect(one('Callout', { text: 'm' }).spec?.elements.x.props?.message).toBe('m')
    expect(one('Radio', { name: 'r', label: 'R', items: ['a'] }).spec?.elements.x.props?.options).toEqual([{ label: 'a', value: 'a' }])
    const a2ui = one('Button', { label: 'Go', action: { event: { name: 'go', context: { id: 7 } } } })
    expect(a2ui.spec?.elements.x.props?.action).toBe('go')
    expect(a2ui.spec?.elements.x.props?.context).toEqual({ id: 7 })
    const openui = one('Button', { label: 'Go', action: { type: 'continue_conversation', context: 'more' } })
    expect(openui.spec?.elements.x.props?.action).toBe('continue_conversation')
  })

  it('unknown component → an error note the user sees and a report the model reads', () => {
    const r = validateSpec({ root: 'c', elements: { c: { type: 'Card', children: ['m'] }, m: { type: 'Modal', props: {} } } })
    expect(r.spec?.elements.m.type).toBe('Callout')
    expect(r.spec?.elements.m.props?.message).toContain('"Modal" is not in the catalog')
    expect(r.errors.some(e => e.includes('unknown component "Modal"'))).toBe(true)
  })

  it('dangling child ids and orphans are dropped with a report; cycles are cut', () => {
    const r = validateSpec({ root: 'c', elements: {
      c: { type: 'Card', children: ['t', 'ghost', 'c'] },
      t: { type: 'Text', props: { text: 'x' } },
      lost: { type: 'Text', props: { text: 'orphan' } },
    } })
    expect(r.spec?.elements.c.children).toEqual(['t'])
    expect(Object.keys(r.spec!.elements)).toEqual(['c', 't'])
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('"ghost" is not an element id'),
      expect.stringContaining('cycle'),
      expect.stringContaining('lost: not reachable'),
    ]))
  })

  it('a leaf given children reports them; a container without children gets []', () => {
    const r = validateSpec({ root: 'c', elements: { c: { type: 'Card' }, t: { type: 'Text', props: { text: 'x' }, children: ['c'] } } })
    expect(r.spec?.elements.c.children).toEqual([])
    const leaf = validateSpec({ root: 't', elements: { t: { type: 'Text', props: { text: 'x' }, children: ['t'] } } })
    expect(leaf.errors.join(' ')).toMatch(/takes no children/)
  })

  it('a nested tree is flattened with generated ids; a missing root is inferred', () => {
    const tree = validateSpec({ root: { type: 'Card', props: { title: 'T' }, children: [{ type: 'Text', props: { text: 'a' } }, { id: 'b', type: 'Badge', props: { text: 'b' } }] } })
    expect(tree.errors).toEqual([])
    expect(tree.spec?.root).toBe('root')
    expect(tree.spec?.elements.root.children).toEqual(['root-1', 'b'])
    expect(tree.spec?.elements['root-1'].type).toBe('Text')
    const noRoot = validateSpec({ elements: { a: { type: 'Card', children: ['b'] }, b: { type: 'Text', props: { text: 'x' } } } })
    expect(noRoot.spec?.root).toBe('a')
    expect(noRoot.errors[0]).toMatch(/spec.root was missing/)
  })

  it('Button needs an action unless a Form supplies one', () => {
    const bare = validateSpec({ root: 'b', elements: { b: { type: 'Button', props: { label: 'Go' } } } })
    expect(bare.errors.join(' ')).toMatch(/needs an action name, or a Form/)
    const inForm = validateSpec({ root: 'f', elements: { f: { type: 'Form', children: ['row'] }, row: { type: 'ButtonRow', children: ['b'] }, b: { type: 'Button', props: { label: 'Go' } } } })
    expect(inForm.errors).toEqual([])
  })

  it('Tabs children without a tab go to the first tab, said once each', () => {
    const r = validateSpec({ root: 't', elements: {
      t: { type: 'Tabs', props: { tabs: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }, children: ['x', 'y'] },
      x: { type: 'Text', props: { text: '1' } },
      y: { type: 'Text', props: { text: '2' }, tab: 'b' },
    } })
    expect(r.spec?.elements.x.tab).toBe('a')
    expect(r.spec?.elements.y.tab).toBe('b')
    expect(r.errors).toEqual(['x: no "tab" set; shown under "a"'])
  })

  it('missing required props: dropped when undrawable (Image without src), kept and reported otherwise', () => {
    const img = validateSpec({ root: 'c', elements: { c: { type: 'Card', children: ['i'] }, i: { type: 'Image', props: { alt: 'x' } } } })
    expect(img.spec?.elements.i).toBeUndefined()
    expect(img.errors.join(' ')).toMatch(/i \(Image\): missing src/)
    const inp = one('Input', { label: 'L' })
    expect(inp.spec?.elements.x.type).toBe('Input')
    expect(inp.errors).toEqual(['x (Input): missing name'])
  })

  it('limits: strings, arrays, elements and depth are cut and said so', () => {
    const long = one('Text', { text: 'x'.repeat(LIMITS.stringChars + 10) })
    expect((long.spec?.elements.x.props?.text as string).length).toBe(LIMITS.stringChars)
    expect(long.errors[0]).toMatch(/cut at/)
    const rows = one('Table', { columns: ['a'], rows: Array.from({ length: LIMITS.arrayItems + 5 }, (_, i) => [String(i)]) })
    expect((rows.spec?.elements.x.props?.rows as unknown[]).length).toBe(LIMITS.arrayItems)
    const many: Record<string, unknown> = { c: { type: 'Stack', children: [] as string[] } }
    for (let i = 0; i < LIMITS.elements + 5; i++) { many[`e${i}`] = { type: 'Text', props: { text: String(i) } }; (many.c as any).children.push(`e${i}`) }
    const r = validateSpec({ root: 'c', elements: many })
    expect(r.count).toBeLessThanOrEqual(LIMITS.elements)
    expect(r.errors.some(e => e.includes(`first ${LIMITS.elements} elements`))).toBe(true)
  })

  it('ids must be short and safe', () => {
    const r = validateSpec({ root: 'ok', elements: { ok: { type: 'Card', children: ['bad id!'] }, 'bad id!': { type: 'Text', props: { text: 'x' } } } })
    expect(r.errors[0]).toMatch(/element id "bad id!" must match/)
    expect(isSurfaceId('plan-1')).toBe(true)
    expect(isSurfaceId('a'.repeat(41))).toBe(false)
    expect(isSurfaceId('../x')).toBe(false)
  })

  it('partial mode skips silently and reports nothing', () => {
    const r = validateSpec({ root: 'c', elements: {
      c: { type: 'Card', children: ['t', 'ghost', 'half'] },
      t: { type: 'Tex', props: { text: 'x' } },
      half: { type: 'Callout', props: { message: 'm', type: 'warn' } },
      '': null,
    } }, { partial: true })
    expect(r.errors).toEqual([])
    expect(r.spec?.elements.c.children).toEqual(['half'])
    expect(r.spec?.elements.half.props?.type).toBeUndefined()
    expect(validateSpec({ root: 'c', elements: { c: { type: 'Car' } } }, { partial: true }).spec).toBeNull()
  })
})
