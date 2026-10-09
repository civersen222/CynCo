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
    expect(r.output).toContain('Rendered 1 element.')
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
    expect(renderUiResultText(3, ['a'])).toBe('Rendered 3 elements.\nIssues (fix these in your next call rather than resending the same spec):\n- a')
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
