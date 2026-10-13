/**
 * The RENDER_UI section rides inside the cached prompt prefix: it must name
 * every catalog component exactly once, stay under its budget (13k chars,
 * ~3.3k tokens — raised from 10k for the options example, F171, and from
 * 12k for the takes/seed/fence sentences of the 2026-10-12 live run: the
 * prefix cache makes the size cost nil, and the bound exists only to catch
 * accidental bloat; the picture wording of F174 fits under it, and the
 * session section, which asks for no picture, stays under 12k), and be
 * byte-identical on every call.
 */
import { describe, expect, it } from 'vitest'
import { genuiPromptSection, genuiExampleCall, genuiOptionsExampleCall } from '../../genui/prompt.js'
import { GENUI_COMPONENT_NAMES, GENUI_CATALOG } from '../../genui/catalog.js'
import { validateSpec } from '../../genui/spec.js'

describe('genui prompt section', () => {
  const text = genuiPromptSection('project')
  const session = genuiPromptSection('session')
  const SHAPES_PICTURE = 'Each design gets a picture: an Image with a "prompt" in its card — a detailed description (subject, shape, materials, colours, pose, lighting), as long as the design needs (whole paragraphs are fine). For a physical thing that may be modelled or 3D-printed: one subject, whole, centred, front three-quarter view, plain light-grey background, no text. Several takes of one design are several Images with the same prompt and different "seed"s (change the prompt for a camera or lighting variation). Pictures are painted by the engine from these prompts — never call an image server, write a ComfyUI workflow, or save renders yourself.'
  /** The options example as the session section prints it. */
  const sessionOptionsExample = () => {
    const at = session.indexOf('{"surface":"path-options"')
    return JSON.parse(session.slice(at, session.indexOf('\n', at))) as ReturnType<typeof genuiOptionsExampleCall>
  }

  it('is byte-stable and bounded in both modes', () => {
    expect(genuiPromptSection('project')).toBe(text)
    expect(genuiPromptSection('session')).toBe(session)
    expect(session.length).toBeLessThan(12_000)
    expect(text.length).toBeLessThan(13_000)
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
    // a seed is a number that comes from no tool result: rule 5 names it among the model's own (review of the 2026-10-12 run)
    expect(text).toContain('Ideas you propose (designs, names, options — and the whole-number "seed" of a picture\'s take) are yours to write, and drawing them is the point.')
    expect(session).toContain('Ideas you propose (designs, names, options) are yours to write, and drawing them is the point.')
    // a draft the user asked to read stays prose (final review: rule 5 used to list drafts)
    expect(text).toMatch(/Plain prose is for a short direct answer, a single open question, or a draft the user asked to read/)
    expect(text).toMatch(/Never invent an image URL: describe the picture in the Image's "prompt"/)
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
    // F174: a note is already on the user's screen and pictures arrive by themselves
    expect(text).toMatch(/The tool result's notes are already shown to the user/)
    expect(text).toMatch(/never to tidy a note or wait for pictures/)
  })

  // F174: every Image showed "image unavailable" — the only rule-abiding Image
  // was an empty one. A design now gets a picture the engine paints, framed so
  // a later image → 3D step can use it.
  it('gives each design a prompted picture, framed for a later 3D model, and never names the server\'s setup', () => {
    expect(text).toMatch(/- Image\(prompt: string, seed: int, src: string, alt\*: string, caption: string\) — A picture: "prompt" describes it and the engine paints it \(the same prompt with another whole-number "seed" is another take; leave seed out for one picture\); "src" is a real http\(s\) image URL or the project-relative path of a png\/jpg\/gif\/webp\/svg file you wrote\. Give one, not both\./)
    // a file the model wrote into the project (an SVG template, a sketch) is shown by its path: the one sentence, in both modes
    expect(session).toMatch(/the project-relative path of a png\/jpg\/gif\/webp\/svg file you wrote/)
    expect(text).not.toMatch(/An idea with no picture/)
    expect(text).not.toMatch(/leave the Image out/)
    // whether ComfyUI is set up, where it is and whether it answers reach the
    // model through the tool result only: the prefix never varies. The one
    // static mention is the fence ("never … write a ComfyUI workflow").
    expect(text).not.toMatch(/LOCALCODE_COMFYUI|:8188|https?:\/\/|\/prompt\b|\/history\b/)
    expect(text.match(/ComfyUI/g)).toEqual(['ComfyUI'])
    expect(session).not.toMatch(/ComfyUI|LOCALCODE_COMFYUI/)
  })

  // The operator's live run (2026-10-12/13): told nothing about takes, the
  // model planned six KSamplers per design in a workflow JSON of its own and
  // drove ComfyUI through Bash; told nothing about length, it kept its
  // paragraph prompts in files. The Shapes sentence now says how takes are
  // asked for, that a prompt may be as long as the design needs, and that
  // the engine paints — never the chat.
  it('says that takes are Images with one prompt and different seeds, prompts may be paragraphs, and the chat never paints', () => {
    expect(text).toContain('Several takes of one design are several Images with the same prompt and different "seed"s (change the prompt for a camera or lighting variation).')
    expect(text).toContain('as long as the design needs (whole paragraphs are fine)')
    expect(text).toContain('Pictures are painted by the engine from these prompts — never call an image server, write a ComfyUI workflow, or save renders yourself.')
    for (const s of ['Several takes', 'whole paragraphs', 'never call an image server']) expect(session).not.toContain(s)
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
    expect(text).toMatch(/Each design gets a picture: an Image with a "prompt" in its card/)
    expect(text).toMatch(/one subject, whole, centred, front three-quarter view, plain light-grey background, no text/)
    expect(text).toContain(SHAPES_PICTURE)
  })

  // Final review: a coding session may be the TUI, which draws no surface, so
  // only a project chat makes the surface the answer. Past the opening, the
  // modes differ only in the picture wording (below); everything else is shared.
  it('keeps a coding session\'s answer in prose, the surface alongside it', () => {
    const opening = session.split('\n\n')[0]
    expect(opening).toMatch(/write your answer in prose and add one surface alongside it, never instead of the text, and never instead of editing the files/)
    expect(session).not.toMatch(/the surface IS the answer/)
    expect(session).not.toMatch(/at most one sentence of prose/)
    const projectBody = text.slice(text.split('\n\n')[0].length)
    const asSession = projectBody
      .replace(SHAPES_PICTURE, 'An idea with no picture still gets a card: describe its look in the card\'s text.')
      .replace('Never invent an image URL: describe the picture in the Image\'s "prompt".', 'With no real image URL, leave the Image out.')
      .replace('never to tidy a note or wait for pictures — they fill in by themselves;', 'never to tidy a note;')
      .replace('(designs, names, options — and the whole-number "seed" of a picture\'s take)', '(designs, names, options)')
      .replace(JSON.stringify(genuiOptionsExampleCall()), JSON.stringify(sessionOptionsExample()))
    expect(asSession).not.toBe(projectBody)
    expect(session.slice(opening.length)).toBe(asSession)
  })

  // Completeness review of F174: pictures are painted in project chats only. A
  // shared Shapes line, rule and example that gave each design a prompted
  // picture contradicted the session opening's "leave them out", and a coding
  // session that followed them drew a "not generated" box in every card on
  // every call — the F174 symptom. Nothing in a session's section asks for one.
  // Review: the shared catalog line offers a file path in "src" too, and the
  // engine turns every such Image off in a coding session ("files are shown in
  // project chats only"), so the opening must say so for files as well as for
  // prompted pictures — the F174 shape otherwise.
  it('never asks a coding session for a prompted picture or a file, and says why in its opening', () => {
    expect(session.split('\n\n')[0]).toMatch(/Pictures \(an Image "prompt"\) and files \(an Image "src" path\) are shown in project chats only; leave them out here\./)
    expect(text).not.toMatch(/in project chats only/)
    expect(session).toMatch(/"src" is a real http\(s\) image URL or the project-relative path of a png\/jpg\/gif\/webp\/svg file you wrote/)
    expect(session).not.toMatch(/Each design gets a picture/)
    expect(session).not.toMatch(/describe the picture in the Image's "prompt"/)
    expect(session).not.toMatch(/wait for pictures/)
    expect(session).toMatch(/An idea with no picture still gets a card: describe its look in the card's text\./)
    expect(session).toMatch(/With no real image URL, leave the Image out\./)
    // its options example is the project's without the Images, and still validates clean
    const ex = sessionOptionsExample()
    expect(JSON.stringify(ex)).not.toMatch(/"type":"Image"|"prompt"/)
    const r = validateSpec(ex.spec)
    expect(r.errors).toEqual([])
    expect(r.count).toBe(10)
    expect(r.spec?.elements.a.children).toEqual(['a-tag', 'a-kv', 'a-go'])
    expect(r.spec?.elements.b.children).toEqual(['b-kv', 'b-go'])
  })

  it('never shows the call as text the model could copy into its reply', () => {
    expect(text).not.toContain('RenderUI(')
    expect(text).toMatch(/Use the tool call itself — never write the arguments into your reply/)
  })

  it('carries an options example before the plan example, both validating clean', () => {
    const opt = genuiOptionsExampleCall()
    const ro = validateSpec(opt.spec)
    expect(ro.errors).toEqual([])
    expect(ro.count).toBe(12)
    expect(opt.surface).toBe('path-options')
    // each option card carries a prompted picture, drawn first in the card
    expect(ro.spec?.elements.a.children?.[0]).toBe('a-img')
    expect(ro.spec?.elements.b.children?.[0]).toBe('b-img')
    expect(ro.spec?.elements['a-img'].props).toEqual({ prompt: 'curving path of weathered grey flagstones through low ferns, morning light, photo', alt: 'Stone path' })
    expect(ro.spec?.elements['b-img'].props?.prompt).toMatch(/turquoise timber boards/)
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
