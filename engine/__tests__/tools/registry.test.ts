import { describe, expect, it } from 'bun:test'
import type { ToolImpl, ApprovalTier, ToolResult } from '../../tools/types.js'
import { ALL_TOOLS, getToolsByTier, getToolDefinitions } from '../../tools/registry.js'

describe('tool types', () => {
  it('ToolImpl shape is correct', () => {
    const tool: ToolImpl = {
      name: 'TestTool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      tier: 'auto',
      execute: async () => ({ output: 'ok', isError: false }),
    }
    expect(tool.name).toBe('TestTool')
    expect(tool.tier).toBe('auto')
  })
})

describe('tool registry', () => {
  it('exports all 19 tools', () => {
    expect(ALL_TOOLS).toHaveLength(19)
    const names = ALL_TOOLS.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Write')
    expect(names).toContain('Edit')
    expect(names).toContain('Bash')
    expect(names).toContain('Glob')
    expect(names).toContain('Grep')
    expect(names).toContain('Git')
    expect(names).toContain('WebFetch')
    expect(names).toContain('ImageView')
    expect(names).toContain('NotebookEdit')
    expect(names).toContain('MultiEdit')
    expect(names).toContain('ApplyPatch')
    expect(names).toContain('Ls')
    expect(names).toContain('CodeIndex')
    expect(names).toContain('WebSearch')
    expect(names).toContain('SaveLearning')
    expect(names).toContain('IndexResearch')
  })

  it('getToolsByTier returns correct split', () => {
    const auto = getToolsByTier('auto')
    const approval = getToolsByTier('approval')
    expect(auto.every(t => t.tier === 'auto')).toBe(true)
    expect(approval.every(t => t.tier === 'approval')).toBe(true)
    expect(auto.length + approval.length).toBe(19)
  })

  it('getToolDefinitions returns ToolDefinition[] for callModel', () => {
    const defs = getToolDefinitions()
    expect(defs.length).toBe(19)
    for (const def of defs) {
      expect(def).toHaveProperty('name')
      expect(def).toHaveProperty('description')
      expect(def).toHaveProperty('input_schema')
      expect(def.input_schema).toHaveProperty('type', 'object')
    }
  })
})
