/**
 * engine/genui/catalog.ts — the component vocabulary a model may draw with.
 *
 * This table is the single source for three things: the validator
 * (`spec.ts` coerces props against it), the prompt section the model reads
 * (`prompt.ts` prints one signature per entry), and the dashboard renderer
 * tests (`engine/__tests__/dashboard/genui.test.ts` reads the names and
 * refuses a page that cannot draw one of them). Add a component here and all
 * three follow; a component that exists only in index.html is a drift the
 * tests report.
 *
 * The vocabulary is the parity-driven union of OpenUI's chat library,
 * json-render's shadcn + harness-chat catalogs and A2UI's basic catalog,
 * trimmed to what a chat pane can draw with vanilla DOM and inline SVG
 * (docs: scratchpad design §3; survey evidence in CREDITS.md). Overlays
 * (modals, drawers, popovers), carousels, video/audio and 3D are left out on
 * purpose.
 */

export type PropType =
  | 'string' | 'number' | 'boolean' | 'enum'
  | 'string[]' | 'number[]' | 'string[][]'
  | 'object' | 'object[]'

export type PropDef = {
  type: PropType
  desc: string
  required?: boolean
  /** For `enum`: the allowed values; the first is the default unless `default` says otherwise. */
  enum?: readonly string[]
  default?: unknown
  min?: number
  max?: number
  /** For `object` / `object[]`: the fields of each object. */
  fields?: Record<string, PropDef>
}

export type ComponentGroup = 'Layout' | 'Content' | 'Data' | 'Charts' | 'Report' | 'Forms' | 'Actions'

export type ComponentDef = {
  group: ComponentGroup
  description: string
  /** `any`: child elements render inside; `none`: a leaf (children are reported and ignored). */
  children: 'any' | 'none'
  props: Record<string, PropDef>
  /** Props for the prompt's worked example and the catalog test. */
  example: Record<string, unknown>
}

const str = (desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'string', desc, ...extra })
const num = (desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'number', desc, ...extra })
const bool = (desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'boolean', desc, ...extra })
const en = (values: readonly string[], desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'enum', enum: values, desc, ...extra })
const strs = (desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'string[]', desc, ...extra })
const nums = (desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'number[]', desc, ...extra })
const objs = (fields: Record<string, PropDef>, desc: string, extra: Partial<PropDef> = {}): PropDef => ({ type: 'object[]', fields, desc, ...extra })

/** `{ label, value }` choices; the validator also accepts a plain string list. */
const OPTIONS = objs({ label: str('shown', { required: true }), value: str('sent back', { required: true }) }, 'the choices; a plain string list works too', { required: true })
const SERIES = objs({ name: str('legend label', { required: true }), values: nums('one number per label', { required: true }) }, 'one series per line/bar group', { required: true })

export const GENUI_CATALOG: Record<string, ComponentDef> = {
  // ── Layout ─────────────────────────────────────────────────
  Card: {
    group: 'Layout', children: 'any',
    description: 'Bordered container with an optional title. Use one as the root of most surfaces.',
    props: { title: str('header text'), description: str('subtitle under the title') },
    example: { title: 'Weekend build plan' },
  },
  Stack: {
    group: 'Layout', children: 'any',
    description: 'Flex container; column by default, row for side-by-side children.',
    props: {
      direction: en(['column', 'row'], 'layout axis'),
      gap: en(['md', 'none', 'sm', 'lg'], 'space between children'),
      align: en(['stretch', 'start', 'center', 'end'], 'cross-axis alignment'),
      justify: en(['start', 'center', 'end', 'between'], 'main-axis distribution'),
      wrap: bool('let a row wrap'),
    },
    example: { direction: 'row', gap: 'md' },
  },
  Grid: {
    group: 'Layout', children: 'any',
    description: 'Equal-width columns (collapses to one column on narrow screens).',
    props: { columns: num('1-6', { min: 1, max: 6, default: 2 }), gap: en(['md', 'sm', 'lg'], 'space between cells') },
    example: { columns: 3 },
  },
  Section: {
    group: 'Layout', children: 'any',
    description: 'Titled block; collapsible when asked.',
    props: { title: str('heading', { required: true }), collapsible: bool('show a toggle', { default: false }), open: bool('start expanded', { default: true }) },
    example: { title: 'Details', collapsible: true },
  },
  Tabs: {
    group: 'Layout', children: 'any',
    description: 'Tab strip; each child element sets "tab": "<value>" at element level to say which tab it belongs to.',
    props: {
      tabs: objs({ label: str('tab label', { required: true }), value: str('tab id', { required: true }) }, 'the tabs in order', { required: true }),
      value: str('the tab open at first (default: the first tab)'),
    },
    example: { tabs: [{ label: 'Plan', value: 'plan' }, { label: 'Costs', value: 'costs' }] },
  },
  Separator: {
    group: 'Layout', children: 'none',
    description: 'Horizontal rule.',
    props: {},
    example: {},
  },
  Spacer: {
    group: 'Layout', children: 'none',
    description: 'Vertical breathing room.',
    props: { size: en(['md', 'sm', 'lg'], 'how much') },
    example: { size: 'sm' },
  },

  // ── Content ────────────────────────────────────────────────
  Heading: {
    group: 'Content', children: 'none',
    description: 'Heading text.',
    props: { text: str('the heading', { required: true }), level: num('1 (largest) to 4', { min: 1, max: 4, default: 2 }) },
    example: { text: 'Materials', level: 2 },
  },
  Text: {
    group: 'Content', children: 'none',
    description: 'A paragraph; inline markdown (bold, italics, code, links) is rendered.',
    props: { text: str('the paragraph', { required: true }), variant: en(['body', 'muted', 'caption', 'lead'], 'tone') },
    example: { text: 'Start with the **frame**, then the resin pour.' },
  },
  Markdown: {
    group: 'Content', children: 'none',
    description: 'A full markdown block: headings, lists, tables, code fences.',
    props: { text: str('markdown source', { required: true }) },
    example: { text: '## Notes\n- cure 24 h\n- sand at 400 grit' },
  },
  Code: {
    group: 'Content', children: 'none',
    description: 'Monospace code block with an optional language tag.',
    props: { code: str('the code', { required: true }), language: str('e.g. python, ts, bash'), title: str('file name or caption') },
    example: { code: 'print("ok")', language: 'python', title: 'check.py' },
  },
  Callout: {
    group: 'Content', children: 'none',
    description: 'Highlighted note; use type for tone.',
    props: {
      message: str('the note', { required: true }),
      title: str('short bold lead'),
      type: en(['info', 'success', 'warning', 'error'], 'tone'),
    },
    example: { type: 'warning', title: 'Ventilation', message: 'Pour resin outdoors or with a respirator.' },
  },
  Badge: {
    group: 'Content', children: 'none',
    description: 'Small status pill.',
    props: { text: str('label', { required: true }), variant: en(['default', 'info', 'success', 'warning', 'danger'], 'colour') },
    example: { text: 'in progress', variant: 'info' },
  },
  Tags: {
    group: 'Content', children: 'none',
    description: 'A row of small tags.',
    props: { items: strs('the tags', { required: true }) },
    example: { items: ['oak', 'resin', 'weekend'] },
  },
  Link: {
    group: 'Content', children: 'none',
    description: 'A hyperlink (http/https only).',
    props: { label: str('link text', { required: true }), href: str('https://… address', { required: true }) },
    example: { label: 'Resin safety sheet', href: 'https://example.com/sds.pdf' },
  },
  Image: {
    group: 'Content', children: 'none',
    description: 'An image by URL (http/https); a placeholder shows while it loads or if it fails.',
    props: { src: str('image URL', { required: true }), alt: str('what it shows', { required: true }), caption: str('text under the image') },
    example: { src: 'https://example.com/table.jpg', alt: 'River table', caption: 'Reference piece' },
  },

  // ── Data display ───────────────────────────────────────────
  Table: {
    group: 'Data', children: 'none',
    description: 'Data table: columns are header labels, rows are arrays of cell strings in column order.',
    props: {
      columns: strs('header labels', { required: true }),
      rows: { type: 'string[][]', desc: 'one array of cells per row', required: true },
      caption: str('caption under the table'),
    },
    example: { columns: ['Item', 'Qty', 'Cost'], rows: [['Resin', '2 kg', '$60'], ['Pigment', '1', '$12']] },
  },
  List: {
    group: 'Data', children: 'none',
    description: 'Bulleted, numbered or check list; an item may carry an action that sends a click back.',
    props: {
      items: objs({ title: str('item text', { required: true }), subtitle: str('second line'), action: str('action name sent when clicked') }, 'the items; a plain string list works too', { required: true }),
      variant: en(['bullet', 'number', 'check'], 'marker style'),
    },
    example: { variant: 'number', items: [{ title: 'Cut the frame' }, { title: 'Seal the slab', subtitle: 'two coats' }] },
  },
  KeyValue: {
    group: 'Data', children: 'none',
    description: 'Label/value rows for facts and specs.',
    props: { rows: objs({ label: str('left', { required: true }), value: str('right', { required: true }) }, 'the rows', { required: true }), title: str('heading') },
    example: { rows: [{ label: 'Length', value: '180 cm' }, { label: 'Finish', value: 'matte' }] },
  },
  Metric: {
    group: 'Data', children: 'none',
    description: 'One big number with a label and an optional change indicator.',
    props: {
      label: str('what it measures', { required: true }),
      value: str('the number as text', { required: true }),
      unit: str('unit shown after the value'),
      change: str('e.g. +12%'),
      changeType: en(['neutral', 'positive', 'negative'], 'colour of the change'),
    },
    example: { label: 'Total cost', value: '184', unit: '$', change: '-8%', changeType: 'positive' },
  },
  Progress: {
    group: 'Data', children: 'none',
    description: 'Progress bar, 0-100.',
    props: { value: num('0-100', { required: true, min: 0, max: 100 }), label: str('caption') },
    example: { value: 40, label: 'Frame built' },
  },
  Timeline: {
    group: 'Data', children: 'none',
    description: 'Ordered events down a vertical line.',
    props: { items: objs({ title: str('event', { required: true }), time: str('when'), details: str('one line more') }, 'the events in order', { required: true }) },
    example: { items: [{ title: 'Order resin', time: 'Mon' }, { title: 'First pour', time: 'Sat', details: '5 mm layer' }] },
  },
  Steps: {
    group: 'Data', children: 'none',
    description: 'A plan or checklist with per-step status.',
    props: {
      items: objs({
        title: str('the step', { required: true }),
        details: str('what it involves'),
        status: en(['todo', 'active', 'done', 'failed', 'skipped'], 'state'),
      }, 'the steps in order', { required: true }),
    },
    example: { items: [{ title: 'Cut the frame', status: 'done' }, { title: 'Resin pour', status: 'active', details: '2 kg, 24 h cure' }] },
  },

  // ── Charts (inline SVG) ────────────────────────────────────
  BarChart: {
    group: 'Charts', children: 'none',
    description: 'Vertical bars per label; several series render side by side (stacked on request).',
    props: { labels: strs('x-axis labels', { required: true }), series: SERIES, title: str('chart title'), yLabel: str('y-axis caption'), stacked: bool('stack the series') },
    example: { title: 'Cost by part', labels: ['Frame', 'Resin', 'Finish'], series: [{ name: '$', values: [40, 60, 20] }] },
  },
  LineChart: {
    group: 'Charts', children: 'none',
    description: 'Lines over ordered labels; area fills on request.',
    props: { labels: strs('x-axis labels', { required: true }), series: SERIES, title: str('chart title'), yLabel: str('y-axis caption'), area: bool('fill under the line') },
    example: { title: 'Cure temperature', labels: ['0h', '6h', '12h', '24h'], series: [{ name: '°C', values: [22, 31, 28, 23] }] },
  },
  PieChart: {
    group: 'Charts', children: 'none',
    description: 'Share of a whole; donut on request.',
    props: { labels: strs('slice labels', { required: true }), values: nums('one per label', { required: true }), title: str('chart title'), donut: bool('ring instead of disc') },
    example: { title: 'Budget split', labels: ['Wood', 'Resin', 'Hardware'], values: [55, 35, 10] },
  },
  Sparkline: {
    group: 'Charts', children: 'none',
    description: 'Tiny inline trend line.',
    props: { values: nums('the series', { required: true }), label: str('caption') },
    example: { values: [3, 5, 4, 8, 7], label: 'builds/week' },
  },

  // ── Coding-agent report ────────────────────────────────────
  FileChange: {
    group: 'Report', children: 'none',
    description: 'One changed file and what was done to it.',
    props: {
      path: str('file path', { required: true }),
      kind: en(['modified', 'created', 'deleted', 'renamed'], 'change kind'),
      summary: str('what changed'),
      additions: num('lines added'),
      deletions: num('lines removed'),
    },
    example: { path: 'src/parser.ts', kind: 'modified', summary: 'Handle empty input in tokenize()', additions: 12, deletions: 3 },
  },
  Terminal: {
    group: 'Report', children: 'none',
    description: 'A command that was run and its output.',
    props: { command: str('the command', { required: true }), output: str('what it printed'), exitCode: num('exit status') },
    example: { command: 'npx vitest run', output: '12 passed, 0 failed', exitCode: 0 },
  },
  TestResults: {
    group: 'Report', children: 'none',
    description: 'Test run summary with optional failure details.',
    props: {
      passed: num('count', { required: true }),
      failed: num('count', { required: true }),
      skipped: num('count'),
      runner: str('e.g. pytest, vitest'),
      failures: objs({ name: str('test name', { required: true }), message: str('why it failed') }, 'the failing tests'),
    },
    example: { passed: 41, failed: 1, runner: 'pytest', failures: [{ name: 'test_cure_time', message: 'expected 24, got 20' }] },
  },

  // ── Forms ──────────────────────────────────────────────────
  Form: {
    group: 'Forms', children: 'any',
    description: 'Groups inputs; a Button inside it with no action of its own submits all input values under the form\'s action.',
    props: { title: str('form heading'), description: str('one line of help'), action: str('action name for submits', { default: 'submit' }) },
    example: { title: 'Adjust the plan', action: 'adjust' },
  },
  Input: {
    group: 'Forms', children: 'none',
    description: 'Single-line text (or email/number/date/url) input.',
    props: {
      name: str('key in the submitted values', { required: true }),
      label: str('shown above the field', { required: true }),
      type: en(['text', 'email', 'number', 'password', 'url', 'date'], 'input kind'),
      placeholder: str('hint inside the field'),
      value: str('initial value'),
      required: bool('must be filled before submit'),
    },
    example: { name: 'length', label: 'Table length (cm)', type: 'number', value: '180' },
  },
  Textarea: {
    group: 'Forms', children: 'none',
    description: 'Multi-line text input.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), rows: num('visible lines', { default: 3, min: 1, max: 20 }), placeholder: str('hint'), value: str('initial text') },
    example: { name: 'notes', label: 'Anything else?', rows: 3 },
  },
  Select: {
    group: 'Forms', children: 'none',
    description: 'Drop-down choice.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), options: OPTIONS, value: str('initially selected value'), placeholder: str('shown when nothing is selected') },
    example: { name: 'wood', label: 'Wood', options: [{ label: 'Oak', value: 'oak' }, { label: 'Walnut', value: 'walnut' }], value: 'oak' },
  },
  Radio: {
    group: 'Forms', children: 'none',
    description: 'Pick exactly one.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), options: OPTIONS, value: str('initially selected value'), display: en(['list', 'chips'], 'rows or pill chips') },
    example: { name: 'finish', label: 'Finish', options: ['matte', 'gloss'], value: 'matte', display: 'chips' },
  },
  Checkbox: {
    group: 'Forms', children: 'none',
    description: 'One yes/no box.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), checked: bool('initial state', { default: false }) },
    example: { name: 'delivery', label: 'Include delivery', checked: true },
  },
  CheckboxGroup: {
    group: 'Forms', children: 'none',
    description: 'Pick any number; the value is the list of selected values.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), options: OPTIONS, value: strs('initially selected values'), display: en(['list', 'chips'], 'rows or pill chips') },
    example: { name: 'extras', label: 'Extras', options: ['LED strip', 'Hairpin legs', 'Coasters'], value: ['Hairpin legs'] },
  },
  Switch: {
    group: 'Forms', children: 'none',
    description: 'On/off toggle.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), checked: bool('initial state', { default: false }) },
    example: { name: 'rush', label: 'Rush order' },
  },
  Slider: {
    group: 'Forms', children: 'none',
    description: 'Numeric range with a live value.',
    props: { name: str('key', { required: true }), label: str('label', { required: true }), min: num('lowest', { default: 0 }), max: num('highest', { default: 100 }), step: num('increment', { default: 1 }), value: num('initial value') },
    example: { name: 'kg', label: 'Resin (kg)', min: 1, max: 5, step: 0.5, value: 2 },
  },

  // ── Actions ────────────────────────────────────────────────
  Button: {
    group: 'Actions', children: 'none',
    description: 'A click sends the action name, the button\'s context and the surface\'s input values back to you as the user\'s next message.',
    props: {
      label: str('button text', { required: true }),
      action: str('action name you will receive (optional inside a Form, which supplies its own)'),
      variant: en(['secondary', 'primary', 'danger', 'ghost'], 'style'),
      context: { type: 'object', desc: 'extra data sent back with the click' },
      disabled: bool('greyed out'),
    },
    example: { label: 'Recalculate', action: 'recalc', variant: 'primary' },
  },
  ButtonRow: {
    group: 'Actions', children: 'any',
    description: 'Buttons side by side.',
    props: { align: en(['start', 'end', 'center'], 'horizontal alignment') },
    example: { align: 'end' },
  },
  FollowUps: {
    group: 'Actions', children: 'none',
    description: 'Suggested next questions as chips; a click sends the text as the user\'s next message. Put one at the end of a surface.',
    props: { items: strs('2-4 short questions', { required: true }) },
    example: { items: ['Show the cost by week', 'What if I use walnut?'] },
  },
}

export const GENUI_COMPONENT_NAMES: readonly string[] = Object.keys(GENUI_CATALOG)

/** Every group, in the order the prompt prints them. */
export const GENUI_GROUPS: readonly ComponentGroup[] = ['Layout', 'Content', 'Data', 'Charts', 'Report', 'Forms', 'Actions']

export function isComponentName(name: unknown): name is string {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(GENUI_CATALOG, name)
}

/** Case-insensitive lookup: a model that writes "table" or "BARCHART" still means the component. */
export function resolveComponentName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  if (isComponentName(name)) return name
  const lower = name.trim().toLowerCase()
  for (const n of GENUI_COMPONENT_NAMES) if (n.toLowerCase() === lower) return n
  return null
}
