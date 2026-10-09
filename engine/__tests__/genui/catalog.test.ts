/**
 * The catalog is data three things read — the validator, the prompt, the
 * dashboard tests — so its own shape is pinned here: every entry describes
 * itself, carries an example that validates clean, and names are unique and
 * resolvable case-insensitively.
 */
import { describe, expect, it } from 'vitest'
import { GENUI_CATALOG, GENUI_COMPONENT_NAMES, GENUI_GROUPS, isComponentName, resolveComponentName } from '../../genui/catalog.js'
import { validateSpec, isContainer } from '../../genui/spec.js'

describe('genui catalog', () => {
  it('has the parity set: 42 components across the seven groups', () => {
    expect(GENUI_COMPONENT_NAMES).toHaveLength(42)
    for (const g of GENUI_GROUPS) {
      expect(GENUI_COMPONENT_NAMES.some(n => GENUI_CATALOG[n].group === g), `group ${g} is empty`).toBe(true)
    }
    const expected = [
      'Card', 'Stack', 'Grid', 'Section', 'Tabs', 'Separator', 'Spacer',
      'Heading', 'Text', 'Markdown', 'Code', 'Callout', 'Badge', 'Tags', 'Link', 'Image',
      'Table', 'List', 'KeyValue', 'Metric', 'Progress', 'Timeline', 'Steps',
      'BarChart', 'LineChart', 'PieChart', 'Sparkline',
      'FileChange', 'Terminal', 'TestResults',
      'Form', 'Input', 'Textarea', 'Select', 'Radio', 'Checkbox', 'CheckboxGroup', 'Switch', 'Slider',
      'Button', 'ButtonRow', 'FollowUps',
    ]
    expect([...GENUI_COMPONENT_NAMES].sort()).toEqual([...expected].sort())
  })

  it('every component has a description, a children policy, typed props and an example', () => {
    for (const [name, def] of Object.entries(GENUI_CATALOG)) {
      expect(def.description.length, name).toBeGreaterThan(10)
      expect(['any', 'none']).toContain(def.children)
      expect(def.group).toBeDefined()
      for (const [prop, pd] of Object.entries(def.props)) {
        expect(pd.desc.length, `${name}.${prop}`).toBeGreaterThan(0)
        if (pd.type === 'enum') expect(pd.enum?.length, `${name}.${prop} enum`).toBeGreaterThan(0)
        if (pd.type === 'object[]') expect(Object.keys(pd.fields ?? {}).length, `${name}.${prop} fields`).toBeGreaterThan(0)
      }
      expect(typeof def.example).toBe('object')
    }
  })

  it('every example validates clean as a one-element spec', () => {
    for (const [name, def] of Object.entries(GENUI_CATALOG)) {
      const r = validateSpec({ root: 'x', elements: { x: { type: name, props: def.example } } })
      expect(r.errors, name).toEqual([])
      expect(r.count, name).toBe(1)
      expect(r.spec?.elements.x.type).toBe(name)
    }
  })

  it('containers are exactly the components that take children', () => {
    const containers = GENUI_COMPONENT_NAMES.filter(n => GENUI_CATALOG[n].children === 'any')
    expect([...containers].sort()).toEqual(['ButtonRow', 'Card', 'Form', 'Grid', 'Section', 'Stack', 'Tabs'])
    for (const n of GENUI_COMPONENT_NAMES) expect(isContainer(n)).toBe(GENUI_CATALOG[n].children === 'any')
  })

  it('resolves names case-insensitively and refuses the rest', () => {
    expect(isComponentName('Table')).toBe(true)
    expect(isComponentName('table')).toBe(false)
    expect(resolveComponentName('table')).toBe('Table')
    expect(resolveComponentName(' BARCHART ')).toBe('BarChart')
    expect(resolveComponentName('Modal')).toBeNull()
    expect(resolveComponentName(42)).toBeNull()
    expect(resolveComponentName('__proto__')).toBeNull()
    expect(resolveComponentName('constructor')).toBeNull()
  })
})
