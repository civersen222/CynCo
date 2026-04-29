import { describe, test, expect } from 'bun:test'
import { getToolsForTier } from '../trustTier.js'

const READONLY_NAMES = new Set(['Read', 'Glob', 'Grep', 'CodeIndex', 'Ls', 'ImageView', 'Git'])
const WRITE_NAMES = ['Write', 'Edit', 'Bash', 'MultiEdit', 'ApplyPatch']

describe('getToolsForTier — readonly tier', () => {
  test('returns only read-only tools for scout persona', () => {
    const tools = getToolsForTier('readonly', 'scout')
    const names = new Set(tools.map(t => t.name))

    for (const name of READONLY_NAMES) {
      expect(names.has(name)).toBe(true)
    }
  })

  test('does NOT include write/exec tools for scout persona', () => {
    const tools = getToolsForTier('readonly', 'scout')
    const names = tools.map(t => t.name)

    for (const name of WRITE_NAMES) {
      expect(names.includes(name)).toBe(false)
    }
  })

  test('returns exactly the readonly set — no extras', () => {
    const tools = getToolsForTier('readonly', 'scout')
    const names = tools.map(t => t.name)

    expect(names.length).toBe(READONLY_NAMES.size)
    for (const name of names) {
      expect(READONLY_NAMES.has(name)).toBe(true)
    }
  })

  test('readonly tier is identical for scout, kraken, and spark personas', () => {
    const scout = getToolsForTier('readonly', 'scout').map(t => t.name).sort()
    const kraken = getToolsForTier('readonly', 'kraken').map(t => t.name).sort()
    const spark = getToolsForTier('readonly', 'spark').map(t => t.name).sort()

    expect(scout).toEqual(kraken)
    expect(scout).toEqual(spark)
  })

  test('returned objects are real ToolImpl with execute functions', () => {
    const tools = getToolsForTier('readonly', 'scout')

    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(typeof tool.execute).toBe('function')
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })
})
