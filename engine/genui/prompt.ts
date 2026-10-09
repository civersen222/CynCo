/**
 * engine/genui/prompt.ts — the system-prompt section that teaches RenderUI.
 *
 * Built once from the catalog at module load and returned byte-identically
 * after that: the section rides inside the prompt prefix llama.cpp caches, so
 * it must never vary between turns. It is pushed only on turns where RenderUI
 * is among the offered tools (project chats always; a coding session once the
 * model has loaded it), the same condition that already rewrites the tool
 * list. Rules carry the failure modes the upstream prompts encode: unreferenced
 * elements vanish (OpenUI), numbers typed as strings and children omitted
 * (json-render), parents before children so a surface draws while streaming
 * (A2UI).
 */
import { GENUI_CATALOG, GENUI_GROUPS, type PropDef } from './catalog.js'

const GROUP_TITLES: Record<string, string> = {
  Layout: 'Layout (take children)',
  Content: 'Text & content',
  Data: 'Data display',
  Charts: 'Charts',
  Report: 'Coding-agent report',
  Forms: 'Forms (take children: Form only)',
  Actions: 'Actions',
}

function typeOf(def: PropDef): string {
  switch (def.type) {
    case 'enum': return (def.enum ?? []).map(v => `"${v}"`).join('|')
    case 'object[]': return `[{${Object.entries(def.fields ?? {}).map(([k, f]) => `${k}${f.required ? '*' : ''}: ${typeOf(f)}`).join(', ')}}]`
    case 'string[][]': return 'string[][]'
    case 'object': return 'object'
    default: return def.type
  }
}

function signature(name: string): string {
  const def = GENUI_CATALOG[name]
  const props = Object.entries(def.props).map(([k, p]) => `${k}${p.required ? '*' : ''}: ${typeOf(p)}`).join(', ')
  return `- ${name}(${props})${def.children === 'any' ? ' [children]' : ''} — ${def.description}`
}

const EXAMPLE = {
  surface: 'plan',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Weekend build plan' }, children: ['steps', 'costs', 'form', 'next'] },
      steps: { type: 'Steps', props: { items: [{ title: 'Cut the frame', status: 'done' }, { title: 'Resin pour', status: 'active', details: '2 kg, 24 h cure' }] } },
      costs: { type: 'Table', props: { columns: ['Item', 'Qty', 'Cost'], rows: [['Resin', '2 kg', '$60'], ['Pigment', '1', '$12']] } },
      form: { type: 'Form', props: { title: 'Adjust', action: 'recalc' }, children: ['kg', 'go'] },
      kg: { type: 'Slider', props: { name: 'kg', label: 'Resin (kg)', min: 1, max: 5, step: 0.5, value: 2 } },
      go: { type: 'Button', props: { label: 'Recalculate', variant: 'primary' } },
      next: { type: 'FollowUps', props: { items: ['Show the cost by week', 'What if I use walnut?'] } },
    },
  },
}

// Options to choose from: the shape a request like "show me a few designs"
// should get (F171). Its surface id is descriptive on purpose — a model copies
// example ids, and a generic one would make later answers replace this one.
const OPTIONS_EXAMPLE = {
  surface: 'path-options',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Two directions for the garden path' }, children: ['grid', 'ask'] },
      grid: { type: 'Grid', props: { columns: 2 }, children: ['a', 'b'] },
      a: { type: 'Card', props: { title: 'A · Weathered stone', description: 'Quiet and lasting; slow to lay' }, children: ['a-tag', 'a-kv', 'a-go'] },
      'a-tag': { type: 'Badge', props: { text: 'Recommended', variant: 'success' } },
      'a-kv': { type: 'KeyValue', props: { rows: [{ label: 'Mood', value: 'calm' }, { label: 'Effort', value: 'high' }] } },
      'a-go': { type: 'Button', props: { label: 'Choose A', action: 'choose', context: { option: 'A' }, variant: 'primary' } },
      b: { type: 'Card', props: { title: 'B · Painted timber', description: 'Bright and quick; needs repainting' }, children: ['b-kv', 'b-go'] },
      'b-kv': { type: 'KeyValue', props: { rows: [{ label: 'Mood', value: 'playful' }, { label: 'Effort', value: 'low' }] } },
      'b-go': { type: 'Button', props: { label: 'Choose B', action: 'choose', context: { option: 'B' } } },
      ask: { type: 'Text', props: { text: 'Which one feels right for the front yard?' } },
    },
  },
}

function build(): string {
  const groups = GENUI_GROUPS.map(g => {
    const names = Object.keys(GENUI_CATALOG).filter(n => GENUI_CATALOG[n].group === g)
    return `### ${GROUP_TITLES[g] ?? g}\n${names.map(signature).join('\n')}`
  }).join('\n')
  return `<RENDER_UI>
You can draw UI right in this chat with the RenderUI tool: cards, tables, plans with steps, charts, key facts, forms and buttons. When your answer offers options, designs, ideas, a comparison or a choice — or lays out figures or steps the user will act on — the surface IS the answer: call RenderUI first, with at most one sentence of prose before it, and put the details, your recommendation and your question inside the surface. Never also write the same options out as prose. Plain prose is for a short direct answer, a single open question, or a draft the user asked to read. One surface per answer; in code, a surface never replaces editing the files.

Shapes: options or designs → a Grid of Cards, one per option (its name as title, a one-line pitch as description, KeyValue or Tags for its traits, a Button to choose it, a Badge "Recommended" on the one you recommend); a comparison → a Table; steps → Steps; figures → KeyValue, Metric or a chart; a pick from fixed answers → Buttons, or a Radio in a Form. An idea with no picture still gets a card: describe its look in the card's text.

RenderUI takes two arguments: "surface" (a short id) and "spec" ({ "root": "<id>", "elements": { "<id>": { "type": "<Component>", "props": { … }, "children": ["<id>", …] }, … } }). Use the tool call itself — never write the arguments into your reply.

Rules:
1. "root" names the element drawn first; every other element must be reachable from it through "children" — an element nothing references is dropped.
2. Element ids are short names you choose (letters, digits, - and _). Only components marked [children] take a "children" list of ids; every other component is a leaf.
3. Props hold literal values only — no expressions, templates or bindings. Numbers are numbers (2, not "2"); lists are JSON arrays; option lists may be plain strings.
4. Put "surface" before "spec", and write each parent before its children with the root first, so the surface draws while you stream.
5. Facts must be real: numbers, prices, file paths, test counts, command output and URLs come from your tool results or the conversation — never invent them. Ideas you propose (designs, names, options, drafts) are yours to write, and drawing them is the point. With no real image URL, leave the Image out.
6. A Button click sends its action name, its context and every input value on the surface back to you as the user's next message; a Button inside a Form needs no action of its own, and one with no action sends its label. Give the main Button variant "primary". Input names are unique on a surface.
7. FollowUps go last: 2-4 short questions the user is likely to ask you next; a chip click sends its text as the user's next message. A question you are asking the user goes in a Text line (or as Buttons when it has fixed answers), never in FollowUps.
8. Inside Tabs, each child element carries "tab": "<tab value>" next to its "type" (not inside props).
9. Keep it small: a few dozen elements at most, tables under ~50 rows with one cell per column, charts under ~30 points with the unit in yLabel. For long text inside a surface use a Markdown element; never add a Callout or Text that explains the UI itself.
10. To change a surface you already drew, call RenderUI again with the same "surface" id — it is replaced in place and input values are kept by name.
11. The tool result lists anything it could not draw. Fix those lines and call again; do not resend the same spec.

Example arguments — options to choose from (a Card per option; the recommended one carries the Badge and the "primary" Button):
${JSON.stringify(OPTIONS_EXAMPLE)}

Example arguments — a plan with a table, a form and follow-ups:
${JSON.stringify(EXAMPLE)}

## Components (prop*: required; "a"|"b": one of)
${groups}
</RENDER_UI>`
}

const SECTION = build()

/** The RENDER_UI prompt section; the same string on every call. */
export function genuiPromptSection(): string {
  return SECTION
}

/** The options example from the prompt, for tests. */
export function genuiOptionsExampleCall(): typeof OPTIONS_EXAMPLE {
  return JSON.parse(JSON.stringify(OPTIONS_EXAMPLE))
}

/** The worked example from the prompt, for tests and the dashboard demo. */
export function genuiExampleCall(): typeof EXAMPLE {
  return JSON.parse(JSON.stringify(EXAMPLE))
}
