/**
 * The RenderUI tool and its registry wiring: offered as an extended tool in a
 * coding session, always in a project chat, routed with the write category,
 * low risk, and answering with what will draw and what could not — isError
 * only when nothing is drawable. Plus the click → user-turn formatter and its
 * bounds.
 */
import { describe, expect, it } from 'vitest'
import { renderUiTool, renderUiResultText, RENDER_UI_INPUT_SCHEMA } from '../../genui/renderUiTool.js'
import { ALL_TOOLS, getToolByName, getExtendedTools } from '../../tools/registry.js'
import { PROJECT_TOOL_NAMES } from '../../projects/profile.js'
import { TOOL_CATEGORIES } from '../../tools/toolRouter.js'
import { getToolRisk } from '../../tools/approvalGate.js'
import { ALL_TOOL_NAMES } from '../../s5/ruleBasedS5.js'
import { formatUiAction, uiActionEcho, UI_ACTION_SECTION_CAP } from '../../genui/actions.js'
import { validateCommand } from '../../bridge/commandSchema.js'
import { genuiExampleCall } from '../../genui/prompt.js'

describe('RenderUI tool', () => {
  it('is registered, extended, auto-tier, low risk, in the write category and in every project chat', () => {
    expect(getToolByName('RenderUI')).toBe(renderUiTool)
    expect(ALL_TOOLS.filter(t => t.name === 'RenderUI')).toHaveLength(1)
    expect(renderUiTool.core).toBe(false)
    expect(getExtendedTools().map(t => t.name)).toContain('RenderUI')
    expect(renderUiTool.tier).toBe('auto')
    expect(getToolRisk('RenderUI')).toBe('low')
    expect(TOOL_CATEGORIES.write).toContain('RenderUI')
    expect(PROJECT_TOOL_NAMES).toContain('RenderUI')
    expect(ALL_TOOL_NAMES).toContain('RenderUI')
  })

  it('declares surface before spec and an envelope schema with untyped props', () => {
    expect(Object.keys(RENDER_UI_INPUT_SCHEMA.properties)).toEqual(['surface', 'spec'])
    expect(RENDER_UI_INPUT_SCHEMA.required).toEqual(['spec'])
    const spec = RENDER_UI_INPUT_SCHEMA.properties.spec as any
    expect(spec.required).toEqual(['root', 'elements'])
    const element = spec.properties.elements.additionalProperties
    expect(element.required).toEqual(['type'])
    expect(element.properties.props).toEqual({ type: 'object' })
    expect(element.properties.children).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('answers with the element count and no issues for the worked example', async () => {
    const r = await renderUiTool.execute(genuiExampleCall(), '/tmp')
    expect(r.isError).toBe(false)
    expect(r.output).toBe('Rendered 7 elements.')
  })

  it('reports issues without erroring, and errors only when nothing draws', async () => {
    const r = await renderUiTool.execute({ spec: { root: 'c', elements: { c: { type: 'Card', children: ['ghost'] } } }, surface: 'not valid!' }, '/tmp')
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Rendered 1 element.\nNotes (already shown to the user — call RenderUI again only for an element that was dropped or a spec that was cut off):')
    expect(r.output).toContain('"ghost" is not an element id')
    expect(r.output).toContain('surface "not valid!" must match')
    const bad = await renderUiTool.execute({ spec: { root: 'x', elements: { x: { type: 'Modal' } } } }, '/tmp')
    expect(bad.isError).toBe(false) // an unknown component draws an error note; the surface still exists
    const none = await renderUiTool.execute({ spec: 'nope' }, '/tmp')
    expect(none.isError).toBe(true)
    expect(none.output).toMatch(/Nothing could be drawn/)
    const bare = await renderUiTool.execute({ root: 'x', elements: { x: { type: 'Text', props: { text: 'hi' } } } }, '/tmp')
    expect(bare.isError).toBe(false)
  })

  it('renderUiResultText phrases singular and plural', () => {
    expect(renderUiResultText(1, [])).toBe('Rendered 1 element.')
    expect(renderUiResultText(3, ['a'])).toBe('Rendered 3 elements.\nNotes (already shown to the user — call RenderUI again only for an element that was dropped or a spec that was cut off):\n- a')
  })

  // F174: every drop line ends "the element was dropped", so the header tells
  // the model which notes are worth a second call and which are already done.
  it('a src that is neither a URL nor an image path is a note, and an Image with nothing to show is a dropped element; an image path in the project is kept', async () => {
    const r = await renderUiTool.execute({ spec: { root: 'c', elements: {
      c: { type: 'Card', props: { title: 'Aliens' }, children: ['a', 'b', 'f'] },
      a: { type: 'Image', props: { prompt: 'a tall green alien in a silver suit, full body', src: 'aliens/a.png', alt: 'Tall alien' } },
      b: { type: 'Image', props: { src: 'aliens/b.bmp', alt: 'Small alien' } },
      f: { type: 'Image', props: { src: './aliens/front.svg', alt: 'Front view' } },
    } } }, '/tmp')
    expect(r.isError).toBe(false)
    expect(r.output.split('\n')).toEqual([
      'Rendered 3 elements.',
      'Notes (already shown to the user — call RenderUI again only for an element that was dropped or a spec that was cut off):',
      '- a: an Image takes "prompt" or "src", not both — the prompt was kept',
      '- b.src: "aliens/b.bmp" is not a path the engine can show — a file path is "/"-separated ASCII letters, digits, _ - . ( ) and single spaces, no segment starting with a dot, no leading "/" or drive letter, no "..", at most 200 characters, ending in png/jpg/gif/webp/svg — dropped; rename the file to fit, or describe the picture in "prompt" and the engine generates it',
      '- b (Image): needs "prompt" (a description of the picture), a real http(s) "src" or the path of an image file in the project — the element was dropped',
      '- c.children: "b" is not an element id — nothing was drawn for it (the element was dropped)',
    ])
  })

  // Review of stage B: the header sends the model back only for "an element
  // that was dropped", so every note for something not drawn must say so in
  // those words. A bad id, a non-object, an unknown component and a child
  // naming no element used not to, and the old "use a name from the catalog"
  // read as a note to tidy.
  it('every note for an element that is not drawn says it was dropped', async () => {
    const r = await renderUiTool.execute({ surface: 'aliens', spec: { root: 'g', elements: {
      g: { type: 'Grid', children: ['a', 'b', 'c', 'd'] },
      a: { type: 'Card', props: { title: 'A' }, children: ['a img'] },
      'a img': { type: 'Image', props: { prompt: 'a tall green alien', alt: 'A' } },
      b: { type: 'Card', props: { title: 'B' }, children: ['b-img'] },
      'b-img': { type: 'Picture', props: { prompt: 'a small grey alien', alt: 'B' } },
      c: { type: 'Card', props: { title: 'C' }, children: ['c-img'] },
      d: 'a blue alien',
    } } }, '/tmp')
    expect(r.isError).toBe(false)
    const notes = r.output.split('\n').filter(l => l.startsWith('- '))
    expect(notes).toEqual([
      '- element id "a img" must match /^[A-Za-z0-9_-]{1,40}$/ and not be a reserved name — the element was dropped',
      '- b-img: unknown component "Picture" — the element was dropped and an error box shows in its place; use a name from the catalog',
      '- d: not an object — the element was dropped',
      '- g.children: "d" is not an element id — nothing was drawn for it (the element was dropped)',
      '- a.children: "a img" is not an element id — nothing was drawn for it (the element was dropped)',
      '- c.children: "c-img" is not an element id — nothing was drawn for it (the element was dropped)',
    ])
    for (const n of notes) expect(n).toMatch(/the element was dropped/)
  })
})

describe('ui.action → user turn', () => {
  it('echoes the model\'s userMessage, else the label, else the action', () => {
    expect(uiActionEcho({ type: 'ui.action', surfaceId: 's', action: 'go', userMessage: 'Recalculate with 3 kg' })).toBe('Recalculate with 3 kg')
    expect(uiActionEcho({ type: 'ui.action', surfaceId: 's', action: 'go', label: 'Go' })).toBe('▶ Go')
    expect(uiActionEcho({ type: 'ui.action', surfaceId: 's', action: 'go' })).toBe('▶ go')
  })

  it('formats the structured body with bounded sections', () => {
    const text = formatUiAction({ type: 'ui.action', surfaceId: 'plan', action: 'recalc', label: 'Recalculate', context: { k: 1 }, state: { kg: 3 } })
    expect(text.split('\n')[0]).toBe('[UI action] "Recalculate" → action "recalc" on surface "plan"')
    expect(text).toContain('context: {"k":1}')
    expect(text).toContain('input values: {"kg":3}')
    expect(text).toContain('call RenderUI again with the same "surface" id')
    const empty = formatUiAction({ type: 'ui.action', surfaceId: 'plan', action: 'go' })
    expect(empty).toContain('input values: (none)')
    const big = formatUiAction({ type: 'ui.action', surfaceId: 'p', action: 'a', state: { blob: 'x'.repeat(UI_ACTION_SECTION_CAP * 2) } })
    expect(big.length).toBeLessThan(UI_ACTION_SECTION_CAP + 400)
    expect(big).toMatch(/bytes omitted\)/)
  })

  it('the socket refuses an over-size or malformed click and names the field', () => {
    const ok = validateCommand({ type: 'ui.action', surfaceId: 'plan', action: 'recalc', state: { kg: 2 } })
    expect(ok.ok).toBe(true)
    const bigState = validateCommand({ type: 'ui.action', surfaceId: 'plan', action: 'a', state: { blob: 'x'.repeat(9000) } })
    expect(bigState.ok).toBe(false)
    expect((bigState as any).reason).toMatch(/state must be an object of at most 8192 bytes/)
    const badAction = validateCommand({ type: 'ui.action', surfaceId: 'plan', action: 'not an id' })
    expect((badAction as any).reason).toMatch(/action must be a short id/)
    const longLabel = validateCommand({ type: 'ui.action', surfaceId: 'p', action: 'a', label: 'x'.repeat(2001) })
    expect((longLabel as any).reason).toMatch(/label must be a string of at most 2000/)
    const arrayCtx = validateCommand({ type: 'ui.action', surfaceId: 'p', action: 'a', context: [1] })
    expect((arrayCtx as any).reason).toMatch(/context must be an object/)
  })
})

// Final review: the transcript stores the model's raw RenderUI input, but the
// page drew what validateSpec made of it; the chat route serves the latter.
describe('the chat transcript route serves validated RenderUI specs', () => {
  it('aliases, chart pairs and options resolve; nothing drawable becomes spec:null; history is untouched', async () => {
    const { withValidatedSurfaces } = await import('../../projects/api.js')
    const raw = { root: 'c', elements: {
      c: { type: 'Card', props: { title: 'Costs' }, children: ['h', 'ch', 'sel'] },
      h: { type: 'Heading', props: { title: 'Budget' } },
      ch: { type: 'BarChart', props: { data: [{ label: 'Resin', value: 120 }, { label: 'Wood', value: 40 }] } },
      sel: { type: 'Select', props: { name: 'wood', label: 'Wood', choices: ['Oak', 'Walnut'] } },
    } }
    const t = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'here' },
        { type: 'tool_use', id: 'a', name: 'RenderUI', input: { surface: 'costs', spec: raw } },
        { type: 'tool_use', id: 'b', name: 'RenderUI', input: raw },
        { type: 'tool_use', id: 'c', name: 'RenderUI', input: { spec: 'nope', surface: 'bad id!' } },
        { type: 'tool_use', id: 'd', name: 'Read', input: { file_path: 'x' } },
      ] },
    ] }
    const before = JSON.stringify(t)
    const out = withValidatedSurfaces(t) as typeof t
    expect(JSON.stringify(t)).toBe(before)
    const [, a, b, c, d] = (out.messages[1] as any).content
    expect(a.input.surface).toBe('costs')
    expect(a.input.spec.elements.h.props).toEqual({ text: 'Budget' })
    expect(a.input.spec.elements.ch.props.series).toEqual([{ name: '', values: [120, 40] }])
    expect(a.input.spec.elements.sel.props.options).toEqual([{ label: 'Oak', value: 'Oak' }, { label: 'Walnut', value: 'Walnut' }])
    expect(b.input.spec.root).toBe('c')
    expect(c.input).toEqual({ surface: undefined, spec: null })
    expect(d).toEqual({ type: 'tool_use', id: 'd', name: 'Read', input: { file_path: 'x' } })
    expect(out.messages[0]).toBe(t.messages[0])
  })
})
