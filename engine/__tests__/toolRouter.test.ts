import { describe, it, expect } from 'bun:test'
import {
  TOOL_CATEGORIES,
  CATEGORY_SELECTOR_TOOL,
  getToolsForCategory,
  shouldUseRouting,
} from '../tools/toolRouter.js'
import type { ToolImpl } from '../tools/types.js'

function makeToolImpl(name: string): ToolImpl {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    tier: 'auto',
    execute: async () => ({ output: '', isError: false }),
  }
}

const ALL_TOOLS: ToolImpl[] = [
  'Read', 'Glob', 'Grep', 'Ls', 'CodeIndex',
  'Edit', 'Write', 'MultiEdit', 'ApplyPatch',
  'WebSearch', 'WebFetch', 'IndexResearch',
  'Bash', 'Git',
  'SpawnAgent', 'CollectAgent',
].map(makeToolImpl)

describe('TOOL_CATEGORIES', () => {
  it('has 6 categories', () => {
    expect(Object.keys(TOOL_CATEGORIES)).toHaveLength(6)
  })

  it('has all expected category names', () => {
    const keys = Object.keys(TOOL_CATEGORIES)
    expect(keys).toContain('read')
    expect(keys).toContain('write')
    expect(keys).toContain('search')
    expect(keys).toContain('execute')
    expect(keys).toContain('agent')
    expect(keys).toContain('all')
  })

  it('read category contains Read, Glob, and Grep', () => {
    expect(TOOL_CATEGORIES.read).toContain('Read')
    expect(TOOL_CATEGORIES.read).toContain('Glob')
    expect(TOOL_CATEGORIES.read).toContain('Grep')
  })

  it('write category contains Edit and Write', () => {
    expect(TOOL_CATEGORIES.write).toContain('Edit')
    expect(TOOL_CATEGORIES.write).toContain('Write')
  })
})

describe('CATEGORY_SELECTOR_TOOL', () => {
  it('has correct name', () => {
    expect(CATEGORY_SELECTOR_TOOL.name).toBe('select_category')
  })

  it('enum includes all category keys', () => {
    const enumValues = CATEGORY_SELECTOR_TOOL.input_schema.properties.category.enum as string[]
    for (const key of Object.keys(TOOL_CATEGORIES)) {
      expect(enumValues).toContain(key)
    }
  })

  it('requires category field', () => {
    expect(CATEGORY_SELECTOR_TOOL.input_schema.required).toContain('category')
  })
})

describe('getToolsForCategory', () => {
  it('filters to read tools correctly', () => {
    const result = getToolsForCategory('read', ALL_TOOLS)
    const names = result.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Glob')
    expect(names).toContain('Grep')
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('Edit')
  })

  it('filters to write tools correctly', () => {
    const result = getToolsForCategory('write', ALL_TOOLS)
    const names = result.map(t => t.name)
    expect(names).toContain('Edit')
    expect(names).toContain('Write')
    expect(names).not.toContain('Read')
    expect(names).not.toContain('Bash')
  })

  it('filters to execute tools correctly', () => {
    const result = getToolsForCategory('execute', ALL_TOOLS)
    const names = result.map(t => t.name)
    expect(names).toContain('Bash')
    expect(names).toContain('Git')
    expect(names).not.toContain('Read')
  })

  it("'all' category returns all tools", () => {
    const result = getToolsForCategory('all', ALL_TOOLS)
    expect(result).toHaveLength(ALL_TOOLS.length)
    expect(result).toEqual(ALL_TOOLS)
  })

  it('unknown category falls back to all tools', () => {
    const result = getToolsForCategory('unknown_category', ALL_TOOLS)
    expect(result).toHaveLength(ALL_TOOLS.length)
  })
})

describe('shouldUseRouting', () => {
  it('returns true for context length below 32768', () => {
    expect(shouldUseRouting(8192)).toBe(true)
    expect(shouldUseRouting(16384)).toBe(true)
    expect(shouldUseRouting(32767)).toBe(true)
  })

  it('returns false for context length at 32768', () => {
    expect(shouldUseRouting(32768)).toBe(false)
  })

  it('returns false for context length above 32768', () => {
    expect(shouldUseRouting(65536)).toBe(false)
    expect(shouldUseRouting(131072)).toBe(false)
  })
})
