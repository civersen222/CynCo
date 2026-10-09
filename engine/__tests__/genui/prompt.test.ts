/**
 * The RENDER_UI section rides inside the cached prompt prefix: it must name
 * every catalog component exactly once, stay under its budget (12k chars,
 * ~3k tokens — raised from 10k for the options example, F171), and be
 * byte-identical on every call.
 */
import { describe, expect, it } from 'vitest'
import { genuiPromptSection, genuiExampleCall, genuiOptionsExampleCall } from '../../genui/prompt.js'
import { GENUI_COMPONENT_NAMES, GENUI_CATALOG } from '../../genui/catalog.js'
import { validateSpec } from '../../genui/spec.js'

describe('genui prompt section', () => {
  const text = genuiPromptSection('project')
  const session = genuiPromptSection('session')

  it('is byte-stable and bounded in both modes', () => {
    expect(genuiPromptSection('project')).toBe(text)
    expect(genuiPromptSection('session')).toBe(session)
    expect(session.length).toBeLessThan(12_000)
    expect(text.length).toBeLessThan(12_000)
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
    // agent's report blocks carry real work, so no fact may be invented — but
    // ideas the model proposes are its to draw (F171: "never invent" read as
    // a reason to keep designs out of the surface).
    expect(text).toMatch(/Facts must be real: numbers, prices, file paths, test counts, command output and URLs come from your tool results or the conversation — never invent them/)
    expect(text).toMatch(/Ideas you propose \(designs, names, options\) are yours to write, and drawing them is the point/)
    // a draft the user asked to read stays prose (final review: rule 5 used to list drafts)
    expect(text).toMatch(/Plain prose is for a short direct answer, a single open question, or a draft the user asked to read/)
    expect(text).toMatch(/With no real image URL, leave the Image out/)
    expect(text).toMatch(/FollowUps go last: 2-4 short questions the user is likely to ask you next/)
    expect(text).toMatch(/A question you are asking the user goes in a Text line .*never in FollowUps/)
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

  // F171: "Write your prose first, then one RenderUI call" ended the turn on
  // a complete prose answer; options/designs/choices are now the surface.
  it('makes the surface the answer for options, designs and choices, tool call first', () => {
    const opening = text.split('\n\n')[0]
    expect(opening).toMatch(/When your answer offers options, designs, ideas, a comparison or a choice/)
    expect(opening).toMatch(/the surface IS the answer: call RenderUI first, with at most one sentence of prose before it/)
    expect(opening).toMatch(/Never also write the same options out as prose/)
    expect(text).not.toMatch(/prose first/i)
    expect(text).toMatch(/options or designs → a Grid of Cards, one per option/)
    expect(text).toMatch(/An idea with no picture still gets a card/)
  })

  // Final review: a coding session may be the TUI, which draws no surface, so
  // only a project chat makes the surface the answer; the rest is shared.
  it('keeps a coding session\'s answer in prose, the surface alongside it', () => {
    const opening = session.split('\n\n')[0]
    expect(opening).toMatch(/write your answer in prose and add one surface alongside it, never instead of the text, and never instead of editing the files/)
    expect(session).not.toMatch(/the surface IS the answer/)
    expect(session).not.toMatch(/at most one sentence of prose/)
    expect(session.slice(opening.length)).toBe(text.slice(text.split('\n\n')[0].length))
  })

  it('never shows the call as text the model could copy into its reply', () => {
    expect(text).not.toContain('RenderUI(')
    expect(text).toMatch(/Use the tool call itself — never write the arguments into your reply/)
  })

  it('carries an options example before the plan example, both validating clean', () => {
    const opt = genuiOptionsExampleCall()
    const ro = validateSpec(opt.spec)
    expect(ro.errors).toEqual([])
    expect(ro.count).toBe(10)
    expect(opt.surface).toBe('path-options')
    const iOpt = text.indexOf('{"surface":"path-options","spec":{"root":"card"')
    const iPlan = text.indexOf('{"surface":"plan","spec":{"root":"card"')
    expect(iOpt).toBeGreaterThan(0)
    expect(iPlan).toBeGreaterThan(iOpt)
  })

  it('carries a worked example that validates clean and names the tool', () => {
    expect(text).toContain('{"surface":"plan","spec":{"root":"card"')
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
