/**
 * The RENDER_UI section rides inside the cached prompt prefix: it must name
 * every catalog component exactly once, stay under the budget the design set
 * (10k chars, ~2.5k tokens), and be byte-identical on every call.
 */
import { describe, expect, it } from 'vitest'
import { genuiPromptSection, genuiExampleCall } from '../../genui/prompt.js'
import { GENUI_COMPONENT_NAMES, GENUI_CATALOG } from '../../genui/catalog.js'
import { validateSpec } from '../../genui/spec.js'

describe('genui prompt section', () => {
  const text = genuiPromptSection()

  it('is byte-stable and bounded', () => {
    expect(genuiPromptSection()).toBe(text)
    expect(text.length).toBeLessThan(10_000)
    expect(text.startsWith('<RENDER_UI>')).toBe(true)
    expect(text.trimEnd().endsWith('</RENDER_UI>')).toBe(true)
  })

  it('lists every catalog component exactly once as a signature', () => {
    for (const name of GENUI_COMPONENT_NAMES) {
      const re = new RegExp(`^- ${name}\\(`, 'gm')
      expect(text.match(re)?.length, name).toBe(1)
    }
    // required props are starred, enums are spelled out, containers are marked
    expect(text).toMatch(/- Table\(columns\*: string\[\], rows\*: string\[\]\[\], caption: string\)/)
    expect(text).toMatch(/- Callout\(message\*: string, title: string, type: "info"\|"success"\|"warning"\|"error"\)/)
    expect(text).toMatch(/- Card\(title: string, description: string\) \[children\]/)
    for (const name of GENUI_COMPONENT_NAMES) {
      const marked = new RegExp(`^- ${name}\\([^\\n]*\\) \\[children\\]`, 'm').test(text)
      expect(marked, `${name} children marker`).toBe(GENUI_CATALOG[name].children === 'any')
    }
  })

  it('teaches the rules the surveys found models break', () => {
    // Inverted from OpenUI/json-render's "generate plausible data": a coding
    // agent's report blocks carry real work, so nothing may be invented.
    expect(text).toMatch(/Real values only: numbers, file paths, test counts, command output and URLs come from your tool results or the conversation — never invent them/)
    expect(text).toMatch(/With no real image URL, leave the Image out/)
    expect(text).toMatch(/FollowUps go last: 2-4 short questions/)
    expect(text).toMatch(/one cell per column/)
    expect(text).toMatch(/one with no action sends its label/)
    expect(text).toMatch(/never add a Callout or Text that explains the UI itself/)
    expect(text).toMatch(/an element nothing references is dropped/)
    expect(text).toMatch(/Numbers are numbers \(2, not "2"\)/)
    expect(text).toMatch(/write each parent before its children with the root first/)
    expect(text).toMatch(/"tab": "<tab value>" next to its "type"/)
    expect(text).toMatch(/same "surface" id/)
    expect(text).toMatch(/do not resend the same spec/)
  })

  it('carries a worked example that validates clean and names the tool', () => {
    expect(text).toContain('RenderUI({"surface":"plan","spec":{"root":"card"')
    const ex = genuiExampleCall()
    const r = validateSpec(ex.spec)
    expect(r.errors).toEqual([])
    expect(r.count).toBe(7)
    expect(ex.surface).toBe('plan')
    // the example is a fresh copy each time
    ex.spec.root = 'x'
    expect(genuiExampleCall().spec.root).toBe('card')
  })
})
