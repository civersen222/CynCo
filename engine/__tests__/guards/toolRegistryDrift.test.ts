import { describe, it, expect } from 'bun:test'
import { ALL_TOOLS, getCoreTools, getExtendedTools } from '../../tools/registry.js'
import { ALL_TOOL_NAMES } from '../../s5/ruleBasedS5.js'

describe('tool registry drift guard', () => {
  it('ALL_TOOL_NAMES equals the registry (never hand-maintained)', () => {
    expect([...ALL_TOOL_NAMES].sort()).toEqual(ALL_TOOLS.map(t => t.name).sort())
  })

  it('every tool declares an explicit core boolean', () => {
    const missing = ALL_TOOLS.filter(t => typeof (t as { core?: unknown }).core !== 'boolean').map(t => t.name)
    expect(missing, `tools missing core: ${missing.join(', ')}`).toEqual([])
  })

  it('core ∪ extended partitions the registry with no overlap', () => {
    const core = getCoreTools().map(t => t.name)
    const ext = getExtendedTools().map(t => t.name)
    expect([...core, ...ext].sort()).toEqual(ALL_TOOLS.map(t => t.name).sort())
    expect(core.filter(n => ext.includes(n))).toEqual([])
  })
})
