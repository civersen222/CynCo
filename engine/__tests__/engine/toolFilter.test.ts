import { describe, expect, it } from 'bun:test'
import { filterTools } from '../../engine/toolFilter.js'
import type { ToolScoping } from '../../profiles/types.js'

// ─── Test Helpers ───────────────────────────────────────────────

/** Minimal tool-like object with a name field. */
function makeTool(name: string) {
  return { name, description: `${name} tool`, extra: true }
}

const ALL_TOOLS = [
  makeTool('Read'),
  makeTool('Write'),
  makeTool('Bash'),
  makeTool('Glob'),
  makeTool('Grep'),
  makeTool('Edit'),
]

// ─── Tests ──────────────────────────────────────────────────────

describe('filterTools', () => {
  it('returns all tools when no scoping provided (undefined)', () => {
    const result = filterTools(ALL_TOOLS, undefined)
    expect(result).toHaveLength(ALL_TOOLS.length)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Bash', 'Glob', 'Grep', 'Edit'])
  })

  it('returns all tools when scoping is empty object', () => {
    const result = filterTools(ALL_TOOLS, {})
    expect(result).toHaveLength(ALL_TOOLS.length)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Bash', 'Glob', 'Grep', 'Edit'])
  })

  it('filters to only allowed tools when allowed list provided', () => {
    const scoping: ToolScoping = { allowed: ['Read', 'Write'] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(2)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write'])
  })

  it('removes denied tools when denied list provided', () => {
    const scoping: ToolScoping = { denied: ['Bash', 'Write'] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(4)
    expect(result.map(t => t.name)).toEqual(['Read', 'Glob', 'Grep', 'Edit'])
  })

  it('applies allowed first, then denied removes from the allowed set', () => {
    const scoping: ToolScoping = {
      allowed: ['Read', 'Write', 'Bash'],
      denied: ['Bash'],
    }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(2)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write'])
  })

  it('ignores unknown tool names in allowed list (no error)', () => {
    const scoping: ToolScoping = { allowed: ['Read', 'NonExistentTool'] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Read')
  })

  it('ignores unknown tool names in denied list (no error)', () => {
    const scoping: ToolScoping = { denied: ['NonExistentTool'] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(ALL_TOOLS.length)
  })

  it('returns empty array when allowed list is empty', () => {
    const scoping: ToolScoping = { allowed: [] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result).toHaveLength(0)
  })

  it('performs case-sensitive matching (Read !== read)', () => {
    const scoping: ToolScoping = { allowed: ['read', 'write'] }
    const result = filterTools(ALL_TOOLS, scoping)
    // None of our tools match lowercase names
    expect(result).toHaveLength(0)
  })

  it('does not mutate the original tools array', () => {
    const tools = [...ALL_TOOLS]
    const originalLength = tools.length
    filterTools(tools, { allowed: ['Read'] })
    expect(tools).toHaveLength(originalLength)
  })

  it('returns a new array (not the same reference)', () => {
    const result = filterTools(ALL_TOOLS, undefined)
    expect(result).not.toBe(ALL_TOOLS)
  })

  it('preserves extra properties on tool objects', () => {
    const scoping: ToolScoping = { allowed: ['Read'] }
    const result = filterTools(ALL_TOOLS, scoping)
    expect(result[0]).toEqual({ name: 'Read', description: 'Read tool', extra: true })
  })

  it('works with readonly input array', () => {
    const readonlyTools: readonly { name: string }[] = Object.freeze([
      { name: 'Read' },
      { name: 'Write' },
    ])
    const result = filterTools(readonlyTools, { denied: ['Write'] })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Read')
  })
})
