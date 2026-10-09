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

function build(): string {
  const groups = GENUI_GROUPS.map(g => {
    const names = Object.keys(GENUI_CATALOG).filter(n => GENUI_CATALOG[n].group === g)
    return `### ${GROUP_TITLES[g] ?? g}\n${names.map(signature).join('\n')}`
  }).join('\n')
  return `<RENDER_UI>
You can draw structured UI in the user's dashboard with the RenderUI tool: tables, plans with steps, charts, key facts, forms and buttons. Use it when structure helps (a comparison, a plan, numbers, a choice the user has to make) — not for ordinary prose, and never instead of editing files. Write your prose first, then one RenderUI call; one surface per answer is usually right.

Call shape: RenderUI({ "surface": "<short-id>", "spec": { "root": "<id>", "elements": { "<id>": { "type": "<Component>", "props": { … }, "children": ["<id>", …] }, … } } })

Rules:
1. "root" names the element drawn first; every other element must be reachable from it through "children" — an element nothing references is dropped.
2. Element ids are short names you choose (letters, digits, - and _). Only components marked [children] take a "children" list of ids; every other component is a leaf.
3. Props hold literal values only — no expressions, templates or bindings. Numbers are numbers (2, not "2"); lists are JSON arrays; option lists may be plain strings.
4. Put "surface" before "spec", and write each parent before its children with the root first, so the surface draws while you stream.
5. Real values only: numbers, file paths, test counts, command output and URLs come from your tool results or the conversation — never invent them. With no real image URL, leave the Image out.
6. A Button click sends its action name, its context and every input value on the surface back to you as the user's next message; a Button inside a Form needs no action of its own, and one with no action sends its label. Give the main Button variant "primary". Input names are unique on a surface.
7. FollowUps go last: 2-4 short questions the user is likely to ask next; a chip click sends its text as the user's next message.
8. Inside Tabs, each child element carries "tab": "<tab value>" next to its "type" (not inside props).
9. Keep it small: a few dozen elements at most, tables under ~50 rows with one cell per column, charts under ~30 points with the unit in yLabel. For long text prefer Markdown; never add a Callout or Text that explains the UI itself.
10. To change a surface you already drew, call RenderUI again with the same "surface" id — it is replaced in place and input values are kept by name.
11. The tool result lists anything it could not draw. Fix those lines and call again; do not resend the same spec.

Example — a plan with a table, a form and follow-ups:
RenderUI(${JSON.stringify(EXAMPLE)})

## Components (prop*: required; "a"|"b": one of)
${groups}
</RENDER_UI>`
}

const SECTION = build()

/** The RENDER_UI prompt section; the same string on every call. */
export function genuiPromptSection(): string {
  return SECTION
}

/** The worked example from the prompt, for tests and the dashboard demo. */
export function genuiExampleCall(): typeof EXAMPLE {
  return JSON.parse(JSON.stringify(EXAMPLE))
}
